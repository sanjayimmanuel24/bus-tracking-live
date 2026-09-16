import { describe, expect, it } from 'vitest';

import {
  bearingDegrees, cumulativeDistances, haversineMetres,
  pointAlongPath, projectOntoPath,
} from '@citybus/shared';

describe('haversineMetres', () => {
  it('measures a known meridian arc', () => {
    // 0.01 degrees of latitude is ~1111.9 m anywhere on the sphere.
    const d = haversineMetres({ lat: 11.0, lng: 77.0 }, { lat: 11.01, lng: 77.0 });
    expect(d).toBeGreaterThan(1110);
    expect(d).toBeLessThan(1114);
  });

  it('accounts for longitude convergence with latitude', () => {
    // The bug the prototype's Euclidean degree distance had: a degree of longitude
    // is shorter than a degree of latitude, and the gap widens away from the
    // equator. At 11 deg N the two differ by roughly 1.8 percent.
    const lat = haversineMetres({ lat: 11, lng: 77 }, { lat: 12, lng: 77 });
    const lng = haversineMetres({ lat: 11, lng: 77 }, { lat: 11, lng: 78 });
    expect(lng).toBeLessThan(lat);
    expect(lat / lng).toBeCloseTo(1.018, 2);
  });

  it('is symmetric and zero for identical points', () => {
    const a = { lat: 11.0168, lng: 76.9758 };
    const b = { lat: 11.0268, lng: 76.9858 };
    expect(haversineMetres(a, b)).toBeCloseTo(haversineMetres(b, a), 6);
    expect(haversineMetres(a, a)).toBe(0);
  });
});

describe('bearingDegrees', () => {
  it('returns compass bearings in the 0-360 range', () => {
    const origin = { lat: 11, lng: 77 };
    expect(bearingDegrees(origin, { lat: 12, lng: 77 })).toBeCloseTo(0, 1);
    expect(bearingDegrees(origin, { lat: 10, lng: 77 })).toBeCloseTo(180, 1);

    // Due east and west are only approximately 90 and 270: the great circle
    // between two points at the same latitude bulges toward the pole, so the
    // *initial* bearing is a fraction of a degree north of due east. 89.9 here is
    // correct geodesy, not floating-point error.
    expect(bearingDegrees(origin, { lat: 11, lng: 78 })).toBeCloseTo(89.9, 1);

    // The key property: west reads 270, not the -90 a raw atan2 would return.
    expect(bearingDegrees(origin, { lat: 11, lng: 76 })).toBeCloseTo(270.1, 1);
    expect(bearingDegrees(origin, { lat: 11, lng: 76 })).toBeGreaterThan(0);
  });
});

describe('pointAlongPath', () => {
  const path = [
    { lat: 11.0, lng: 77.0 },
    { lat: 11.01, lng: 77.0 },
    { lat: 11.02, lng: 77.0 },
  ];
  const cumulative = cumulativeDistances(path);

  it('returns the endpoints at zero and full distance', () => {
    expect(pointAlongPath(path, cumulative, 0).position.lat).toBeCloseTo(11.0, 6);
    const end = pointAlongPath(path, cumulative, cumulative[2]!);
    expect(end.position.lat).toBeCloseTo(11.02, 6);
  });

  it('interpolates to the midpoint', () => {
    const mid = pointAlongPath(path, cumulative, cumulative[2]! / 2);
    expect(mid.position.lat).toBeCloseTo(11.01, 4);
  });

  it('clamps distances beyond either end of the path', () => {
    expect(pointAlongPath(path, cumulative, -500).position.lat).toBeCloseTo(11.0, 6);
    expect(pointAlongPath(path, cumulative, 1e9).position.lat).toBeCloseTo(11.02, 6);
  });
});

describe('projectOntoPath', () => {
  const path = [
    { lat: 11.0, lng: 77.0 },
    { lat: 11.02, lng: 77.0 },
  ];
  const cumulative = cumulativeDistances(path);

  it('recovers distance along the line for a point on it', () => {
    const projection = projectOntoPath(path, cumulative, { lat: 11.01, lng: 77.0 });
    expect(projection.distanceAlongM).toBeCloseTo(cumulative[1]! / 2, 0);
    expect(projection.offsetM).toBeLessThan(1);
  });

  it('reports perpendicular offset for a point beside the line', () => {
    // ~0.001 degrees of longitude at this latitude is a little over 100 m.
    const projection = projectOntoPath(path, cumulative, { lat: 11.01, lng: 77.001 });
    expect(projection.offsetM).toBeGreaterThan(100);
    expect(projection.offsetM).toBeLessThan(115);
    expect(projection.distanceAlongM).toBeCloseTo(cumulative[1]! / 2, 0);
  });

  it('clamps to the segment rather than projecting past its end', () => {
    const before = projectOntoPath(path, cumulative, { lat: 10.98, lng: 77.0 });
    expect(before.distanceAlongM).toBe(0);
    const after = projectOntoPath(path, cumulative, { lat: 11.04, lng: 77.0 });
    expect(after.distanceAlongM).toBeCloseTo(cumulative[1]!, 3);
  });
});
