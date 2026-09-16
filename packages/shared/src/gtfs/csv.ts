/**
 * Minimal RFC 4180 CSV reader/writer for GTFS `.txt` files.
 *
 * GTFS files are plain comma-separated text with a header row. Values may be
 * quoted, and quoted values may contain commas, newlines and doubled quotes --
 * stop names like `Gandhipuram, Platform 2` are exactly the case a naive
 * `line.split(',')` gets wrong, so this handles quoting properly.
 */

/** Parse a CSV document into an array of header-keyed string records. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseRows(text);
  if (rows.length === 0) return [];

  // Strip a UTF-8 BOM if present -- common in agency-published feeds.
  const header = rows[0]!.map((h, i) => (i === 0 ? h.replace(/^﻿/, '') : h).trim());

  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    // Skip blank trailing lines.
    if (row.length === 1 && row[0] === '') continue;
    const rec: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) rec[header[c]!] = row[c] ?? '';
    out.push(rec);
  }
  return out;
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; }
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* handled by the \n branch */ }
    else { field += ch; }
  }

  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Serialise records to CSV, quoting only where required. */
export function toCsv(header: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((h) => escapeField(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

function escapeField(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Parse a GTFS `HH:MM:SS` time into seconds after midnight. Hours may exceed 23. */
export function parseGtfsTime(value: string): number {
  const parts = value.split(':');
  if (parts.length !== 3) throw new Error(`Invalid GTFS time: "${value}"`);
  const [h, m, s] = parts.map(Number) as [number, number, number];
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) {
    throw new Error(`Invalid GTFS time: "${value}"`);
  }
  return h * 3600 + m * 60 + s;
}

/** Format seconds after midnight as GTFS `HH:MM:SS`, allowing hours >= 24. */
export function formatGtfsTime(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
