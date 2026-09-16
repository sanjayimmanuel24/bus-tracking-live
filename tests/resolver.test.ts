import { describe, expect, it } from 'vitest';

import { PositionResolver } from '../apps/server/src/live/resolver.ts';
import type { VehicleReport } from '../apps/server/src/live/types.ts';
import { FIXTURE_STOPS, makeFeed, makeShape, makeTrip } from './fixtures.ts';

const shape = makeShape('SH1', FIXTURE_STOPS.map((s) => s.pos));
const trip = makeTrip('T1', shape, 8 * 3600, { speedKph: 20, dwellSec: 30 });
const feed = makeFeed([trip]);
const resolver = new PositionResolver(feed);

const report = (over: Partial<VehicleReport> = {}): VehicleReport => ({
  vehicleId: 'BUS1',
  label: 'TN 38 AA 1111',
  tripId: 'T1',
  latitude: FIXTURE_STOPS[0]!.pos.lat,
  longitude: FIXTURE_STOPS[0]!.pos.lng,
  bearing: 0,
  speedMps: 5,
  timestamp: 1_760_000_000,
  ...over,
});

describe('PositionResolver', () => {
  it('rejects a report for a trip the timetable does not contain', () => {
    expect(resolver.resolve(report({ tripId: 'NOPE' }), 8 * 3600)).toBeNull();
  });

  it('derives distance along the shape from a bare lat/lng', () => {
    // The device sends no distance; the server recovers it by projection. This is
    // the whole reason a raw GPS fix is enough to produce a GTFS-Realtime feed.
    const midpoint = FIXTURE_STOPS[1]!.pos;
    const resolved = resolver.resolve(
      report({ latitude: midpoint.lat, longitude: midpoint.lng }),
      8 * 3600 + 200,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.distanceAlongM).toBeCloseTo(trip.stopTimes[1]!.shape_dist_traveled, 0);
    expect(resolved!.routeId).toBe('RT1');
  });

  it('measures delay against the timetable', () => {
    const atStop2 = FIXTURE_STOPS[1]!.pos;
    const scheduledArrival = trip.stopTimes[1]!.arrival_time;

    const onTime = resolver.resolve(
      report({ latitude: atStop2.lat, longitude: atStop2.lng }),
      scheduledArrival,
    )!;
    expect(Math.abs(onTime.delaySec)).toBeLessThan(2);

    const late = resolver.resolve(
      report({ latitude: atStop2.lat, longitude: atStop2.lng }),
      scheduledArrival + 300,
    )!;
    expect(late.delaySec).toBeCloseTo(300, 0);

    const early = resolver.resolve(
      report({ latitude: atStop2.lat, longitude: atStop2.lng }),
      scheduledArrival - 120,
    )!;
    expect(early.delaySec).toBeCloseTo(-120, 0);
  });

  it('does not report a bus as early before its trip has started', () => {
    // THE REGRESSION THIS EXISTS FOR.
    // Phase 1's simulator tracked layover internally. The server sees only a
    // position at the trip origin, and the naive calculation reported a bus
    // waiting 20 minutes for its departure as "20 minutes early", which dragged
    // network-wide adherence far below zero.
    const resolved = resolver.resolve(report({ speedMps: 0 }), 8 * 3600 - 1200)!;

    expect(resolved.awaitingDeparture).toBe(true);
    expect(resolved.delaySec).toBe(0);
    // Reported against the stop it is standing at, not the one it will head to.
    expect(resolved.stopIndex).toBe(0);
    expect(resolved.stopSequence).toBe(trip.stopTimes[0]!.stop_sequence);
  });

  it('treats a bus under way as having departed', () => {
    const resolved = resolver.resolve(
      report({ latitude: FIXTURE_STOPS[2]!.pos.lat, longitude: FIXTURE_STOPS[2]!.pos.lng }),
      8 * 3600 + 400,
    )!;
    expect(resolved.awaitingDeparture).toBe(false);
    expect(resolved.stopIndex).toBeGreaterThan(0);
  });

  it('tolerates GPS noise without losing the route', () => {
    // A fix ~40 m off the line still resolves to the right place on the route.
    const near = FIXTURE_STOPS[1]!.pos;
    const resolved = resolver.resolve(
      report({ latitude: near.lat, longitude: near.lng + 0.00037 }),
      8 * 3600 + 200,
    )!;
    expect(resolved.offsetM).toBeGreaterThan(20);
    expect(resolved.offsetM).toBeLessThan(60);
    expect(resolved.offRoute).toBe(false);
    expect(resolved.distanceAlongM).toBeCloseTo(trip.stopTimes[1]!.shape_dist_traveled, -1);
  });

  it('flags a fix far from the route as off-route', () => {
    const resolved = resolver.resolve(
      report({ latitude: FIXTURE_STOPS[1]!.pos.lat, longitude: FIXTURE_STOPS[1]!.pos.lng + 0.02 }),
      8 * 3600 + 200,
    )!;
    expect(resolved.offRoute).toBe(true);
  });

  it('computes occupancy as a percentage of seated capacity', () => {
    const resolved = resolver.resolve(report({ occupancy: 26, capacity: 52 }), 8 * 3600 + 200)!;
    expect(resolved.occupancyPercentage).toBe(50);
  });

  it('reports zero occupancy when the vehicle cannot count passengers', () => {
    // Absent is not the same as empty, but a percentage has to be something;
    // what matters is that it never reads as a fabricated non-zero load.
    const resolved = resolver.resolve(report({ occupancy: undefined }), 8 * 3600 + 200)!;
    expect(resolved.occupancyPercentage).toBe(0);
  });
});
