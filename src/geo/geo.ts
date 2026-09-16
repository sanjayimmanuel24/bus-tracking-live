/**
 * Spherical geometry helpers.
 *
 * The original prototype measured distance as `Math.sqrt(dLat^2 + dLng^2)` on raw
 * degrees and compared it against a degree-valued threshold. That conflates two
 * different units (a degree of longitude at Coimbatore's latitude is ~1.8% shorter
 * than a degree of latitude) and, more importantly, produces a "distance" that
 * cannot be converted to metres — so no speed, ETA or progress figure derived from
 * it can be correct. Everything here works in metres.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** IUGG mean Earth radius, metres. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial bearing from `a` to `b`, in degrees clockwise from true north (0-360).
 *
 * The prototype used `atan2(dLng, dLat) * 180 / PI`, which is a reasonable
 * small-angle approximation but does not account for longitude convergence and
 * returns a signed value in -180..180. Map rotation needs 0..360.
 */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Linear interpolation between two positions. `t` is clamped to [0, 1]. */
export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  const c = Math.max(0, Math.min(1, t));
  return { lat: a.lat + (b.lat - a.lat) * c, lng: a.lng + (b.lng - a.lng) * c };
}

/**
 * Cumulative distance in metres at each vertex of a polyline.
 * Returns an array of the same length as `path`, starting at 0.
 */
export function cumulativeDistances(path: readonly LatLng[]): number[] {
  const out: number[] = new Array(path.length);
  out[0] = 0;
  for (let i = 1; i < path.length; i++) {
    out[i] = out[i - 1]! + haversineMetres(path[i - 1]!, path[i]!);
  }
  return out;
}

export interface PointAlongPath {
  position: LatLng;
  bearing: number;
  /** Index of the segment the point falls on (from vertex i to i+1). */
  segmentIndex: number;
}

/**
 * Locate a point a given distance along a polyline.
 *
 * `cumulative` must be the output of `cumulativeDistances(path)`; it is passed in
 * rather than recomputed because the simulator calls this once per vehicle per
 * frame and the path never changes.
 */
export function pointAlongPath(
  path: readonly LatLng[],
  cumulative: readonly number[],
  distanceM: number,
): PointAlongPath {
  const total = cumulative[cumulative.length - 1]!;
  const d = Math.max(0, Math.min(total, distanceM));

  // Binary search for the last vertex at or before `d`.
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumulative[mid]! <= d) lo = mid;
    else hi = mid - 1;
  }

  const i = Math.min(lo, path.length - 2);
  const segStart = cumulative[i]!;
  const segLength = cumulative[i + 1]! - segStart;
  const t = segLength === 0 ? 0 : (d - segStart) / segLength;

  return {
    position: interpolate(path[i]!, path[i + 1]!, t),
    bearing: bearingDegrees(path[i]!, path[i + 1]!),
    segmentIndex: i,
  };
}

export const metresPerSecToKph = (mps: number): number => mps * 3.6;
export const kphToMetresPerSec = (kph: number): number => kph / 3.6;

export interface PathProjection {
  /** Distance along the path to the closest point, in metres. */
  distanceAlongM: number;
  /** Perpendicular distance from the path, in metres. */
  offsetM: number;
  segmentIndex: number;
}

/**
 * Project a point onto a polyline, returning how far along the line it falls.
 *
 * GTFS-Realtime `VehiclePosition` reports a latitude and longitude but no
 * distance-along-shape, so any consumer that wants journey progress has to
 * recover it this way. Doing it properly also yields `offsetM`, the perpendicular
 * distance from the route -- the basis for off-route detection and the entry
 * point for real map-matching in a later phase.
 *
 * Segment-local maths uses an equirectangular approximation, which is accurate to
 * well under a metre over the short segments involved here.
 */
export function projectOntoPath(
  path: readonly LatLng[],
  cumulative: readonly number[],
  point: LatLng,
): PathProjection {
  const latScale = EARTH_RADIUS_M * (Math.PI / 180);
  const lngScale = latScale * Math.cos(toRad(point.lat));

  const toLocal = (p: LatLng): [number, number] => [
    (p.lng - point.lng) * lngScale,
    (p.lat - point.lat) * latScale,
  ];

  let best: PathProjection = { distanceAlongM: 0, offsetM: Infinity, segmentIndex: 0 };

  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = toLocal(path[i]!);
    const [bx, by] = toLocal(path[i + 1]!);
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    // Clamp to the segment so the projection cannot fall beyond either endpoint.
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const offsetM = Math.hypot(px, py);

    if (offsetM < best.offsetM) {
      const segLength = cumulative[i + 1]! - cumulative[i]!;
      best = {
        distanceAlongM: cumulative[i]! + t * segLength,
        offsetM,
        segmentIndex: i,
      };
    }
  }

  return best;
}
