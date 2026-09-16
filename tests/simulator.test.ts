import { describe, expect, it } from 'vitest';

import { haversineMetres } from '@citybus/shared';
import { SimulatedFeedSource } from '@citybus/shared';
import { FIXTURE_STOPS, makeFeed, makeShape, makeTrip } from './fixtures.ts';

const PATH = FIXTURE_STOPS.map((s) => s.pos);

function buildSource(startSec = 8 * 3600) {
  const outbound = makeShape('SH1', PATH);
  const inbound = makeShape('SH2', [...PATH].reverse());
  const feed = makeFeed([
    makeTrip('T1', outbound, 8 * 3600, { blockId: 'BLK1', directionId: 0 }),
    // The return working, departing the terminus the outbound trip arrived at.
    makeTrip('T2', inbound, 9 * 3600, { blockId: 'BLK1', directionId: 1 }),
  ]);
  return new SimulatedFeedSource(feed, {
    startSec,
    timeScale: 1,
    snapshotHz: 1,
    seed: 42,
    capacityByRoute: { RT1: 50 },
  });
}

describe('SimulatedFeedSource', () => {
  it('reports a speed that matches how far the bus actually moved', () => {
    // THE REGRESSION THIS FILE EXISTS FOR.
    // The prototype random-walked a displayed km/h figure that had no connection
    // to marker movement: the bus crawled at ~2.7 km/h against its own simulation
    // clock while the panel claimed anywhere from 8 to 55 km/h. Here the reported
    // speed must agree with observed displacement over elapsed simulated time.
    const source = buildSource();
    source.advance(120); // Get clear of the origin terminus dwell.

    const STEP_SEC = 5;
    let checked = 0;

    for (let i = 0; i < 40; i++) {
      const before = source.snapshot().vehiclePositions[0];
      source.advance(STEP_SEC);
      const after = source.snapshot().vehiclePositions[0];
      if (!before || !after) continue;
      // Skip steps that span a stop, where the bus decelerates to a dwell.
      if (before.currentStatus === 'STOPPED_AT' || after.currentStatus === 'STOPPED_AT') continue;
      if (before.currentStopSequence !== after.currentStopSequence) continue;

      const moved = haversineMetres(
        { lat: before.position.latitude, lng: before.position.longitude },
        { lat: after.position.latitude, lng: after.position.longitude },
      );
      const observedMps = moved / STEP_SEC;

      expect(observedMps).toBeCloseTo(after.position.speed, 1);
      checked++;
    }

    expect(checked).toBeGreaterThan(5);
  });

  it('runs to the terminus and starts the next trip instead of wrapping around', () => {
    // The prototype advanced the stop index with `(i + 1) % stops.length`, so a
    // bus reaching the last stop teleported back to the first. A real bus lays
    // over and then works its next scheduled trip.
    const source = buildSource();
    const seenTrips = new Set<string>();
    let maxJumpM = 0;
    let previous: { lat: number; lng: number } | null = null;

    for (let i = 0; i < 1400; i++) {
      source.advance(5);
      const vp = source.snapshot().vehiclePositions[0];
      if (!vp) { previous = null; continue; }
      seenTrips.add(vp.trip.tripId);

      const current = { lat: vp.position.latitude, lng: vp.position.longitude };
      if (previous) maxJumpM = Math.max(maxJumpM, haversineMetres(previous, current));
      previous = current;
    }

    expect(seenTrips.has('T1')).toBe(true);
    expect(seenTrips.has('T2')).toBe(true);
    // Position stays continuous across the whole working day, including the
    // handover between trips: the bus lays over at the terminus it arrived at and
    // departs from there. The prototype's modulo wrap teleported it the full
    // length of the route instead.
    expect(maxJumpM).toBeLessThan(400);
  });

  it('keeps reporting a bus while it lays over at a terminus', () => {
    // Dropping layover buses left low-frequency routes with nothing in the feed
    // for minutes at a time, which looks like an outage rather than a timetable
    // gap. A bus waiting at a terminus is still tracked and still transmitting.
    const source = buildSource();
    let sawLayover = false;

    for (let i = 0; i < 400; i++) {
      source.advance(5);
      const vp = source.snapshot().vehiclePositions[0];
      if (!vp) continue;
      // Reported against its next trip, standing at that trip's first stop,
      // before the scheduled departure time.
      if (vp.trip.tripId === 'T2' && vp.currentStatus === 'STOPPED_AT'
          && vp.currentStopSequence === 1 && vp.position.speed === 0) {
        sawLayover = true;
        break;
      }
    }

    expect(sawLayover).toBe(true);
  });

  it('only reports buses that are actually in service', () => {
    // At 04:00 nothing has left the depot, so the feed must be empty rather than
    // showing the whole fleet parked on top of the first stop.
    const early = buildSource(4 * 3600);
    expect(early.snapshot().vehiclePositions).toHaveLength(0);

    const midday = buildSource(8 * 3600);
    midday.advance(300);
    expect(midday.snapshot().vehiclePositions.length).toBeGreaterThan(0);
  });

  it('starts each block at the trip that should be running now', () => {
    // Without a warm start, a bus always begins with the first trip of its block.
    // Opening the app at 09:05 would then run the 08:00 departure and report the
    // whole fleet an hour late -- on-time performance pinned at zero.
    const source = buildSource(9 * 3600 + 300);
    const vp = source.snapshot().vehiclePositions[0];

    expect(vp).toBeDefined();
    expect(vp!.trip.tripId).toBe('T2');

    // And it should be close to schedule, not carrying an hour of phantom delay.
    const update = source.snapshot().tripUpdates[0]!;
    expect(Math.abs(update.delay)).toBeLessThan(600);
  });

  it('reports the whole block finished once the service day is over', () => {
    const source = buildSource(12 * 3600);
    expect(source.snapshot().vehiclePositions).toHaveLength(0);
  });

  it('derives delay from schedule adherence rather than assigning it', () => {
    const source = buildSource();
    source.advance(600);

    const update = source.snapshot().tripUpdates[0];
    expect(update).toBeDefined();
    // The fixture bus runs at its scheduled speed times a congestion factor below
    // 1.0, so it should be measurably late -- and never absurdly so.
    expect(Number.isFinite(update!.delay)).toBe(true);
    expect(Math.abs(update!.delay)).toBeLessThan(3600);
  });

  it('is reproducible for a given seed', () => {
    const a = buildSource();
    const b = buildSource();
    // 300s in, the fixture bus is mid-trip. By 900s it has reached the terminus
    // and dropped out of the feed for its layover, which is correct but leaves
    // nothing to compare.
    a.advance(300);
    b.advance(300);

    const pa = a.snapshot().vehiclePositions[0]!;
    const pb = b.snapshot().vehiclePositions[0]!;
    expect(pa.position.latitude).toBe(pb.position.latitude);
    expect(pa.position.longitude).toBe(pb.position.longitude);
  });

  it('sub-steps large time jumps so no stop is skipped', () => {
    // A single 300-second step at high time scale could otherwise carry a bus
    // straight past a stop without registering the arrival.
    const coarse = buildSource();
    const fine = buildSource();

    coarse.advance(300);
    for (let i = 0; i < 60; i++) fine.advance(5);

    const c = coarse.snapshot().vehiclePositions[0]!;
    const f = fine.snapshot().vehiclePositions[0]!;
    expect(c.currentStopSequence).toBe(f.currentStopSequence);
    expect(haversineMetres(
      { lat: c.position.latitude, lng: c.position.longitude },
      { lat: f.position.latitude, lng: f.position.longitude },
    )).toBeLessThan(50);
  });

  it('keeps occupancy within a plausible range', () => {
    const source = buildSource();
    for (let i = 0; i < 200; i++) {
      source.advance(5);
      for (const vp of source.snapshot().vehiclePositions) {
        expect(vp.occupancyPercentage).toBeGreaterThanOrEqual(0);
        // Standing load is allowed up to 1.6x seated capacity, never beyond.
        expect(vp.occupancyPercentage).toBeLessThanOrEqual(160);
      }
    }
  });
});
