/**
 * Position history: batched writes to Postgres, and the queries that read them back.
 *
 * At 48 buses reporting twice a second this is ~8.3 million rows a day, so
 * positions are buffered and flushed with a single multi-row INSERT rather than
 * one statement per report. The buffer is bounded and drops oldest-first: losing
 * history is survivable, unbounded memory growth is not.
 */

import type { Pool } from 'pg';

import { config } from '../config.ts';
import { getPool } from './pool.ts';
import type { ResolvedPosition } from '../live/types.ts';

/** Hard ceiling on buffered rows before the oldest are discarded. */
const MAX_BUFFER = 10_000;

export class HistoryWriter {
  private readonly pool: Pool | null;
  private buffer: ResolvedPosition[] = [];
  private timer: NodeJS.Timeout | null = null;
  private droppedRows = 0;
  private writtenRows = 0;

  constructor(private readonly log: { warn: (msg: string) => void; error: (msg: string) => void }) {
    this.pool = getPool();
  }

  get enabled(): boolean {
    return this.pool !== null;
  }

  get stats(): { written: number; dropped: number; buffered: number } {
    return { written: this.writtenRows, dropped: this.droppedRows, buffered: this.buffer.length };
  }

  start(): void {
    if (!this.pool || this.timer) return;
    this.timer = setInterval(() => void this.flush(), config.historyFlushMs);
    // Do not hold the event loop open purely to flush history.
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.flush();
  }

  record(position: ResolvedPosition): void {
    if (!this.pool) return;
    this.buffer.push(position);

    if (this.buffer.length > MAX_BUFFER) {
      const overflow = this.buffer.length - MAX_BUFFER;
      this.buffer.splice(0, overflow);
      this.droppedRows += overflow;
    }
    if (this.buffer.length >= config.historyBatchSize) void this.flush();
  }

  async flush(): Promise<void> {
    if (!this.pool || this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    // One INSERT with N value tuples. Parameterised throughout -- these values
    // come from a network request and must never be interpolated into SQL.
    const PARAMS_PER_ROW = 13;
    const values: unknown[] = [];
    const tuples: string[] = [];

    batch.forEach((p, i) => {
      const b = i * PARAMS_PER_ROW;
      tuples.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, to_timestamp($${b + 4}), ` +
        // ST_MakePoint takes longitude first, then latitude.
        `ST_SetSRID(ST_MakePoint($${b + 5}, $${b + 6}), 4326)::geography, ` +
        `$${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13})`,
      );
      values.push(
        p.vehicleId, p.tripId, p.routeId, p.timestamp,
        p.longitude, p.latitude,
        p.bearing, p.speedMps, p.distanceAlongM, p.offsetM,
        // delay_sec, stop_sequence and occupancy_pct are integer columns; the
        // resolver produces delay as a float, and Postgres rejects "13.47" for
        // an INTEGER rather than truncating it.
        Math.round(p.delaySec), p.stopSequence, Math.round(p.occupancyPercentage),
      );
    });

    const sql =
      `INSERT INTO vehicle_positions
        (vehicle_id, trip_id, route_id, recorded_at, position,
         bearing_deg, speed_mps, distance_along_m, offset_m,
         delay_sec, stop_sequence, occupancy_pct)
       VALUES ${tuples.join(', ')}`;

    try {
      await this.pool.query(sql, values);
      this.writtenRows += batch.length;
    } catch (error) {
      this.droppedRows += batch.length;
      this.log.error(`[history] batch of ${batch.length} failed: ${(error as Error).message}`);
    }
  }

  /** Upsert the vehicle registry so a bus is known independently of its trips. */
  async registerVehicle(vehicleId: string, registration: string, capacity: number): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO vehicles (vehicle_id, registration, seated_capacity)
         VALUES ($1, $2, $3)
         ON CONFLICT (vehicle_id)
         DO UPDATE SET registration = EXCLUDED.registration, last_seen_at = now()`,
        [vehicleId, registration, capacity],
      );
    } catch (error) {
      this.log.warn(`[history] vehicle upsert failed: ${(error as Error).message}`);
    }
  }

  /** Record an observed arrival: ground truth for scoring arrival predictions. */
  async recordArrival(row: {
    vehicleId: string; tripId: string; routeId: string; stopId: string;
    stopSequence: number; scheduledAt: number; observedAt: number; delaySec: number;
  }): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO stop_arrivals
          (vehicle_id, trip_id, route_id, stop_id, stop_sequence,
           scheduled_at, observed_at, delay_sec)
         VALUES ($1,$2,$3,$4,$5, to_timestamp($6), to_timestamp($7), $8)
         ON CONFLICT DO NOTHING`,
        [row.vehicleId, row.tripId, row.routeId, row.stopId, row.stopSequence,
          row.scheduledAt, row.observedAt, row.delaySec],
      );
    } catch (error) {
      this.log.warn(`[history] arrival insert failed: ${(error as Error).message}`);
    }
  }

  /** Replay one vehicle's track over a time window. */
  async track(vehicleId: string, fromPosix: number, toPosix: number): Promise<{
    recordedAt: string; lat: number; lng: number; speedMps: number | null; delaySec: number | null;
  }[]> {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      `SELECT recorded_at,
              ST_Y(position::geometry) AS lat,
              ST_X(position::geometry) AS lng,
              speed_mps, delay_sec
         FROM vehicle_positions
        WHERE vehicle_id = $1 AND recorded_at BETWEEN to_timestamp($2) AND to_timestamp($3)
        ORDER BY recorded_at`,
      [vehicleId, fromPosix, toPosix],
    );
    return rows.map((r) => ({
      recordedAt: r.recorded_at.toISOString(),
      lat: Number(r.lat),
      lng: Number(r.lng),
      speedMps: r.speed_mps === null ? null : Number(r.speed_mps),
      delaySec: r.delay_sec === null ? null : Number(r.delay_sec),
    }));
  }

  /**
   * On-time performance over a window, by route.
   *
   * The kind of question the live feed simply cannot answer, and the reason for
   * keeping history at all.
   */
  async onTimePerformance(sinceMinutes: number): Promise<{
    routeId: string; samples: number; onTimePct: number; meanDelaySec: number;
  }[]> {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      `SELECT route_id,
              count(*)::int AS samples,
              round(100.0 * avg((abs(delay_sec) <= 180)::int))::int AS on_time_pct,
              round(avg(delay_sec))::int AS mean_delay_sec
         FROM vehicle_positions
        WHERE recorded_at > now() - ($1 || ' minutes')::interval
          AND delay_sec IS NOT NULL
        GROUP BY route_id
        ORDER BY route_id`,
      [String(sinceMinutes)],
    );
    return rows.map((r) => ({
      routeId: r.route_id,
      samples: r.samples,
      onTimePct: r.on_time_pct ?? 100,
      meanDelaySec: r.mean_delay_sec ?? 0,
    }));
  }

  /** Mirror GTFS stops into PostGIS so spatial queries run in the database. */
  async syncStops(stops: { id: string; name: string; lat: number; lng: number }[]): Promise<void> {
    if (!this.pool || stops.length === 0) return;
    const values: unknown[] = [];
    const tuples = stops.map((s, i) => {
      const b = i * 4;
      values.push(s.id, s.name, s.lng, s.lat);
      return `($${b + 1}, $${b + 2}, ST_SetSRID(ST_MakePoint($${b + 3}, $${b + 4}), 4326)::geography)`;
    });
    await this.pool.query(
      `INSERT INTO stops (stop_id, stop_name, position) VALUES ${tuples.join(', ')}
       ON CONFLICT (stop_id) DO UPDATE
         SET stop_name = EXCLUDED.stop_name, position = EXCLUDED.position`,
      values,
    );
  }

  /** Stops within `radiusM` of a point, nearest first. A PostGIS query, not a scan. */
  async stopsNear(lat: number, lng: number, radiusM: number, limit = 10): Promise<{
    stopId: string; stopName: string; distanceM: number;
  }[]> {
    if (!this.pool) return [];
    const { rows } = await this.pool.query(
      `SELECT stop_id, stop_name,
              ST_Distance(position, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_m
         FROM stops
        WHERE ST_DWithin(position, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
        ORDER BY distance_m
        LIMIT $4`,
      [lat, lng, radiusM, limit],
    );
    return rows.map((r) => ({
      stopId: r.stop_id,
      stopName: r.stop_name,
      distanceM: Math.round(Number(r.distance_m)),
    }));
  }
}
