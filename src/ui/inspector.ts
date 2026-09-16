/**
 * Vehicle inspector panel.
 *
 * The prototype's detail box listed static attributes -- driver name, raw
 * coordinates -- and no arrival times. This version leads with the upcoming-stops
 * board, because a predicted arrival is the reason anyone opens a bus tracker,
 * and shows each prediction with its confidence rather than as a bare number.
 */

import type { VehicleView } from '../state/store.ts';

export interface InspectorOptions {
  onClose: () => void;
}

interface StopRowHandle {
  root: HTMLElement;
  name: HTMLElement;
  eta: HTMLElement;
  band: HTMLElement;
  prev: Record<string, string>;
}

export class Inspector {
  private readonly root: HTMLElement;
  private readonly opts: InspectorOptions;
  private readonly el: Record<string, HTMLElement>;
  private readonly stopRows = new Map<string, StopRowHandle>();
  private readonly stopList: HTMLElement;
  private prev: Record<string, string> = {};

  constructor(root: HTMLElement, opts: InspectorOptions) {
    this.root = root;
    this.opts = opts;

    this.el = {
      label: root.querySelector<HTMLElement>('[data-field="label"]')!,
      badge: root.querySelector<HTMLElement>('[data-field="badge"]')!,
      headsign: root.querySelector<HTMLElement>('[data-field="headsign"]')!,
      adherence: root.querySelector<HTMLElement>('[data-field="adherence"]')!,
      progressFill: root.querySelector<HTMLElement>('[data-field="progressFill"]')!,
      progressThumb: root.querySelector<HTMLElement>('[data-field="progressThumb"]')!,
      origin: root.querySelector<HTMLElement>('[data-field="origin"]')!,
      destination: root.querySelector<HTMLElement>('[data-field="destination"]')!,
      speed: root.querySelector<HTMLElement>('[data-field="speed"]')!,
      occupancy: root.querySelector<HTMLElement>('[data-field="occupancy"]')!,
      status: root.querySelector<HTMLElement>('[data-field="status"]')!,
      trip: root.querySelector<HTMLElement>('[data-field="trip"]')!,
    };
    this.stopList = root.querySelector<HTMLElement>('[data-field="stops"]')!;

    root.querySelector<HTMLButtonElement>('[data-action="close"]')!
      .addEventListener('click', () => this.opts.onClose());
  }

  hide(): void {
    this.root.hidden = true;
    this.stopRows.clear();
    this.stopList.replaceChildren();
    this.prev = {};
  }

  show(v: VehicleView): void {
    const wasHidden = this.root.hidden;
    this.root.hidden = false;
    // A different bus means the stop board is for a different trip entirely.
    if (this.prev['vehicleId'] !== v.vehicleId) {
      this.stopRows.clear();
      this.stopList.replaceChildren();
      this.prev = {};
    }
    this.update(v);
    if (wasHidden) this.root.querySelector<HTMLElement>('[data-action="close"]')?.focus();
  }

  update(v: VehicleView): void {
    const set = (key: string, el: HTMLElement, value: string): void => {
      if (this.prev[key] === value) return;
      this.prev[key] = value;
      el.textContent = value;
    };

    this.prev['vehicleId'] = v.vehicleId;

    set('label', this.el['label']!, v.label);
    set('badge', this.el['badge']!, v.routeShortName);
    set('headsign', this.el['headsign']!, `To ${v.headsign}`);
    set('origin', this.el['origin']!, v.originName);
    set('destination', this.el['destination']!, v.headsign);
    set('trip', this.el['trip']!, v.tripId);
    set('speed', this.el['speed']!,
      v.awaitingDeparture ? 'At terminus'
        : v.currentStatus === 'STOPPED_AT' ? 'At stop'
        : `${Math.round(v.speedKph)} km/h`);
    set('occupancy', this.el['occupancy']!,
      `${v.occupancyPercentage}% · ${humaniseOccupancy(v.occupancyStatus)}`);
    set('status', this.el['status']!, humaniseStatus(v.currentStatus));

    const delayMinutes = Math.round(Math.abs(v.delaySec) / 60);
    const adherenceText = v.awaitingDeparture
      ? 'Awaiting departure'
      : v.adherence === 'on-time'
        ? 'On time'
        : `${delayMinutes} min ${v.adherence === 'late' ? 'late' : 'early'}`;
    set('adherence', this.el['adherence']!, adherenceText);
    if (this.prev['adherenceState'] !== v.adherence) {
      this.prev['adherenceState'] = v.adherence;
      this.el['adherence']!.dataset['state'] = v.adherence;
    }

    if (this.prev['color'] !== v.routeColor) {
      this.prev['color'] = v.routeColor;
      this.root.style.setProperty('--vehicle-color', v.routeColor);
    }

    const pct = v.progressPct.toFixed(1);
    if (this.prev['progress'] !== pct) {
      this.prev['progress'] = pct;
      this.el['progressFill']!.style.width = `${pct}%`;
      this.el['progressThumb']!.style.left = `${pct}%`;
      this.root.querySelector('[data-field="progressTrack"]')!
        .setAttribute('aria-valuenow', String(Math.round(v.progressPct)));
    }

    this.renderStops(v);
  }

  /** Upcoming-stops board, reconciled by stop sequence. */
  private renderStops(v: VehicleView): void {
    const upcoming = v.upcoming.slice(0, 8);
    const seen = new Set<string>();

    for (const stop of upcoming) {
      const key = `${stop.stopId}-${stop.eta.secondsAway > -600 ? 'a' : 'b'}`;
      seen.add(key);

      let row = this.stopRows.get(key);
      if (!row) {
        row = this.createStopRow();
        this.stopRows.set(key, row);
        this.stopList.append(row.root);
      }

      if (row.prev['name'] !== stop.stopName) {
        row.prev['name'] = stop.stopName;
        row.name.textContent = stop.stopName;
      }
      if (row.prev['eta'] !== stop.eta.label) {
        row.prev['eta'] = stop.eta.label;
        row.eta.textContent = stop.eta.label;
      }

      // Show the confidence band rather than implying the minute figure is exact.
      const band = `±${Math.max(1, Math.round(stop.eta.uncertaintySec / 60))} min`;
      if (row.prev['band'] !== band) {
        row.prev['band'] = band;
        row.band.textContent = band;
      }
      if (row.prev['confidence'] !== stop.eta.confidence) {
        row.prev['confidence'] = stop.eta.confidence;
        row.eta.dataset['confidence'] = stop.eta.confidence;
      }
    }

    for (const [key, row] of this.stopRows) {
      if (seen.has(key)) continue;
      row.root.remove();
      this.stopRows.delete(key);
    }

    // Keep DOM order aligned with arrival order.
    let expected = this.stopList.firstElementChild;
    for (const stop of upcoming) {
      const key = `${stop.stopId}-${stop.eta.secondsAway > -600 ? 'a' : 'b'}`;
      const row = this.stopRows.get(key);
      if (!row) continue;
      if (row.root !== expected) this.stopList.insertBefore(row.root, expected);
      else expected = row.root.nextElementSibling;
    }
  }

  private createStopRow(): StopRowHandle {
    const root = document.createElement('li');
    root.className = 'stop-row';
    root.innerHTML = `
      <span class="stop-row__marker" aria-hidden="true"></span>
      <span class="stop-row__name"></span>
      <span class="stop-row__times">
        <span class="stop-row__eta"></span>
        <span class="stop-row__band"></span>
      </span>`;

    return {
      root,
      name: root.querySelector<HTMLElement>('.stop-row__name')!,
      eta: root.querySelector<HTMLElement>('.stop-row__eta')!,
      band: root.querySelector<HTMLElement>('.stop-row__band')!,
      prev: {},
    };
  }
}

function humaniseStatus(status: VehicleView['currentStatus']): string {
  switch (status) {
    case 'STOPPED_AT': return 'At stop';
    case 'INCOMING_AT': return 'Arriving';
    case 'IN_TRANSIT_TO': return 'In transit';
  }
}

function humaniseOccupancy(status: VehicleView['occupancyStatus']): string {
  switch (status) {
    case 'EMPTY': return 'Empty';
    case 'MANY_SEATS_AVAILABLE': return 'Many seats';
    case 'FEW_SEATS_AVAILABLE': return 'Few seats';
    case 'STANDING_ROOM_ONLY': return 'Standing only';
    case 'CRUSHED_STANDING_ROOM_ONLY': return 'Very crowded';
    case 'FULL': return 'Full';
    case 'NOT_ACCEPTING_PASSENGERS': return 'Not boarding';
  }
}
