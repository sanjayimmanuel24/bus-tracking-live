/**
 * Health and readiness.
 *
 * `/health` answers "is this process alive" and must stay cheap: a load balancer
 * hits it constantly, and a health check that queries the database turns a slow
 * database into an outage. `/ready` is the one that reports dependencies.
 */

import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.ts';

export async function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', uptimeSec: Math.round(process.uptime()) }));

  app.get('/ready', async () => {
    const vehicles = await ctx.liveStore.size();
    return {
      status: 'ok',
      liveStore: ctx.liveStore.backend,
      historyEnabled: ctx.history.enabled,
      history: ctx.history.stats,
      vehiclesTracked: vehicles,
      websocketClients: ctx.hub.clientCount,
      feed: {
        routes: ctx.feed.routes.size,
        stops: ctx.feed.stops.size,
        trips: ctx.feed.trips.size,
      },
      lastIngestAgeSec: ctx.lastIngestAgeSec(),
    };
  });
}
