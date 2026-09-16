import { describe, expect, it } from 'vitest';

import { DELAY_DECAY_PER_STOP, predictRemainingStops } from '@citybus/shared';
import { adherenceFor, describeDelay, presentEta } from '@citybus/shared';
import { FIXTURE_STOPS, makeShape, makeTrip } from './fixtures.ts';

const shape = makeShape('SH1', FIXTURE_STOPS.map((s) => s.pos));
const trip = makeTrip('T1', shape, 8 * 3600);

// Pretend "now" is exactly 08:00 in POSIX terms.
const ctx = { timestamp: 1_760_000_000, simSec: 8 * 3600 };

describe('predictRemainingStops', () => {
  it('predicts every stop from the current one to the end of the trip', () => {
    const updates = predictRemainingStops(trip, 1, 0, ctx);
    expect(updates).toHaveLength(trip.stopTimes.length - 1);
    expect(updates[0]!.stopSequence).toBe(2);
  });

  it('returns scheduled times unchanged when the bus is on time', () => {
    const updates = predictRemainingStops(trip, 1, 0, ctx);
    for (const [i, update] of updates.entries()) {
      const scheduled = trip.stopTimes[i + 1]!.arrival_time;
      expect(update.arrival.time).toBe(ctx.timestamp - ctx.simSec + scheduled);
      expect(update.arrival.delay).toBe(0);
    }
  });

  it('decays delay toward zero further along the trip', () => {
    // A bus 10 minutes late does not stay exactly 10 minutes late six stops on:
    // drivers recover time. Delay must shrink monotonically with horizon.
    const updates = predictRemainingStops(trip, 0, 600, ctx);
    expect(updates[0]!.arrival.delay).toBe(600);
    expect(updates[1]!.arrival.delay).toBe(Math.round(600 * DELAY_DECAY_PER_STOP));

    for (let i = 1; i < updates.length; i++) {
      expect(updates[i]!.arrival.delay).toBeLessThan(updates[i - 1]!.arrival.delay);
    }
  });

  it('handles early running as negative delay', () => {
    const updates = predictRemainingStops(trip, 0, -120, ctx);
    expect(updates[0]!.arrival.delay).toBe(-120);
    expect(updates[1]!.arrival.delay).toBeGreaterThan(-120);
  });

  it('widens uncertainty with the prediction horizon', () => {
    const updates = predictRemainingStops(trip, 0, 0, ctx);
    for (let i = 1; i < updates.length; i++) {
      expect(updates[i]!.arrival.uncertainty).toBeGreaterThan(updates[i - 1]!.arrival.uncertainty);
    }
  });
});

describe('presentEta', () => {
  const at = (secondsAway: number, uncertainty = 30) => presentEta(
    {
      stopSequence: 1,
      stopId: 'S1',
      arrival: { time: 1000 + secondsAway, delay: 0, uncertainty },
      scheduleRelationship: 'SCHEDULED',
    },
    1000,
  );

  it('says "Due" rather than "0 min" when the bus is arriving', () => {
    expect(at(0).label).toBe('Due');
    expect(at(25).label).toBe('Due');
  });

  it('counts down in whole minutes', () => {
    expect(at(90).label).toBe('2 min');
    expect(at(600).label).toBe('10 min');
  });

  it('switches to a clock time beyond the countdown horizon', () => {
    // Counting down "58 min" implies a precision the model does not have.
    expect(at(60 * 60).label).toMatch(/^\d{2}:\d{2}$/);
  });

  it('downgrades confidence as the uncertainty band widens', () => {
    expect(at(300, 30).confidence).toBe('high');
    expect(at(300, 100).confidence).toBe('medium');
    expect(at(300, 200).confidence).toBe('low');
  });
});

describe('schedule adherence', () => {
  it('treats small deviations as on time', () => {
    // The +/-3 minute band is the standard transit measure, not an arbitrary one.
    expect(adherenceFor(0)).toBe('on-time');
    expect(adherenceFor(179)).toBe('on-time');
    expect(adherenceFor(181)).toBe('late');
  });

  it('flags early running, which is its own service failure', () => {
    // A bus ahead of schedule leaves passengers behind at the stop, so it cannot
    // simply be folded into "on time".
    expect(adherenceFor(-91)).toBe('early');
    expect(describeDelay(-180)).toBe('3 min early');
  });

  it('describes delay in minutes', () => {
    expect(describeDelay(0)).toBe('On time');
    expect(describeDelay(600)).toBe('10 min late');
  });
});
