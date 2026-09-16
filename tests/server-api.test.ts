import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Integration tests against the real Fastify app, driven with `inject()` so no
 * port is bound. Runs with neither Postgres nor Redis configured, which also
 * exercises the in-memory fallbacks -- the configuration a contributor gets from
 * a bare `npm run dev`.
 */

process.env['DATABASE_URL'] = '';
process.env['REDIS_URL'] = '';
process.env['INGEST_TOKEN'] = 'test-token';
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'silent';

const { buildApp } = await import('../apps/server/src/app.ts');

let app: FastifyInstance;
let shutdown: () => Promise<void>;
let sampleTripId: string;
let sampleStopId: string;
let originLat: number;
let originLng: number;

beforeAll(async () => {
  const built = await buildApp();
  app = built.app;
  shutdown = built.shutdown;

  // Pick a real trip out of the generated feed rather than hard-coding an ID
  // that a network change would silently invalidate.
  const trip = [...built.feed.trips.values()].find((t) => t.stopTimes.length >= 3)!;
  sampleTripId = trip.trip.trip_id;
  sampleStopId = trip.stopTimes[1]!.stop_id;
  originLat = trip.shape.path[0]!.lat;
  originLng = trip.shape.path[0]!.lng;
});

afterAll(async () => { await shutdown(); });

const post = (payload: unknown, token = 'test-token') =>
  app.inject({
    method: 'POST',
    url: '/api/ingest',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

describe('health', () => {
  it('reports alive without touching dependencies', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('reports which backends are actually in use', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const body = res.json();
    expect(body.liveStore).toBe('memory');
    expect(body.historyEnabled).toBe(false);
    expect(body.feed.routes).toBeGreaterThan(0);
  });
});

describe('GTFS feed', () => {
  it('serves allowlisted files', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/gtfs/routes.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('route_id');
  });

  it('honours conditional requests', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/gtfs/agency.txt' });
    const etag = first.headers.etag as string;
    const second = await app.inject({
      method: 'GET', url: '/api/gtfs/agency.txt', headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
  });

  it('refuses files outside the allowlist', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/gtfs/secrets.txt' })).statusCode).toBe(404);
  });

  it('cannot be walked out of the feed directory', async () => {
    // basename() strips the traversal before the allowlist is even consulted.
    const res = await app.inject({ method: 'GET', url: '/api/gtfs/..%2f..%2fpackage.json' });
    expect(res.statusCode).toBe(404);
  });
});

describe('ingest', () => {
  it('rejects a request with no credentials', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ingest', payload: { reports: [] } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong token', async () => {
    expect((await post({ reports: [] }, 'nope')).statusCode).toBe(401);
  });

  it('rejects a malformed payload without leaking values back', async () => {
    const res = await post({ reports: [{ vehicleId: 'A', tripId: 'B', latitude: 999, longitude: 0, timestamp: 1 }] });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('invalid_payload');
    // Field paths only: echoing submitted values back is a reflection risk.
    expect(JSON.stringify(body.issues)).not.toContain('999');
  });

  it('accepts a valid report and surfaces it in the realtime feed', async () => {
    const res = await post({
      serviceSec: 9 * 3600,
      reports: [{
        vehicleId: 'BUS_TEST', label: 'TN 38 ZZ 9999', tripId: sampleTripId,
        latitude: originLat, longitude: originLng,
        bearing: 90, speedMps: 6, occupancy: 20, capacity: 50,
        timestamp: Math.floor(Date.now() / 1000),
      }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(1);

    const vehicles = await app.inject({ method: 'GET', url: '/api/vehicles' });
    const found = vehicles.json().vehicles.find((v: { vehicleId: string }) => v.vehicleId === 'BUS_TEST');
    expect(found).toBeDefined();
    // Derived server-side from a report that contained none of this.
    expect(found.routeId).toBeTruthy();
    expect(found.distanceAlongM).toBeGreaterThanOrEqual(0);
    expect(found.occupancyPercentage).toBe(40);
  });

  it('rejects one bad report without discarding the rest of the batch', async () => {
    // One phone with a stale trip assignment must not cost you the whole fleet.
    const res = await post({
      serviceSec: 9 * 3600,
      reports: [
        { vehicleId: 'GOOD', tripId: sampleTripId, latitude: originLat, longitude: originLng,
          bearing: 0, speedMps: 4, timestamp: Math.floor(Date.now() / 1000) },
        { vehicleId: 'BAD', tripId: 'NO_SUCH_TRIP', latitude: originLat, longitude: originLng,
          bearing: 0, speedMps: 4, timestamp: Math.floor(Date.now() / 1000) },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1, rejected: 1 });
  });
});

describe('realtime read APIs', () => {
  it('builds a GTFS-Realtime feed message from ingested positions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/realtime' });
    const body = res.json();
    expect(body.header.gtfsRealtimeVersion).toBe('2.0');
    expect(Array.isArray(body.vehiclePositions)).toBe(true);
    expect(body.tripUpdates.length).toBe(body.vehiclePositions.length);
  });

  it('returns a departure board for a known stop', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/stops/${sampleStopId}/departures` });
    expect(res.statusCode).toBe(200);
    expect(res.json().stop.id).toBe(sampleStopId);
  });

  it('404s an unknown stop', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stops/NOPE/departures' });
    expect(res.statusCode).toBe(404);
  });

  it('reports analytics as unavailable rather than faking it without a database', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/on-time' });
    expect(res.statusCode).toBe(200);
    expect(res.json().historyEnabled).toBe(false);
    expect(res.json().routes).toEqual([]);
  });
});
