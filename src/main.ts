/**
 * Application entry point: loads the feed, starts a realtime source, and wires
 * the UI to the store.
 *
 * The dependency direction is the point of the whole structure:
 *
 *     GTFS static  ->  Store  <-  GTFS-Realtime (FeedSource)
 *                        |
 *                        v
 *                   UI components
 *
 * `SimulatedFeedSource` is the only thing here that knows the buses are not real.
 * Replacing it with a WebSocket client in Phase 2 touches this file and nothing
 * else.
 */

import 'leaflet/dist/leaflet.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

import { loadFeed } from './gtfs/feed.ts';
import { SimulatedFeedSource } from './realtime/sim/simulator.ts';
import { CAPACITY_BY_ROUTE } from './realtime/sim/config.ts';
import { Store } from './state/store.ts';
import { AlertStack } from './ui/alerts.ts';
import { FleetList } from './ui/fleet-list.ts';
import { Inspector } from './ui/inspector.ts';
import { KpiBar } from './ui/kpi-bar.ts';
import { MapLayer } from './ui/map.ts';
import { RouteList } from './ui/route-list.ts';

const GTFS_URL = `${import.meta.env.BASE_URL}gtfs`.replace(/\/{2,}/g, '/');

/** Service runs 05:30-22:30; outside that window there is nothing to watch. */
const SERVICE_START_SEC = 5.5 * 3600;
const SERVICE_END_SEC = 22.5 * 3600;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el as T;
};

/**
 * Start the clock at the current local time of day so the app feels live on open,
 * falling back to the morning peak when loaded outside service hours.
 */
function initialSimSeconds(): number {
  const now = new Date();
  const secondsToday = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  if (secondsToday < SERVICE_START_SEC || secondsToday > SERVICE_END_SEC) return 8 * 3600;
  return secondsToday;
}

async function boot(): Promise<void> {
  const bootScreen = $('boot');
  const bootText = $('boot-text');
  const feedPill = $('feed-pill');
  const feedPillText = $('feed-pill-text');

  let feed;
  try {
    feed = await loadFeed(GTFS_URL);
  } catch (error) {
    bootText.textContent = `Could not load the GTFS feed. ${(error as Error).message}`;
    feedPill.dataset['state'] = 'error';
    feedPillText.textContent = 'Feed error';
    return;
  }

  bootText.textContent = 'Starting vehicle feed…';

  const store = new Store(feed);

  const source = new SimulatedFeedSource(feed, {
    startSec: initialSimSeconds(),
    timeScale: 8,
    snapshotHz: 2,
    capacityByRoute: CAPACITY_BY_ROUTE,
  });

  // -- UI wiring -----------------------------------------------------------

  const kpiBar = new KpiBar($('kpis'), $('clock'));
  const alertStack = new AlertStack($('alert-stack'));

  const inspector = new Inspector($('inspector'), {
    onClose: () => selectVehicle(null),
  });

  const mapLayer = new MapLayer($('map'), feed, {
    onVehicleClick: (id) => selectVehicle(id, { reveal: true }),
    onBackgroundClick: () => selectVehicle(null),
  });

  const fleetList = new FleetList($('fleet-list'), $('fleet-empty'), {
    onSelect: (id) => selectVehicle(id, { pan: true }),
  });

  const routeList = new RouteList($('route-list'), {
    onToggle: (routeId, visible) => {
      if (visible) store.visibleRoutes.add(routeId);
      else store.visibleRoutes.delete(routeId);
      applyRouteVisibility();
    },
    onIsolate: (routeId) => {
      // Clicking a route number isolates it; clicking again restores everything.
      const isOnlyOne = store.visibleRoutes.size === 1 && store.visibleRoutes.has(routeId);
      store.visibleRoutes = isOnlyOne ? new Set(feed.routeOrder) : new Set([routeId]);
      applyRouteVisibility();
    },
  });

  const routeViews = store.routeViews();
  mapLayer.drawNetwork(routeViews);
  routeList.build(routeViews, store.visibleRoutes);

  function applyRouteVisibility(): void {
    mapLayer.setRouteVisibility(store.visibleRoutes);
    store.notify();
  }

  // -- Selection -----------------------------------------------------------

  function selectVehicle(id: string | null, opts: { pan?: boolean; reveal?: boolean } = {}): void {
    store.selectedVehicleId = id;
    mapLayer.setSelected(id);

    if (!id) {
      inspector.hide();
      store.notify();
      return;
    }

    const vehicle = store.findVehicle(id);
    if (!vehicle) return;

    inspector.show(vehicle);
    if (opts.pan) mapLayer.panTo(vehicle.position);
    if (opts.reveal) {
      switchTab('fleet');
      // Only chase the card when the selection came from the map -- scrolling the
      // list out from under someone who just clicked in it would be hostile.
      window.requestAnimationFrame(() => {
        $('fleet-list').querySelector('.bus-card.is-selected')
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
    store.notify();
  }

  // -- Tabs and the small-screen bottom sheet ------------------------------

  const panel = $('fleet-panel');
  const tabs: Record<string, { tab: HTMLElement; pane: HTMLElement }> = {
    routes: { tab: $('tab-routes'), pane: $('pane-routes') },
    fleet: { tab: $('tab-fleet'), pane: $('pane-fleet') },
  };
  let activeTab = 'routes';

  const isCompact = (): boolean => window.matchMedia('(max-width: 900px)').matches;

  function switchTab(name: string): void {
    activeTab = name;
    for (const [key, { tab, pane }] of Object.entries(tabs)) {
      const on = key === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      pane.classList.toggle('is-active', on);
      pane.hidden = !on;
    }
  }

  for (const [key, { tab }] of Object.entries(tabs)) {
    tab.addEventListener('click', () => {
      // On a phone the panel is a bottom sheet: tapping the active tab collapses
      // or expands it, tapping the other one switches and opens.
      if (isCompact()) {
        if (key === activeTab) panel.classList.toggle('is-open');
        else panel.classList.add('is-open');
      }
      switchTab(key);
    });
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = activeTab === 'routes' ? 'fleet' : 'routes';
      switchTab(next);
      tabs[next]!.tab.focus();
    });
  }

  // -- Search --------------------------------------------------------------

  const search = $<HTMLInputElement>('fleet-search');
  search.addEventListener('input', () => {
    store.fleetQuery = search.value;
    store.notify();
  });

  // -- Route bulk actions --------------------------------------------------

  $('show-all-routes').addEventListener('click', () => {
    store.visibleRoutes = new Set(feed.routeOrder);
    applyRouteVisibility();
  });
  $('hide-all-routes').addEventListener('click', () => {
    store.visibleRoutes = new Set();
    applyRouteVisibility();
  });

  // -- Simulation speed ----------------------------------------------------

  const speedRange = $<HTMLInputElement>('speed-range');
  const speedLabel = $<HTMLOutputElement>('speed-label');
  speedRange.value = String(source.getTimeScale());
  speedLabel.textContent = `${source.getTimeScale()}×`;
  speedRange.addEventListener('input', () => {
    const value = Number(speedRange.value);
    source.setTimeScale(value);
    speedLabel.textContent = `${value}×`;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && store.selectedVehicleId) selectVehicle(null);
  });

  window.addEventListener('resize', () => mapLayer.invalidate());

  // -- Render loop ---------------------------------------------------------

  store.subscribe((snapshot) => {
    kpiBar.update(snapshot.kpis);
    kpiBar.setClock(source.simSec);
    mapLayer.updateVehicles(snapshot.vehicles, store.visibleRoutes);
    fleetList.render(store.filteredVehicles(), store.selectedVehicleId);
    routeList.update(store.routeViews(), store.visibleRoutes);
    alertStack.render(snapshot.alerts);

    if (store.selectedVehicleId) {
      const vehicle = store.findVehicle(store.selectedVehicleId);
      if (vehicle) inspector.update(vehicle);
      else inspector.hide();
    }
  });

  source.subscribe((snapshot) => store.ingest(snapshot));
  source.start();

  feedPillText.textContent = `Live · ${source.fleetSize} buses`;
  mapLayer.setRouteVisibility(store.visibleRoutes);

  bootScreen.classList.add('is-done');
  // Pause the feed when the tab is hidden: a backgrounded tab still runs timers,
  // and there is no reason to burn a phone's battery simulating buses nobody is
  // looking at.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) source.stop();
    else source.start();
  });
}

boot().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start CityBus Live', error);
  const bootText = document.getElementById('boot-text');
  if (bootText) bootText.textContent = `Startup failed: ${(error as Error).message}`;
});
