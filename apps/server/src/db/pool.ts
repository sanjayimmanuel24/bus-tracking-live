/**
 * Postgres connection pool.
 *
 * Returns null when DATABASE_URL is unset, which disables history rather than
 * crashing: the realtime path does not depend on Postgres, so a database outage
 * should degrade the product to "no history" and not to "no bus tracking".
 */

import pg from 'pg';

import { config } from '../config.ts';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (!config.databaseUrl) return null;
  if (pool) return pool;

  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // An error on an idle client would otherwise reach the process as an uncaught
  // exception and take the server down with it.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[db] idle client error', err.message);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
