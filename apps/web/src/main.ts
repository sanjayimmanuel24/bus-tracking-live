/**
 * Application entry point.
 *
 * PHASE 2: the data now comes from the server.
 *
 *   GTFS static  ──HTTP──►  Store  ◄──WebSocket──  server ◄──ingest── vehicles
 *                             │
 *                             ▼
 *                        UI components
 *
 * Compared with Phase 1 the only change here is which `FeedSource` is constructed
 * and where the timetable is fetched from. `src/state/` and `src/ui/` are
 * untouched, because they only ever spoke GTFS-Realtime.
 */

import 'leaflet/dist/leaflet.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';

import { loadFeed, type TransitFeed } from '@citybus/shared';

import { WebSocketFeedSource, type ConnectionState } from './realtime/websocket-source.ts';
import { Store } from './state/store.ts';
import { AlertStack } from './ui/alerts.ts';
import { FleetList } from './ui/fleet-list.ts';
import { Inspector } from './ui/inspector.ts';
import { KpiBar } from './ui/kpi-bar.ts';
import { MapLayer } from './ui/map.ts';
import { RouteList } from './ui/route-list.ts';

const GTFS_URL = '/api/gtfs';

function websocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el as T;
};

async function boot(): Promise<void> {
  const bootScreen = $('boot');
  const bootText = $('boot-text');
  const feedPill = $('feed-pill');
  const feedPillText = $('feed-pill-text');

  let feed: TransitFeed;
  try {
    feed = await loadFeed(GTFS_URL);
  } catch (error) {
    bootText.textContent =
      `Could not load the timetable from the server. ${(error as Error).message}`;
    feedPill.dataset['state'] = 'error';
    feedPillText.textContent = 'Feed error';
    return;
  }

  bootText.textContent = 'Connecting to the live feed…';

  const store = new Store(feed);

  const source = new WebSocketFeedSource({
    url: websocketUrl(),
    onStateChange: (state, detail) => showConnectionState(state, detail),
  });

  function showConnectionState(state: ConnectionState, detail?: string): void {
    // Never claim the feed is live when it is not: a map full of buses frozen in
    // place is worse than an honest "reconnecting".
    const label: Record<ConnectionState, string> = {
      connecting: 'Connecting…',
      live: 'Live',
      reconnecting: 'Reconnecting…',
      offline: 'Offline',
    };
    feedPill.dataset['state'] = state === 'live' ? 'live' : 'error';
    feedPillText.textContent = label[state];
    if (detail && state !== 'live') feedPill.title = detail;
    else feedPill.removeAttribute('title');
  }

  // -- UI wiring -----------------------------------------------------------

  const kpiBar = new KpiBar($('kpis'), $('clock'));
  const alertStack = new AlertStack($('alert-stack'));

  const inspector = new Inspector($('inspector'), { onClose: () => selectVehicle(null) });

  const mapLayer = new MapLayer($('map'), feed, {
    onVehicleClick: (id) => selectVehicle(id, { reveal: true }),
    onBackgroundClick: () => selectVehicle(null),
    onViewportChange: (bbox) => pushSubscription(bbox),
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
      const isOnlyOne = store.visibleRoutes.size === 1 && store.visibleRoutes.has(routeId);
      store.visibleRoutes = isOnlyOne ? new Set(feed.routeOrder) : new Set([routeId]);
      applyRouteVisibility();
    },
  });

  const routeViews = store.routeViews();
  mapLayer.drawNetwork(routeViews);
  routeList.build(routeViews, store.visibleRoutes);

  let lastViewport: [number, number, number, number] | null = null;

  /**
   * Tell the server what this client can see, so it sends only those vehicles.
   *
   * The route filter is included because hidden routes are genuinely not wanted —
   * no reason to ship them. The viewport is deliberately *not* sent while all
   * routes are visible and the map is zoomed out, since the whole network is the
   * point of the overview.
   */
  function pushSubscription(bbox: [number, number, number, number] | null): void {
    lastViewport = bbox;
    const allRoutesVisible = store.visibleRoutes.size === feed.routeOrder.length;
    source.setViewport(bbox, allRoutesVisible ? null : [...store.visibleRoutes]);
  }

  function applyRouteVisibility(): void {
    mapLayer.setRouteVisibility(store.visibleRoutes);
    pushSubscription(lastViewport);
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && store.selectedVehicleId) selectVehicle(null);
  });

  window.addEventListener('resize', () => mapLayer.invalidate());

  // -- Render loop ---------------------------------------------------------

  store.subscribe((snapshot) => {
    kpiBar.update(snapshot.kpis);
    // The clock now comes from the feed's own timestamp rather than a local
    // simulation clock: the server owns time, and the client reports what it was
    // told.
    kpiBar.setClock(secondsSinceMidnight(snapshot.timestamp));
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

  mapLayer.setRouteVisibility(store.visibleRoutes);
  bootScreen.classList.add('is-done');

  // Drop the socket when the tab is hidden. A backgrounded tab does not need
  // two updates a second, and holding the connection open costs the server a
  // subscriber and the phone its battery.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) source.stop();
    else source.start();
  });

  window.addEventListener('pagehide', () => source.stop());
}

/** Local seconds-after-midnight for a POSIX timestamp, for the header clock. */
function secondsSinceMidnight(posixSeconds: number): number {
  const date = new Date(posixSeconds * 1000);
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

boot().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start CityBus Live', error);
  const bootText = document.getElementById('boot-text');
  if (bootText) bootText.textContent = `Startup failed: ${(error as Error).message}`;
});
