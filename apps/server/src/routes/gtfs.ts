/**
 * Serves the GTFS static feed.
 *
 * The server owns the timetable: the client fetches it from here rather than
 * bundling its own copy, so schedule and realtime data can never disagree about
 * which trips exist. Files are immutable for a given feed version, so they are
 * cached aggressively.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { config } from '../config.ts';

/** Only the files the client actually needs. An allowlist, not a directory listing. */
const SERVABLE = new Set([
  'agency.txt', 'stops.txt', 'routes.txt', 'trips.txt',
  'stop_times.txt', 'shapes.txt', 'calendar.txt', 'feed_info.txt',
]);

export async function registerGtfsRoutes(app: FastifyInstance): Promise<void> {
  const cache = new Map<string, { body: string; etag: string }>();

  app.get<{ Params: { file: string } }>('/api/gtfs/:file', async (request, reply) => {
    // basename() strips any path component, so "../../etc/passwd" cannot escape
    // the feed directory even before the allowlist check.
    const file = basename(request.params.file);
    if (!SERVABLE.has(file)) return reply.code(404).send({ error: 'unknown_feed_file' });

    let entry = cache.get(file);
    if (!entry) {
      try {
        const body = await readFile(join(config.gtfsDir, file), 'utf8');
        entry = { body, etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
        cache.set(file, entry);
      } catch {
        return reply.code(404).send({ error: 'feed_file_missing' });
      }
    }

    if (request.headers['if-none-match'] === entry.etag) return reply.code(304).send();

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .header('etag', entry.etag)
      .send(entry.body);
  });

  /** Feed metadata, so a client can decide whether to re-download. */
  app.get('/api/gtfs', async () => ({
    files: [...SERVABLE],
    baseUrl: '/api/gtfs',
  }));
}
