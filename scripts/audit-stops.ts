/**
 * Compares the hand-placed stops in `data/network.ts` against a real OSM extract
 * and reports, per stop, how far off it is.
 *
 *   npx tsx scripts/import-osm-stops.ts      # writes data/osm-stops.json
 *   npx tsx scripts/audit-stops.ts
 *   npx tsx scripts/audit-stops.ts --in some/other/extract.json
 *
 * The point is to turn "the coordinates are approximate" from an admission in the
 * README into a number you can act on: which stops are fine, which need a field
 * visit, and which do not appear to exist in OSM at all.
 *
 * A large distance here does NOT automatically mean your stop is wrong -- OSM may
 * be missing the stop, or may have it under a different name. It means the stop
 * is unverified, which is exactly the list you want before going out to survey.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';


import { STOPS } from '../data/network.ts';
import { haversineMetres } from '../packages/shared/src/geo/geo.ts';
import type { OsmStop } from './import-osm-stops.ts';

/**
 * Accuracy bands.
 *
 * GOOD is set at 25 m because arrival detection typically uses a 30-50 m
 * geofence: inside that, the stop position will not cause false or missed
 * arrivals. NEARBY covers "plausibly the same stop, but worth a look" -- note
 * that a genuine pair of stops either side of a road is usually 20-40 m apart,
 * so a match in this band may mean you have collapsed two stops into one.
 */
const GOOD_M = 25;
const NEARBY_M = 100;
const SEARCH_RADIUS_M = 300;

interface Match {
  id: string;
  name: string;
  nearest: OsmStop | null;
  distanceM: number;
  /** OSM stops within the search radius, a hint that the stop is really a pair. */
  candidatesNearby: number;
}

function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Loose name agreement: either contains the other's significant words. */
function namesAgree(a: string, b: string): boolean {
  const left = normalise(a);
  const right = normalise(b);
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return true;
  const leftWords = new Set(left.split(' ').filter((w) => w.length > 3));
  const rightWords = right.split(' ').filter((w) => w.length > 3);
  return rightWords.some((w) => leftWords.has(w));
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  const path = resolve(arg('in', 'data/osm-stops.json'));
  let osmStops: OsmStop[];
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { stops: OsmStop[] };
    osmStops = raw.stops;
  } catch {
    console.error(`Could not read ${path}.`);
    console.error('Run `npx tsx scripts/import-osm-stops.ts` first.');
    process.exit(1);
  }

  const matches: Match[] = STOPS.map((stop) => {
    let nearest: OsmStop | null = null;
    let best = Infinity;
    let candidatesNearby = 0;

    for (const osm of osmStops) {
      const d = haversineMetres({ lat: stop.lat, lng: stop.lng }, { lat: osm.lat, lng: osm.lng });
      if (d <= SEARCH_RADIUS_M) candidatesNearby++;
      if (d < best) { best = d; nearest = osm; }
    }

    return { id: stop.id, name: stop.name, nearest, distanceM: best, candidatesNearby };
  });

  const good = matches.filter((m) => m.distanceM <= GOOD_M);
  const nearby = matches.filter((m) => m.distanceM > GOOD_M && m.distanceM <= NEARBY_M);
  const far = matches.filter((m) => m.distanceM > NEARBY_M && m.distanceM <= SEARCH_RADIUS_M);
  const missing = matches.filter((m) => m.distanceM > SEARCH_RADIUS_M);

  console.log(`\nAudited ${STOPS.length} stops against ${osmStops.length} OSM nodes\n`);
  console.log(`  within ${GOOD_M} m   ${String(good.length).padStart(3)}   usable as-is`);
  console.log(`  ${GOOD_M}-${NEARBY_M} m       ${String(nearby.length).padStart(3)}   probably the same stop; verify`);
  console.log(`  ${NEARBY_M}-${SEARCH_RADIUS_M} m      ${String(far.length).padStart(3)}   likely wrong, or matched the wrong stop`);
  console.log(`  no match       ${String(missing.length).padStart(3)}   absent from OSM, or badly misplaced`);

  const verified = good.length;
  console.log(`\n  ${Math.round((verified / STOPS.length) * 100)}% of stops are corroborated by OSM within ${GOOD_M} m.`);

  const printRow = (m: Match): void => {
    const osmName = m.nearest?.name ?? '(unnamed)';
    const agree = m.nearest?.name && namesAgree(m.name, m.nearest.name) ? '' : '  [name differs]';
    const distance = m.distanceM === Infinity ? '  --' : `${Math.round(m.distanceM)} m`;
    console.log(`    ${m.name.padEnd(26)} ${distance.padStart(7)}  ${osmName}${agree}`);
  };

  if (far.length + missing.length > 0) {
    console.log('\nSurvey these first:');
    [...missing, ...far].sort((a, b) => b.distanceM - a.distanceM).forEach(printRow);
  }

  if (nearby.length > 0) {
    console.log('\nWorth a look (a 20-40 m gap often means a stop pair collapsed into one):');
    nearby.sort((a, b) => b.distanceM - a.distanceM).forEach(printRow);
  }

  // OSM stops the network does not reference at all: either routes you have not
  // modelled, or stops your route definitions are missing.
  const claimed = new Set<number>();
  for (const m of matches) {
    if (m.nearest && m.distanceM <= NEARBY_M) claimed.add(m.nearest.osmId);
  }
  const unclaimed = osmStops.filter((s) => !claimed.has(s.osmId) && s.name);
  console.log(`\n${unclaimed.length} named OSM stops in the area are not referenced by any route`);
  console.log('in data/network.ts. Some are other operators; some are stops your routes');
  console.log('actually serve but your definitions omit.');

  const pairs = matches.filter((m) => m.candidatesNearby >= 2).length;
  if (pairs > 0) {
    console.log(`\n${pairs} of your stops have 2+ OSM nodes within ${SEARCH_RADIUS_M} m, which is what`);
    console.log('a stop pair either side of the road looks like. Each direction needs its own');
    console.log('stop_id, grouped with parent_station -- they have different arrival times.');
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
