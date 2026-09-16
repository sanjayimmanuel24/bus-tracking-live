/**
 * Applies SQL migrations in filename order, recording each in `schema_migrations`.
 *
 * Deliberately minimal: each file runs once, inside a transaction, and a failure
 * rolls back that file and stops the run. No down-migrations -- reversing a
 * migration on a production time-series table is usually a restore, not a script.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, getPool } from './pool.ts';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(log: (msg: string) => void = console.log): Promise<void> {
  const pool = getPool();
  if (!pool) {
    log('[migrate] DATABASE_URL not set — nothing to do');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`[migrate] applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }

  log(`[migrate] up to date (${files.length} migration${files.length === 1 ? '' : 's'})`);
}

// Allow running directly: npm run db:migrate
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error((error as Error).message);
      process.exit(1);
    });
}
