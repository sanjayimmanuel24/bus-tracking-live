/**
 * POST /api/ingest — vehicle position reports.
 *
 * This is the endpoint a driver's phone posts to. The built-in simulator posts to
 * exactly the same route with the same authentication, so nothing downstream can
 * tell a simulated bus from a real one -- which is the point, and also the thing
 * that makes swapping in real vehicles a deployment change rather than a rewrite.
 *
 * Reports are validated, resolved against the timetable, written to the live
 * store and queued for history. Rejecting a bad report must never reject the
 * whole batch: one phone with a broken clock should not cost you the fleet.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { config } from '../config.ts';
import type { AppContext } from '../context.ts';

const Report = z.object({
  vehicleId: z.string().min(1).max(64),
  label: z.string().max(32).optional(),
  tripId: z.string().min(1).max(64),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  bearing: z.number().min(0).max(360).default(0),
  speedMps: z.number().min(0).max(60).default(0),
  occupancy: z.number().int().min(0).max(500).optional(),
  capacity: z.number().int().min(1).max(500).optional(),
  timestamp: z.number().int().positive(),
});

const IngestBody = z.object({
  reports: z.array(Report).min(1).max(500),
  /**
   * Seconds after midnight for the service day these reports belong to. Sent
   * explicitly because the simulator runs on an accelerated clock; a real vehicle
   * would omit it and the server would use wall-clock time.
   */
  serviceSec: z.number().min(0).max(172800).optional(),
});

export async function registerIngestRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/ingest', async (request, reply) => {
    // Constant-time-ish check is overkill for a shared bearer token, but the
    // token must never appear in a log line or an error body.
    const header = request.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (presented !== config.ingestToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = IngestBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        // Field paths only -- echoing values back can reflect injected content.
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const { reports, serviceSec } = parsed.data;
    const effectiveServiceSec = serviceSec ?? secondsSinceMidnight();

    let accepted = 0;
    const rejected: { vehicleId: string; reason: string }[] = [];

    for (const report of reports) {
      const resolved = ctx.resolver.resolve(report, effectiveServiceSec);
      if (!resolved) {
        rejected.push({ vehicleId: report.vehicleId, reason: 'unknown_trip' });
        continue;
      }

      await ctx.liveStore.put(resolved);
      ctx.history.record(resolved);
      ctx.recordArrivalIfReached(resolved);
      accepted += 1;
    }

    ctx.markIngest(effectiveServiceSec);

    return reply.send({ accepted, rejected: rejected.length, details: rejected.slice(0, 10) });
  });

  /** Registry upsert, sent once per vehicle at startup rather than every report. */
  app.post('/api/vehicles/register', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || header.slice(7) !== config.ingestToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const Body = z.object({
      vehicles: z.array(z.object({
        vehicleId: z.string().min(1).max(64),
        registration: z.string().min(1).max(32),
        capacity: z.number().int().min(1).max(500),
      })).min(1).max(1000),
    });

    const parsed = Body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    for (const v of parsed.data.vehicles) {
      await ctx.history.registerVehicle(v.vehicleId, v.registration, v.capacity);
    }
    return reply.send({ registered: parsed.data.vehicles.length });
  });
}

function secondsSinceMidnight(): number {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}
