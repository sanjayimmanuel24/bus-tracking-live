import { describe, expect, it } from 'vitest';

import { parseElements } from '../scripts/import-osm-stops.ts';

/**
 * Overpass element fixtures. Tag combinations are taken from the three schemes
 * that coexist in OSM for bus stops -- the reason a naive importer that only
 * looks for `highway=bus_stop` silently drops a large share of real data.
 */
describe('parseElements', () => {
  it('reads the legacy highway=bus_stop scheme', () => {
    const stops = parseElements([
      { type: 'node', id: 1, lat: 11.0168, lon: 76.9758, tags: { highway: 'bus_stop', name: 'Gandhipuram' } },
    ]);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ osmId: 1, kind: 'platform', name: 'Gandhipuram' });
  });

  it('distinguishes stop_position from platform', () => {
    // These mean different things: a platform is where passengers wait, a
    // stop_position is on the carriageway where the bus halts. Only the latter
    // sits on the way geometry, which is what map-matching needs.
    const stops = parseElements([
      { type: 'node', id: 2, lat: 11.01, lon: 76.97, tags: { public_transport: 'platform', bus: 'yes' } },
      { type: 'node', id: 3, lat: 11.01, lon: 76.97, tags: { public_transport: 'stop_position', bus: 'yes' } },
    ]);
    expect(stops.map((s) => s.kind)).toEqual(['platform', 'stop_position']);
  });

  it('captures Tamil and English name variants separately', () => {
    const stops = parseElements([
      {
        type: 'node', id: 4, lat: 11.0, lon: 77.0,
        tags: {
          highway: 'bus_stop',
          name: 'Ukkadam',
          'name:ta': 'உக்கடம்',
          'name:en': 'Ukkadam',
        },
      },
    ]);
    expect(stops[0]!.nameTa).toBe('உக்கடம்');
    expect(stops[0]!.nameEn).toBe('Ukkadam');
  });

  it('distinguishes an untagged attribute from a false one', () => {
    // shelter=no means surveyed and absent; no tag means nobody has checked.
    // Collapsing both to false would fabricate survey coverage.
    const stops = parseElements([
      { type: 'node', id: 5, lat: 11, lon: 77, tags: { highway: 'bus_stop', shelter: 'no' } },
      { type: 'node', id: 6, lat: 11, lon: 77, tags: { highway: 'bus_stop' } },
    ]);
    expect(stops[0]!.shelter).toBe(false);
    expect(stops[1]!.shelter).toBeNull();
  });

  it('skips ways, relations and nodes without coordinates', () => {
    const stops = parseElements([
      { type: 'way', id: 7, tags: { highway: 'bus_stop' } },
      { type: 'relation', id: 8, tags: { route: 'bus' } },
      { type: 'node', id: 9, tags: { highway: 'bus_stop' } },
      { type: 'node', id: 10, lat: 11, lon: 77, tags: { highway: 'bus_stop' } },
    ]);
    expect(stops.map((s) => s.osmId)).toEqual([10]);
  });

  it('handles an untagged node without throwing', () => {
    const stops = parseElements([{ type: 'node', id: 11, lat: 11, lon: 77 }]);
    expect(stops[0]).toMatchObject({ osmId: 11, name: null, nameTa: null });
  });
});
