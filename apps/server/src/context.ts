/**
 * Shared application state, assembled once at startup and handed to routes.
 *
 * Holds the loaded timetable, the live store, the history writer and the
 * WebSocket hub, plus the small amount of derived state that has to live
 * somewhere: the current service clock and the arrival ground-truth tracker.
 */

import {
  presentEta,
  type RealtimeSnapshot,
  type TransitFeed,
} from '@citybus/shared';

import { config } from './config.ts';
import type { HistoryWriter } from './db/history.ts';
import type { LiveStore } from './live/live-store.ts';
import type { PositionResolver } from './live/resolver.ts';
import { buildSnapshot, deriveAlerts } from './live/snapshot.ts';
import type { ResolvedPosition } from './live/types.ts';
import type { RealtimeHub } from './ws/hub.ts';

export interface Departure {
  vehicleId: string;
  label: string;
  routeId: string;
  routeShortName: string;
  headsign: string;
  etaLabel: string;
  etaSeconds: number;
  delaySec: number;
  occupancyPercentage: number;
}

export class AppContext {
  /** Seconds after midnight of the most recent ingest batch. */
  private serviceSec = 0;
  private lastIngestAt = 0;
  private snapshot: RealtimeSnapshot | null = null;

  /**
   * Highest stop_sequence already recorded as reached, per trip+vehicle.
   *
   * An arrival must be written exactly once. Positions arrive twice a second and
   * a bus dwells for half a minute, so without this the ground-truth table would
   * fill with sixty duplicate rows per stop.
   */
  private readonly arrivalHighWater = new Map<string, number>();

  constructor(
    readonly feed: TransitFeed,
    readonly liveStore: LiveStore,
    readonly history: HistoryWriter,
    readonly resolver: PositionResolver,
    readonly hub: RealtimeHub,
  ) {}

  markIngest(serviceSec: number): void {
    this.serviceSec = serviceSec;
    this.lastIngestAt = Date.now();
  }

  /** Seconds since the last accepted report, or null if none has arrived. */
  lastIngestAgeSec(): number | null {
    if (this.lastIngestAt === 0) return null;
    return Math.round((Date.now() - this.lastIngestAt) / 1000);
  }

  currentServiceSec(): number {
    return this.serviceSec;
  }

  /** The most recently built snapshot, or an empty one before the first ingest. */
  currentSnapshot(): RealtimeSnapshot {
    return this.snapshot ?? {
      header: {
        gtfsRealtimeVersion: '2.0',
        incrementality: 'FULL_DATASET',
        timestamp: Math.floor(Date.now() / 1000),
      },
      vehiclePositions: [],
      tripUpdates: [],
      alerts: [],
    };
  }

  /** Rebuild the snapshot from live state and push it to subscribers. */
  async tick(): Promise<void> {
    const positions = await this.liveStore.all();
    const timestamp = Math.floor(Date.now() / 1000);

    this.snapshot = buildSnapshot(this.feed, positions, {
      timestamp,
      serviceSec: this.serviceSec,
      alerts: deriveAlerts(this.feed, positions, timestamp),
    });

    this.hub.broadcast(this.snapshot);
  }

  /**
   * Write an arrival row the first time a vehicle passes each stop.
   *
   * This is the ground truth the arrival model is scored against. Without it,
   * Phase 3 has predictions and no way to tell whether they were any good.
   */
  recordArrivalIfReached(position: ResolvedPosition): void {
    if (!this.history.enabled) return;

    const trip = this.feed.trips.get(position.tripId);
    if (!trip) return;

    const key = `${position.tripId}:${position.vehicleId}`;
    const reachedIndex = position.stopIndex - 1;
    if (reachedIndex < 0) return;

    const previous = this.arrivalHighWater.get(key) ?? -1;
    if (reachedIndex <= previous) return;
    this.arrivalHighWater.set(key, reachedIndex);

    // Bound the map: a long-running server would otherwise accumulate an entry
    // for every trip of every service day it has seen.
    if (this.arrivalHighWater.size > 5000) {
      const oldest = this.arrivalHighWater.keys().next().value;
      if (oldest !== undefined) this.arrivalHighWater.delete(oldest);
    }

    const stopTime = trip.stopTimes[reachedIndex];
    if (!stopTime) return;

    const midnight = Math.floor(Date.now() / 1000) - this.serviceSec;
    void this.history.recordArrival({
      vehicleId: position.vehicleId,
      tripId: position.tripId,
      routeId: position.routeId,
      stopId: stopTime.stop_id,
      stopSequence: stopTime.stop_sequence,
      scheduledAt: midnight + stopTime.arrival_time,
      observedAt: position.timestamp,
      delaySec: Math.round(position.delaySec),
    });
  }

  /**
   * Next departures from a stop, across every route that serves it.
   *
   * Walks live trip updates rather than the timetable, so the times reflect where
   * the buses actually are.
   */
  async departuresForStop(stopId: string, limit: number): Promise<Departure[]> {
    const snapshot = this.currentSnapshot();
    const now = snapshot.header.timestamp;
    const byVehicle = new Map(snapshot.vehiclePositions.map((vp) => [vp.vehicle.id, vp]));
    const out: Departure[] = [];

    for (const update of snapshot.tripUpdates) {
      const stu = update.stopTimeUpdate.find((s) => s.stopId === stopId);
      if (!stu) continue;

      const secondsAway = stu.arrival.time - now;
      // Drop predictions already in the past by more than a minute: the bus has
      // been and gone.
      if (secondsAway < -60) continue;

      const route = this.feed.routes.get(update.trip.routeId);
      const trip = this.feed.trips.get(update.trip.tripId);
      const vp = byVehicle.get(update.vehicle.id);

      out.push({
        vehicleId: update.vehicle.id,
        label: update.vehicle.label,
        routeId: update.trip.routeId,
        routeShortName: route?.route_short_name ?? update.trip.routeId,
        headsign: trip?.trip.trip_headsign ?? '',
        etaLabel: presentEta(stu, now).label,
        etaSeconds: secondsAway,
        delaySec: update.delay,
        occupancyPercentage: vp?.occupancyPercentage ?? 0,
      });
    }

    out.sort((a, b) => a.etaSeconds - b.etaSeconds);
    return out.slice(0, limit);
  }

  startBroadcasting(): NodeJS.Timeout {
    const interval = Math.max(100, Math.round(1000 / config.broadcastHz));
    const timer = setInterval(() => {
      void this.tick().catch(() => { /* a failed tick must not stop the timer */ });
    }, interval);
    timer.unref();
    return timer;
  }
}
