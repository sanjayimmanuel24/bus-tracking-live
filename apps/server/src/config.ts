/**
 * Server configuration, read once from the environment.
 *
 * Postgres and Redis are optional. When neither is configured the server runs
 * fully in-memory, which keeps `npm run dev` a single command with no
 * infrastructure -- but the degradation is explicit and logged, never silent, so
 * nobody mistakes an in-memory dev box for a durable deployment.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const str = (key: string, fallback: string): string => process.env[key] ?? fallback;
const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number, got "${raw}"`);
  return parsed;
};
const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

export const config = {
  env: str('NODE_ENV', 'development'),
  host: str('HOST', '0.0.0.0'),
  port: num('PORT', 3000),

  /** Directory containing the GTFS static feed this server publishes. */
  gtfsDir: resolve(str('GTFS_DIR', resolve(here, '../../../packages/shared/gtfs'))),

  /** Postgres connection string. Unset disables history entirely. */
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  /** Redis connection string. Unset falls back to an in-process live store. */
  redisUrl: process.env['REDIS_URL'] ?? '',

  /**
   * Shared secret that vehicles present when posting positions. A deployment
   * without one accepts anonymous position reports, so startup refuses to run
   * that way outside development.
   */
  ingestToken: str('INGEST_TOKEN', 'dev-ingest-token'),

  /** How often the server pushes state to connected clients. */
  broadcastHz: num('BROADCAST_HZ', 2),

  /** A vehicle with no report for this long is treated as offline and dropped. */
  vehicleStaleSec: num('VEHICLE_STALE_SEC', 90),

  /** Batch size and flush interval for writing positions to Postgres. */
  historyBatchSize: num('HISTORY_BATCH_SIZE', 200),
  historyFlushMs: num('HISTORY_FLUSH_MS', 2000),

  simulator: {
    /** Run the built-in vehicle simulator alongside the server. */
    enabled: bool('SIMULATOR_ENABLED', true),
    /** Simulated seconds per real second. */
    timeScale: num('SIMULATOR_TIME_SCALE', 8),
    /** Position reports per real second, per vehicle. */
    reportHz: num('SIMULATOR_REPORT_HZ', 2),
    /**
     * Standard deviation of the GPS error injected into reports, in metres.
     * Real telemetry is noisy; a simulator that reports exact positions lets
     * server-side bugs hide.
     */
    gpsNoiseM: num('SIMULATOR_GPS_NOISE_M', 8),
    seed: num('SIMULATOR_SEED', 20260916),
  },
} as const;

export type Config = typeof config;

/** Fail fast on configurations that are unsafe rather than merely degraded. */
export function assertConfigSafe(log: { warn: (msg: string) => void }): void {
  if (config.env === 'production') {
    if (config.ingestToken === 'dev-ingest-token') {
      throw new Error('INGEST_TOKEN must be set to a real secret in production');
    }
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL must be set in production; history is not optional there');
    }
  }
  if (!config.databaseUrl) log.warn('DATABASE_URL not set — position history is disabled');
  if (!config.redisUrl) log.warn('REDIS_URL not set — using an in-process live store, state is not shared between instances');
}
