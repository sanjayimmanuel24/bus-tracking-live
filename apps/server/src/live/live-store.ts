/**
 * Current state of every vehicle on the road.
 *
 * Backed by Redis so that several server instances share one view of the fleet
 * and a restart does not blank the map. Falls back to an in-process Map when
 * REDIS_URL is unset, which keeps local development to one command -- the
 * fallback is logged at startup, never silent.
 *
 * Only live state lives here, and it is all short-lived: every key carries a TTL,
 * so a vehicle that stops reporting disappears on its own rather than lingering
 * as a ghost bus. Durable history is Postgres's job.
 */

import Redis from 'ioredis';

import { config } from '../config.ts';
import type { ResolvedPosition } from './types.ts';

const KEY_PREFIX = 'citybus:vehicle:';

export interface LiveStore {
  put(position: ResolvedPosition): Promise<void>;
  all(): Promise<ResolvedPosition[]>;
  get(vehicleId: string): Promise<ResolvedPosition | null>;
  size(): Promise<number>;
  close(): Promise<void>;
  readonly backend: 'redis' | 'memory';
}

/** In-process store. Correct for a single instance, useless for more than one. */
class MemoryLiveStore implements LiveStore {
  readonly backend = 'memory' as const;
  private readonly vehicles = new Map<string, ResolvedPosition>();

  async put(position: ResolvedPosition): Promise<void> {
    this.vehicles.set(position.vehicleId, position);
  }

  async all(): Promise<ResolvedPosition[]> {
    const cutoff = nowSeconds() - config.vehicleStaleSec;
    const live: ResolvedPosition[] = [];
    for (const [id, v] of this.vehicles) {
      // Redis expires stale keys for us; here we have to sweep them ourselves.
      if (v.timestamp < cutoff) this.vehicles.delete(id);
      else live.push(v);
    }
    return live;
  }

  async get(vehicleId: string): Promise<ResolvedPosition | null> {
    const v = this.vehicles.get(vehicleId);
    if (!v) return null;
    if (v.timestamp < nowSeconds() - config.vehicleStaleSec) {
      this.vehicles.delete(vehicleId);
      return null;
    }
    return v;
  }

  async size(): Promise<number> {
    return (await this.all()).length;
  }

  async close(): Promise<void> {
    this.vehicles.clear();
  }
}

class RedisLiveStore implements LiveStore {
  readonly backend = 'redis' as const;

  constructor(private readonly redis: Redis) {}

  async put(position: ResolvedPosition): Promise<void> {
    // The TTL is what makes a vehicle that stops reporting vanish by itself; no
    // sweeper process, no tombstones, no ghost buses on the map.
    await this.redis.set(
      KEY_PREFIX + position.vehicleId,
      JSON.stringify(position),
      'EX',
      config.vehicleStaleSec,
    );
  }

  async all(): Promise<ResolvedPosition[]> {
    // SCAN rather than KEYS: KEYS blocks the Redis event loop for the whole
    // keyspace, which is fine at 48 buses and a production incident at 5,000.
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');

    if (keys.length === 0) return [];

    const values = await this.redis.mget(keys);
    const out: ResolvedPosition[] = [];
    for (const raw of values) {
      if (!raw) continue; // Expired between SCAN and MGET.
      try {
        out.push(JSON.parse(raw) as ResolvedPosition);
      } catch {
        // A single corrupt value must not take down the whole snapshot.
      }
    }
    return out;
  }

  async get(vehicleId: string): Promise<ResolvedPosition | null> {
    const raw = await this.redis.get(KEY_PREFIX + vehicleId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ResolvedPosition;
    } catch {
      return null;
    }
  }

  async size(): Promise<number> {
    return (await this.all()).length;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Build the live store, preferring Redis. A Redis that is configured but
 * unreachable is an error worth surfacing, not something to paper over by
 * silently using memory -- so connection failure is reported to the caller.
 */
export async function createLiveStore(
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<LiveStore> {
  if (!config.redisUrl) {
    log.warn('[live] using in-memory store — not shared across instances');
    return new MemoryLiveStore();
  }

  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

  try {
    await redis.connect();
    await redis.ping();
    log.info(`[live] connected to Redis at ${redactUrl(config.redisUrl)}`);
    return new RedisLiveStore(redis);
  } catch (error) {
    redis.disconnect();
    log.warn(
      `[live] Redis at ${redactUrl(config.redisUrl)} unreachable (${(error as Error).message}) — ` +
      'falling back to in-memory store',
    );
    return new MemoryLiveStore();
  }
}

/** Strip credentials before a connection string reaches a log line. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable url)';
  }
}
