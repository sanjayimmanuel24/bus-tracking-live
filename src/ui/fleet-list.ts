/**
 * Fleet list.
 *
 * RENDERING CONTRACT: reconcile, never rebuild.
 *
 * The prototype ran `list.innerHTML = ''` followed by a full rebuild on every
 * simulation tick. Emptying a scroll container collapses its scrollHeight, which
 * resets `scrollTop` to 0 -- so the list snapped back to the top roughly once a
 * second and could not be scrolled at all. It also destroyed focus, discarded any
 * text selection, and made keyboard navigation impossible.
 *
 * This version keeps one DOM node per vehicle, keyed by vehicle ID, and writes
 * only the fields whose values actually changed. Scroll position, focus and
 * selection all survive an update.
 */

import type { VehicleView } from '../state/store.ts';

interface CardHandle {
  root: HTMLElement;
  accent: HTMLElement;
  label: HTMLElement;
  badge: HTMLElement;
  headsign: HTMLElement;
  etaValue: HTMLElement;
  etaStop: HTMLElement;
  adherence: HTMLElement;
  speed: HTMLElement;
  occupancyFill: HTMLElement;
  occupancyText: HTMLElement;
  /** Last rendered values, to skip no-op DOM writes. */
  prev: Record<string, string>;
}

export interface FleetListOptions {
  onSelect: (vehicleId: string) => void;
}

export class FleetList {
  private readonly container: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly opts: FleetListOptions;
  private readonly cards = new Map<string, CardHandle>();
  private selectedId: string | null = null;

  constructor(container: HTMLElement, emptyState: HTMLElement, opts: FleetListOptions) {
    this.container = container;
    this.emptyState = emptyState;
    this.opts = opts;
  }

  render(vehicles: VehicleView[], selectedId: string | null): void {
    this.selectedId = selectedId;
    this.emptyState.hidden = vehicles.length > 0;

    const seen = new Set<string>();
    for (const v of vehicles) {
      seen.add(v.vehicleId);
      let card = this.cards.get(v.vehicleId);
      if (!card) {
        card = this.createCard(v);
        this.cards.set(v.vehicleId, card);
      }
      this.updateCard(card, v);
    }

    for (const [id, card] of this.cards) {
      if (seen.has(id)) continue;
      card.root.remove();
      this.cards.delete(id);
    }

    this.reorder(vehicles);
  }

  /**
   * Bring DOM order in line with the sorted vehicle list, moving as few nodes as
   * possible. Vehicles are sorted stably upstream, so in the steady state this
   * loop performs no moves at all.
   */
  private reorder(vehicles: VehicleView[]): void {
    let expected = this.container.firstElementChild;
    for (const v of vehicles) {
      const card = this.cards.get(v.vehicleId);
      if (!card) continue;
      if (card.root !== expected) {
        this.container.insertBefore(card.root, expected);
      } else {
        expected = card.root.nextElementSibling;
      }
    }
  }

  private createCard(v: VehicleView): CardHandle {
    const root = document.createElement('article');
    root.className = 'bus-card';
    root.tabIndex = 0;
    root.setAttribute('role', 'button');

    // Structure is built once; every later update writes text, not markup. Using
    // textContent throughout also means a stop name containing markup -- entirely
    // possible once names come from a live agency feed -- can never be injected.
    root.innerHTML = `
      <span class="bus-card__accent" aria-hidden="true"></span>
      <div class="bus-card__top">
        <span class="bus-card__label"></span>
        <span class="bus-card__badge"></span>
      </div>
      <div class="bus-card__headsign"></div>
      <div class="bus-card__eta">
        <span class="bus-card__eta-value"></span>
        <span class="bus-card__eta-stop"></span>
      </div>
      <div class="bus-card__meta">
        <span class="bus-card__adherence"></span>
        <span class="bus-card__speed"></span>
      </div>
      <div class="bus-card__occupancy" role="img">
        <div class="bus-card__occupancy-track"><div class="bus-card__occupancy-fill"></div></div>
        <span class="bus-card__occupancy-text"></span>
      </div>`;

    const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;

    const activate = () => this.opts.onSelect(v.vehicleId);
    root.addEventListener('click', activate);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });

    return {
      root,
      accent: q('.bus-card__accent'),
      label: q('.bus-card__label'),
      badge: q('.bus-card__badge'),
      headsign: q('.bus-card__headsign'),
      etaValue: q('.bus-card__eta-value'),
      etaStop: q('.bus-card__eta-stop'),
      adherence: q('.bus-card__adherence'),
      speed: q('.bus-card__speed'),
      occupancyFill: q('.bus-card__occupancy-fill'),
      occupancyText: q('.bus-card__occupancy-text'),
      prev: {},
    };
  }

  private updateCard(card: CardHandle, v: VehicleView): void {
    const set = (key: string, el: HTMLElement, value: string): void => {
      if (card.prev[key] === value) return;
      card.prev[key] = value;
      el.textContent = value;
    };

    set('label', card.label, v.label);
    set('badge', card.badge, v.routeShortName);
    set('headsign', card.headsign, `To ${v.headsign}`);
    set('etaStop', card.etaStop, v.nextStopName);
    set('etaValue', card.etaValue, v.nextStopEta?.label ?? '—');
    set('speed', card.speed, describeMotion(v));
    set('adherence', card.adherence, adherenceText(v));
    set('occupancyText', card.occupancyText, `${v.occupancyPercentage}%`);

    if (card.prev['color'] !== v.routeColor) {
      card.prev['color'] = v.routeColor;
      card.accent.style.backgroundColor = v.routeColor;
      card.badge.style.color = v.routeColor;
      card.badge.style.backgroundColor = `${v.routeColor}18`;
    }

    const occupancy = String(Math.min(100, v.occupancyPercentage));
    if (card.prev['occupancy'] !== occupancy) {
      card.prev['occupancy'] = occupancy;
      card.occupancyFill.style.width = `${occupancy}%`;
      card.occupancyFill.dataset['level'] = occupancyLevel(v.occupancyPercentage);
      card.root.querySelector('.bus-card__occupancy')!
        .setAttribute('aria-label', `Occupancy ${v.occupancyPercentage} percent of seated capacity`);
    }

    if (card.prev['adherenceState'] !== v.adherence) {
      card.prev['adherenceState'] = v.adherence;
      card.adherence.dataset['state'] = v.adherence;
    }

    const confidence = v.nextStopEta?.confidence ?? 'low';
    if (card.prev['confidence'] !== confidence) {
      card.prev['confidence'] = confidence;
      card.etaValue.dataset['confidence'] = confidence;
    }

    card.root.classList.toggle('is-selected', this.selectedId === v.vehicleId);
    card.root.setAttribute(
      'aria-label',
      `Bus ${v.label}, route ${v.routeShortName} to ${v.headsign}. ` +
      `Next stop ${v.nextStopName}, ${v.nextStopEta?.label ?? 'unknown'}. ${adherenceText(v)}.`,
    );
  }
}

function describeMotion(v: VehicleView): string {
  if (v.awaitingDeparture) return 'At terminus';
  if (v.currentStatus === 'STOPPED_AT') return 'At stop';
  return `${Math.round(v.speedKph)} km/h`;
}

function adherenceText(v: VehicleView): string {
  if (v.awaitingDeparture) return 'Departing soon';
  const minutes = Math.round(Math.abs(v.delaySec) / 60);
  if (v.adherence === 'late') return `${minutes} min late`;
  if (v.adherence === 'early') return `${minutes} min early`;
  return 'On time';
}

function occupancyLevel(percentage: number): string {
  if (percentage >= 100) return 'high';
  if (percentage >= 70) return 'medium';
  return 'low';
}
