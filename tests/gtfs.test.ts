import { describe, expect, it } from 'vitest';

import { formatGtfsTime, parseCsv, parseGtfsTime, toCsv } from '../src/gtfs/csv.ts';

describe('parseCsv', () => {
  it('reads a simple header-keyed table', () => {
    const rows = parseCsv('stop_id,stop_name\nS1,Alpha\nS2,Bravo\n');
    expect(rows).toEqual([
      { stop_id: 'S1', stop_name: 'Alpha' },
      { stop_id: 'S2', stop_name: 'Bravo' },
    ]);
  });

  it('handles commas inside quoted values', () => {
    // A naive line.split(',') turns this single stop into two broken columns --
    // and stop names with commas are entirely normal in published feeds.
    const rows = parseCsv('stop_id,stop_name\nS1,"Gandhipuram, Platform 2"\n');
    expect(rows[0]!['stop_name']).toBe('Gandhipuram, Platform 2');
  });

  it('handles escaped quotes and embedded newlines', () => {
    const rows = parseCsv('stop_id,stop_name\nS1,"The ""Old"" Depot"\nS2,"Two\nLines"\n');
    expect(rows[0]!['stop_name']).toBe('The "Old" Depot');
    expect(rows[1]!['stop_name']).toBe('Two\nLines');
  });

  it('strips a UTF-8 BOM from the first header cell', () => {
    const rows = parseCsv('﻿stop_id,stop_name\nS1,Alpha\n');
    expect(rows[0]!['stop_id']).toBe('S1');
  });

  it('tolerates CRLF line endings and trailing blank lines', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n\r\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ a: '1', b: '2' });
  });
});

describe('toCsv', () => {
  it('round-trips values that need quoting', () => {
    const csv = toCsv(['id', 'name'], [{ id: 'S1', name: 'Alpha, "Main"' }]);
    expect(parseCsv(csv)[0]!['name']).toBe('Alpha, "Main"');
  });
});

describe('GTFS time', () => {
  it('parses HH:MM:SS into seconds after midnight', () => {
    expect(parseGtfsTime('00:00:00')).toBe(0);
    expect(parseGtfsTime('08:30:15')).toBe(8 * 3600 + 30 * 60 + 15);
  });

  it('supports hours past midnight, as the spec requires', () => {
    // GTFS models a trip departing 23:50 and arriving 00:20 the next day as
    // 24:20:00, so that it still belongs to the same service day. Clamping the
    // hour to 23 would silently move the arrival 24 hours earlier.
    expect(parseGtfsTime('25:10:00')).toBe(25 * 3600 + 600);
    expect(formatGtfsTime(25 * 3600 + 600)).toBe('25:10:00');
  });

  it('round-trips through formatting', () => {
    for (const seconds of [0, 59, 3600, 45296, 86399, 90000]) {
      expect(parseGtfsTime(formatGtfsTime(seconds))).toBe(seconds);
    }
  });

  it('rejects malformed input rather than producing NaN times', () => {
    expect(() => parseGtfsTime('8:30')).toThrow();
    expect(() => parseGtfsTime('not:a:time')).toThrow();
  });
});
