/**
 * Header KPI strip and simulation clock.
 *
 * "Avg km/h" in the prototype averaged a number that was not connected to vehicle
 * motion. The figures here all derive from the feed: on-time performance is the
 * share of in-service vehicles within the +/-3 min adherence band, which is the
 * standard transit measure and therefore comparable with a real agency's.
 */

import type { NetworkKpis } from '../state/store.ts';

export class KpiBar {
  private readonly nodes: Record<string, HTMLElement>;
  private readonly clock: HTMLElement;
  private prev: Record<string, string> = {};

  constructor(root: HTMLElement, clock: HTMLElement) {
    this.clock = clock;
    this.nodes = {
      active: root.querySelector<HTMLElement>('[data-kpi="active"]')!,
      onTime: root.querySelector<HTMLElement>('[data-kpi="onTime"]')!,
      late: root.querySelector<HTMLElement>('[data-kpi="late"]')!,
      otp: root.querySelector<HTMLElement>('[data-kpi="otp"]')!,
      speed: root.querySelector<HTMLElement>('[data-kpi="speed"]')!,
    };
  }

  update(kpis: NetworkKpis): void {
    this.set('active', String(kpis.active));
    this.set('onTime', String(kpis.onTime));
    this.set('late', String(kpis.late));
    this.set('otp', `${kpis.onTimePerformance}%`);
    this.set('speed', String(kpis.avgSpeedKph));
  }

  /** `simSec` is seconds after midnight in simulated time. */
  setClock(simSec: number): void {
    const total = Math.floor(simSec) % 86400;
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    const text = `${h}:${m}:${s}`;
    if (this.prev['clock'] === text) return;
    this.prev['clock'] = text;
    this.clock.textContent = text;
  }

  private set(key: string, value: string): void {
    if (this.prev[key] === value) return;
    this.prev[key] = value;
    this.nodes[key]!.textContent = value;
  }
}
