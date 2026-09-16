/**
 * Fastify application assembly.
 *
 * Split from `index.ts` so tests can build an app, drive it with `inject()` and
 * tear it down without binding a port or starting the simulator.
 */

import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadFeedFrom, type TransitFeed } from '@citybus/shared';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from './config.ts';
import { AppContext } from './context.ts';
import { HistoryWriter } from './db/history.ts';
import { migrate } from './db/migrate.ts';
import { createLiveStore } from './live/live-store.ts';
import { PositionResolver } from './live/resolver.ts';
import { registerGtfsRoutes } from './routes/gtfs.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerIngestRoutes } from './routes/ingest.ts';
import { registerRealtimeRoutes } from './routes/realtime.ts';
import { RealtimeHub } from './ws/hub.ts';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  feed: TransitFeed;
  shutdown: () => Promise<void>;
}

export async function buildApp(): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport: config.env === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
    },
    // Reports carry up to 500 positions; anything larger is not a bus.
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  // The feed is read from disk once at boot: it is the same data for every
  // request and parsing 6,600 stop_times per call would be absurd.
  const feed = await loadFeedFrom((file) => readFile(join(config.gtfsDir, file), 'utf8'));
  app.log.info(
    `[feed] loaded ${feed.routes.size} routes, ${feed.stops.size} stops, ${feed.trips.size} trips`,
  );

  // Migrations run before anything touches a table. Doing this in the entry
  // point instead left a window where the app queried `stops` before it existed.
  // A no-op when DATABASE_URL is unset.
  await migrate((msg) => app.log.info(msg));

  const liveStore = await createLiveStore(app.log);
  const history = new HistoryWriter(app.log);
  history.start();

  const hub = new RealtimeHub();
  const ctx = new AppContext(feed, liveStore, history, new PositionResolver(feed), hub);

  // Mirror stops into PostGIS so "stops near me" is a spatial index lookup rather
  // than a linear scan of the feed in application memory.
  if (history.enabled) {
    await history.syncStops([...feed.stops.values()].map((s) => ({
      id: s.stop_id, name: s.stop_name, lat: s.stop_lat, lng: s.stop_lon,
    })));
    app.log.info(`[db] synced ${feed.stops.size} stops to PostGIS`);
  }

  await app.register(cors, { origin: true });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  await registerHealthRoutes(app, ctx);
  await registerGtfsRoutes(app);
  await registerIngestRoutes(app, ctx);
  await registerRealtimeRoutes(app, ctx);

  app.get('/ws', { websocket: true }, (socket) => {
    hub.add(socket);
    // Send current state immediately so a new client is not staring at an empty
    // map until the next broadcast tick.
    try {
      socket.send(JSON.stringify({ type: 'snapshot', snapshot: ctx.currentSnapshot() }));
    } catch { /* socket already closed */ }
  });

  const broadcastTimer = ctx.startBroadcasting();

  const shutdown = async (): Promise<void> => {
    clearInterval(broadcastTimer);
    hub.closeAll();
    await history.stop();
    await liveStore.close();
    await app.close();
  };

  return { app, ctx, feed, shutdown };
}
