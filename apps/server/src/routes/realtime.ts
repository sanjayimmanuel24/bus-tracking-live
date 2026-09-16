/**
 * Read APIs over live and historical state.
 *
 * The WebSocket is the primary realtime channel; these exist for clients that
 * cannot hold a socket open, for debugging, and for the analytics questions a
 * live feed cannot answer at all.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.ts';

export async function registerRealtimeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /** Current GTFS-Realtime feed message, as JSON. */
  app.get('/api/realtime', async () => ctx.currentSnapshot());

  /** Live vehicles, optionally filtered by route. */
  app.get('/api/vehicles', async (request) => {
    const Query = z.object({ route: z.string().max(64).optional() });
    const { route } = Query.parse(request.query ?? {});
    const positions = await ctx.liveStore.all();
    const filtered = route ? positions.filter((p) => p.routeId === route) : positions;
    return { count: filtered.length, vehicles: filtered };
  });

  /**
   * Departure board for a stop: the next buses due, across every route serving it.
   * This is the rider-facing question the Phase 1 client could not answer, because
   * it could only look at one bus at a time.
   */
  app.get('/api/stops/:stopId/departures', async (request, reply) => {
    const Params = z.object({ stopId: z.string().min(1).max(64) });
    const Query = z.object({ limit: z.coerce.number().int().min(1).max(20).default(8) });

    const params = Params.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_stop_id' });
    const { limit } = Query.parse(request.query ?? {});

    const stop = ctx.feed.stops.get(params.data.stopId);
    if (!stop) return reply.code(404).send({ error: 'unknown_stop' });

    const departures = await ctx.departuresForStop(params.data.stopId, limit);
    return {
      stop: { id: stop.stop_id, name: stop.stop_name, lat: stop.stop_lat, lng: stop.stop_lon },
      departures,
    };
  });

  /** Stops near a point. A PostGIS query; returns empty when history is disabled. */
  app.get('/api/stops/near', async (request, reply) => {
    const Query = z.object({
      lat: z.coerce.number().min(-90).max(90),
      lng: z.coerce.number().min(-180).max(180),
      radius: z.coerce.number().min(10).max(5000).default(600),
    });
    const parsed = Query.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

    const { lat, lng, radius } = parsed.data;
    return { stops: await ctx.history.stopsNear(lat, lng, radius) };
  });

  /** Observed on-time performance by route — answerable only from history. */
  app.get('/api/analytics/on-time', async (request) => {
    const Query = z.object({ minutes: z.coerce.number().int().min(1).max(1440).default(60) });
    const { minutes } = Query.parse(request.query ?? {});
    return {
      windowMinutes: minutes,
      historyEnabled: ctx.history.enabled,
      routes: await ctx.history.onTimePerformance(minutes),
    };
  });

  /** Replay one vehicle's track. The basis for historical playback in a later phase. */
  app.get('/api/vehicles/:vehicleId/track', async (request, reply) => {
    const Params = z.object({ vehicleId: z.string().min(1).max(64) });
    const Query = z.object({
      from: z.coerce.number().int().positive().optional(),
      to: z.coerce.number().int().positive().optional(),
    });

    const params = Params.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_vehicle_id' });

    const { from, to } = Query.parse(request.query ?? {});
    const nowSec = Math.floor(Date.now() / 1000);
    const points = await ctx.history.track(
      params.data.vehicleId,
      from ?? nowSec - 3600,
      to ?? nowSec,
    );
    return { vehicleId: params.data.vehicleId, points };
  });
}
