/**
 * Imports bus stops for the Coimbatore area from OpenStreetMap via Overpass.
 *
 * This is step one of replacing hand-placed coordinates with real ones: harvest
 * what already exists before spending weekends in the field.
 *
 *   npx tsx scripts/import-osm-stops.ts
 *   npx tsx scripts/import-osm-stops.ts --bbox 10.88,76.85,11.15,77.22 --out data/osm-stops.json
 *
 * LICENSING: OpenStreetMap data is ODbL. It is share-alike on derived databases,
 * so if you publish a stop database built from this, publish it under ODbL and
 * credit OpenStreetMap contributors. Corrections you make in the field belong
 * back in OSM -- that is where they stay useful to everyone, including you after
 * this project.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Public Overpass instances, tried in order. They are shared and often busy. */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** south,west,north,east — the Coimbatore city area including Sulur to the east. */
const DEFAULT_BBOX = '10.88,76.85,11.15,77.22';

/**
 * Three tagging schemes, because they mean different things and you want both:
 *
 *   highway=bus_stop / public_transport=platform
 *     Roadside, where passengers wait. This is the rider-facing location.
 *
 *   public_transport=stop_position
 *     On the road centreline, where the vehicle actually halts. This is what you
 *     want for map-matching and arrival detection: it sits on the way geometry,
 *     so projecting a GPS fix onto the route shape behaves sensibly. Most
 *     importers ignore it and then wonder why their projections are 15 m off.
 */
function buildQuery(bbox: string): string {
  return `[out:json][timeout:120];
(
  node["highway"="bus_stop"](${bbox});
  node["public_transport"="platform"]["bus"="yes"](${bbox});
  node["public_transport"="stop_position"]["bus"="yes"](${bbox});
);
out body;`;
}

export type StopKind = 'platform' | 'stop_position';

export interface OsmStop {
  osmId: number;
  kind: StopKind;
  lat: number;
  lng: number;
  /** Default name, whatever language it is tagged in. */
  name: string | null;
  /** Tamil name, if tagged. Essential for a Coimbatore product. */
  nameTa: string | null;
  nameEn: string | null;
  /** Direction of travel served, when tagged -- the clue that stops are paired. */
  direction: string | null;
  shelter: boolean | null;
  bench: boolean | null;
  network: string | null;
  operator: string | null;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

function classify(tags: Record<string, string>): StopKind {
  return tags['public_transport'] === 'stop_position' ? 'stop_position' : 'platform';
}

const yesNo = (value: string | undefined): boolean | null =>
  value === undefined ? null : value === 'yes';

export function parseElements(elements: OverpassElement[]): OsmStop[] {
  const stops: OsmStop[] = [];
  for (const el of elements) {
    if (el.type !== 'node' || el.lat === undefined || el.lon === undefined) continue;
    const tags = el.tags ?? {};
    stops.push({
      osmId: el.id,
      kind: classify(tags),
      lat: el.lat,
      lng: el.lon,
      name: tags['name'] ?? null,
      nameTa: tags['name:ta'] ?? null,
      nameEn: tags['name:en'] ?? null,
      direction: tags['direction'] ?? null,
      shelter: yesNo(tags['shelter']),
      bench: yesNo(tags['bench']),
      network: tags['network'] ?? null,
      operator: tags['operator'] ?? null,
    });
  }
  return stops;
}

async function fetchWithFallback(query: string): Promise<OverpassElement[]> {
  let lastError = '';

  for (const endpoint of ENDPOINTS) {
    // Overpass returns 429/504 under load; a couple of backed-off retries is the
    // difference between "this script is flaky" and "this script works".
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }),
        });

        if (res.status === 429 || res.status === 504) {
          const wait = 5000 * (attempt + 1);
          console.warn(`  ${endpoint} busy (${res.status}), retrying in ${wait / 1000}s`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) { lastError = `HTTP ${res.status} from ${endpoint}`; break; }

        const body = (await res.json()) as { elements?: OverpassElement[] };
        return body.elements ?? [];
      } catch (error) {
        lastError = `${endpoint}: ${(error as Error).message}`;
        break;
      }
    }
  }

  throw new Error(
    `Could not reach any Overpass endpoint. Last error: ${lastError}\n` +
    'If you are behind a restrictive network, run this from a machine with open ' +
    'outbound HTTPS, or download an extract from https://download.geofabrik.de/ ' +
    'and query it locally with osmium.',
  );
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  const bbox = arg('bbox', DEFAULT_BBOX);
  const out = resolve(arg('out', 'data/osm-stops.json'));

  console.log(`Querying Overpass for bus stops in [${bbox}] …`);
  const elements = await fetchWithFallback(buildQuery(bbox));
  const stops = parseElements(elements);

  const platforms = stops.filter((s) => s.kind === 'platform');
  const positions = stops.filter((s) => s.kind === 'stop_position');
  const named = stops.filter((s) => s.name);
  const tamil = stops.filter((s) => s.nameTa);

  await writeFile(out, JSON.stringify({
    source: 'OpenStreetMap contributors, ODbL',
    retrievedAt: new Date().toISOString(),
    bbox,
    stops,
  }, null, 2));

  console.log(`\nWrote ${stops.length} stops to ${out}`);
  console.log(`  ${platforms.length} platforms (roadside, rider-facing)`);
  console.log(`  ${positions.length} stop_positions (on the carriageway, for map-matching)`);
  console.log(`  ${named.length} named, ${tamil.length} with a Tamil name`);

  if (positions.length === 0) {
    console.log('\nNo stop_position nodes found. Arrival detection and map-matching will');
    console.log('have to fall back to roadside platforms, which sit off the way geometry.');
  }
  if (tamil.length < named.length / 2) {
    console.log('\nMost stops lack a name:ta tag. Adding Tamil names is a high-value,');
    console.log('low-effort contribution back to OSM while you are surveying anyway.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
