/**
 * Runs the vehicle simulator and posts position reports to the ingest API.
 *
 * The simulator is now a *client* of the server, not part of it. It holds no
 * privileged access: it authenticates with the same bearer token a driver's phone
 * would, posts to the same endpoint, and sends only what a device can actually
 * observe -- a GPS fix, a heading, a speed, a trip assignment.
 *
 * Everything else -- distance along the route, delay, arrival predictions -- is
 * derived by the server from the timetable. That separation is the whole point of
 * Phase 2: replacing this worker with real buses changes nothing downstream.
 */

import {
  SimulatedFeedSource,
  CAPACITY_BY_ROUTE,
  mulberry32,
  type TransitFeed,
} from '@citybus/shared';

import { config } from '../config.ts';
import type { VehicleReport } from '../live/types.ts';

const SERVICE_START_SEC = 5.5 * 3600;
const SERVICE_END_SEC = 22.5 * 3600;

export interface SimulatorWorkerOptions {
  baseUrl: string;
  token: string;
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export class SimulatorWorker {
  private readonly source: SimulatedFeedSource;
  private readonly rng: () => number;
  private timer: NodeJS.Timeout | null = null;
  private lastTickMs = 0;
  private registered = false;
  private consecutiveFailures = 0;

  constructor(
    feed: TransitFeed,
    private readonly opts: SimulatorWorkerOptions,
  ) {
    this.source = new SimulatedFeedSource(feed, {
      startSec: initialServiceSeconds(),
      timeScale: config.simulator.timeScale,
      snapshotHz: config.simulator.reportHz,
      seed: config.simulator.seed,
      capacityByRoute: CAPACITY_BY_ROUTE,
    });
    this.rng = mulberry32(config.simulator.seed ^ 0x5f3759df);
  }

  start(): void {
    if (this.timer) return;
    this.lastTickMs = Date.now();

    const intervalMs = Math.max(100, Math.round(1000 / config.simulator.reportHz));
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();

    this.opts.log.info(
      `[simulator] ${this.source.fleetSize} vehicles, ${config.simulator.timeScale}x time scale, ` +
      `${config.simulator.reportHz} Hz reporting, ${config.simulator.gpsNoiseM} m GPS noise`,
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    // Clamp the delta so a stalled event loop does not replay minutes in one step.
    const elapsedSec = Math.min(2, (now - this.lastTickMs) / 1000);
    this.lastTickMs = now;

    this.source.advance(elapsedSec * config.simulator.timeScale);

    if (!this.registered) {
      await this.registerVehicles();
      this.registered = true;
    }

    const snapshot = this.source.snapshot();
    const reports: VehicleReport[] = snapshot.vehiclePositions.map((vp) => {
      const capacity = CAPACITY_BY_ROUTE[vp.trip.routeId] ?? 50;
      const noisy = this.addGpsNoise(vp.position.latitude, vp.position.longitude);

      return {
        vehicleId: vp.vehicle.id,
        label: vp.vehicle.label,
        tripId: vp.trip.tripId,
        latitude: noisy.lat,
        longitude: noisy.lng,
        bearing: Math.round(vp.position.bearing),
        speedMps: Number(vp.position.speed.toFixed(2)),
        occupancy: Math.round((vp.occupancyPercentage / 100) * capacity),
        capacity,
        timestamp: vp.timestamp,
      };
    });

    if (reports.length === 0) return;

    await this.post('/api/ingest', { reports, serviceSec: Math.floor(this.source.simSec) });
  }

  /**
   * Perturb the position with Gaussian error.
   *
   * A simulator that reports exact positions is a simulator that hides bugs: the
   * server's projection, off-route detection and delay calculation all have to
   * cope with noisy fixes, because real GPS in a city is routinely tens of metres
   * out. Better to find that here than in production.
   */
  private addGpsNoise(lat: number, lng: number): { lat: number; lng: number } {
    const sigma = config.simulator.gpsNoiseM;
    if (sigma <= 0) return { lat, lng };

    // Box-Muller, giving two independent normal samples for the two axes.
    const u1 = Math.max(Number.EPSILON, this.rng());
    const u2 = this.rng();
    const magnitude = sigma * Math.sqrt(-2 * Math.log(u1));
    const northM = magnitude * Math.cos(2 * Math.PI * u2);
    const eastM = magnitude * Math.sin(2 * Math.PI * u2);

    const metresPerDegLat = 111_320;
    const metresPerDegLng = metresPerDegLat * Math.cos((lat * Math.PI) / 180);

    return {
      lat: lat + northM / metresPerDegLat,
      lng: lng + eastM / metresPerDegLng,
    };
  }

  private async registerVehicles(): Promise<void> {
    const vehicles = this.source.snapshot().vehiclePositions.map((vp) => ({
      vehicleId: vp.vehicle.id,
      registration: vp.vehicle.label,
      capacity: CAPACITY_BY_ROUTE[vp.trip.routeId] ?? 50,
    }));
    if (vehicles.length === 0) {
      this.registered = false; // Retry on the next tick, once buses are in service.
      return;
    }
    await this.post('/api/vehicles/register', { vehicles });
  }

  private async post(path: string, body: unknown): Promise<void> {
    try {
      const res = await fetch(`${this.opts.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        this.reportFailure(`${path} responded ${res.status}`);
        return;
      }
      this.consecutiveFailures = 0;
    } catch (error) {
      this.reportFailure(`${path} failed: ${(error as Error).message}`);
    }
  }

  /** Log the first few failures, then go quiet to avoid flooding the log. */
  private reportFailure(message: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures <= 3) this.opts.log.warn(`[simulator] ${message}`);
    else if (this.consecutiveFailures === 4) {
      this.opts.log.error('[simulator] repeated ingest failures — suppressing further messages');
    }
  }
}

/** Start at the current local time of day, or the morning peak if out of service hours. */
function initialServiceSeconds(): number {
  const now = new Date();
  const seconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  if (seconds < SERVICE_START_SEC || seconds > SERVICE_END_SEC) return 8 * 3600;
  return seconds;
}
