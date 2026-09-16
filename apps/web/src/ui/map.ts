/**
 * Leaflet map layer.
 *
 * RENDERING CONTRACT: markers are created once and mutated thereafter.
 *
 * The prototype called `L.divIcon()` and `marker.setIcon()` for every bus on every
 * frame, which replaced 31 DOM subtrees 1.3 times a second. Beyond the cost, it
 * restarted the CSS keyframe animation on each marker every frame, so the status
 * pulse never completed a cycle and appeared frozen. Here the icon DOM is built
 * once, references to the mutable parts are kept, and updates touch only the
 * attributes that actually changed.
 */

import L from 'leaflet';

import type { RouteView, VehicleView } from '../state/store.ts';
import type { TransitFeed } from '@citybus/shared';

/** Matches the marker transition duration in the stylesheet. */
const MARKER_TRANSITION_MS = 480;

interface MarkerHandle {
  marker: L.Marker;
  root: HTMLElement;
  body: HTMLElement;
  rotator: HTMLElement;
  labelEl: HTMLElement;
  lastAdherence: string;
  lastLabel: string;
  lastBearing: number;
  lastColor: string;
}

export interface MapLayerOptions {
  onVehicleClick: (vehicleId: string) => void;
  onBackgroundClick: () => void;
  /** Fired (debounced) when the visible area settles, as [west, south, east, north]. */
  onViewportChange?: (bbox: [number, number, number, number]) => void;
}

export class MapLayer {
  private readonly map: L.Map;
  private readonly feed: TransitFeed;
  private readonly opts: MapLayerOptions;
  private readonly markers = new Map<string, MarkerHandle>();
  private readonly routeLines = new Map<string, L.Polyline>();
  private readonly stopLayers = new Map<string, L.CircleMarker[]>();
  private selectedId: string | null = null;

  constructor(container: HTMLElement, feed: TransitFeed, opts: MapLayerOptions) {
    this.feed = feed;
    this.opts = opts;

    this.map = L.map(container, {
      center: [11.0168, 76.9758],
      zoom: 13,
      zoomControl: false,
      // Leaflet's own marker fade fights the CSS transitions used for movement.
      markerZoomAnimation: false,
      preferCanvas: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(this.map);

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    // Suppress movement transitions while zooming, otherwise every marker lerps
    // from its old pixel position to its new one and the whole fleet smears.
    this.map.on('zoomstart', () => container.classList.add('is-zooming'));
    this.map.on('zoomend', () => {
      window.setTimeout(() => container.classList.remove('is-zooming'), MARKER_TRANSITION_MS);
    });

    this.map.on('click', () => this.opts.onBackgroundClick());

    // Debounced: a pan fires 'moveend' once, but a pinch-zoom on a phone fires it
    // repeatedly, and each one would otherwise be a subscription message.
    let viewportTimer: number | undefined;
    const reportViewport = (): void => {
      if (!this.opts.onViewportChange) return;
      window.clearTimeout(viewportTimer);
      viewportTimer = window.setTimeout(() => {
        const bounds = this.map.getBounds().pad(0.25); // Prefetch just beyond the edge.
        this.opts.onViewportChange?.([
          bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
        ]);
      }, 300);
    };
    this.map.on('moveend zoomend', reportViewport);
  }

  /** Draw route geometry and stops once. Only visibility changes afterwards. */
  drawNetwork(routes: RouteView[]): void {
    for (const route of routes) {
      // One line per route: the inbound shape is the outbound reversed, so drawing
      // both would just double the stroke weight.
      const shape = this.feed.shapes.get(`${route.routeId}_D0`);
      if (!shape) continue;

      const line = L.polyline(shape.path.map((p) => [p.lat, p.lng] as L.LatLngTuple), {
        color: route.color,
        weight: 3.5,
        opacity: 0.55,
        // Rounded joins read better than the prototype's dashes once several
        // routes overlap along a shared corridor.
        lineJoin: 'round',
        lineCap: 'round',
      }).addTo(this.map);
      this.routeLines.set(route.routeId, line);

      const stopMarkers: L.CircleMarker[] = [];
      const tripId = this.feed.blocks.get(this.feed.blocksByRoute.get(route.routeId)?.[0] ?? '')?.[0];
      const trip = tripId ? this.feed.trips.get(tripId) : undefined;
      const stopIds = trip ? trip.stopTimes.map((st) => st.stop_id) : [];

      stopIds.forEach((stopId, i) => {
        const stop = this.feed.stops.get(stopId);
        if (!stop) return;
        const isTerminus = i === 0 || i === stopIds.length - 1;

        const marker = L.circleMarker([stop.stop_lat, stop.stop_lon], {
          radius: isTerminus ? 6.5 : 4,
          fillColor: route.color,
          color: '#ffffff',
          weight: isTerminus ? 2.5 : 1.8,
          fillOpacity: isTerminus ? 1 : 0.8,
          interactive: true,
        }).addTo(this.map);

        marker.bindPopup(
          `<strong style="color:${route.color}">${escapeHtml(route.shortName)}</strong> &mdash; ${escapeHtml(stop.stop_name)}` +
          `<br><small>Stop ${i + 1} of ${stopIds.length}${isTerminus ? ' &middot; terminus' : ''}</small>`,
        );
        stopMarkers.push(marker);
      });

      this.stopLayers.set(route.routeId, stopMarkers);
    }
  }

  setRouteVisibility(visible: Set<string>): void {
    for (const [routeId, line] of this.routeLines) {
      const on = visible.has(routeId);
      line.setStyle({ opacity: on ? 0.55 : 0.06 });
      for (const stop of this.stopLayers.get(routeId) ?? []) {
        stop.setStyle({ opacity: on ? 1 : 0.08, fillOpacity: on ? 0.85 : 0.05 });
      }
    }
  }

  /**
   * Reconcile markers against the current vehicle list: add new ones, update
   * existing ones in place, remove vehicles that have left service.
   */
  updateVehicles(vehicles: VehicleView[], visibleRoutes: Set<string>): void {
    const seen = new Set<string>();

    for (const v of vehicles) {
      seen.add(v.vehicleId);
      let handle = this.markers.get(v.vehicleId);
      if (!handle) {
        handle = this.createMarker(v);
        this.markers.set(v.vehicleId, handle);
      }

      handle.marker.setLatLng([v.position.lat, v.position.lng]);

      // Every mutation below is guarded: writing an unchanged value still costs a
      // style recalculation, and with 48 buses at 2Hz that adds up.
      if (handle.lastAdherence !== v.adherence) {
        handle.root.dataset['adherence'] = v.adherence;
        handle.lastAdherence = v.adherence;
      }
      if (handle.lastColor !== v.routeColor) {
        handle.body.style.backgroundColor = v.routeColor;
        handle.lastColor = v.routeColor;
      }
      if (handle.lastLabel !== v.routeShortName) {
        handle.labelEl.textContent = v.routeShortName;
        handle.lastLabel = v.routeShortName;
      }
      // Round the bearing: sub-degree changes are invisible but still repaint.
      const bearing = Math.round(v.bearing);
      if (handle.lastBearing !== bearing) {
        handle.rotator.style.transform = `rotate(${bearing}deg)`;
        handle.lastBearing = bearing;
      }

      const visible = visibleRoutes.has(v.routeId);
      handle.root.classList.toggle('is-hidden', !visible);
      handle.root.classList.toggle('is-selected', this.selectedId === v.vehicleId);
      handle.root.classList.toggle('is-stopped', v.currentStatus === 'STOPPED_AT');
    }

    for (const [id, handle] of this.markers) {
      if (seen.has(id)) continue;
      handle.marker.remove();
      this.markers.delete(id);
    }
  }

  private createMarker(v: VehicleView): MarkerHandle {
    const root = document.createElement('div');
    root.className = 'bus-marker';
    root.dataset['adherence'] = v.adherence;
    root.innerHTML =
      '<div class="bus-marker__ring"></div>' +
      '<div class="bus-marker__rotator"><div class="bus-marker__arrow"></div></div>' +
      '<div class="bus-marker__body"><span class="bus-marker__label"></span></div>';

    const icon = L.divIcon({
      html: root,
      className: 'bus-marker-wrapper',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });

    const marker = L.marker([v.position.lat, v.position.lng], {
      icon,
      zIndexOffset: 500,
      keyboard: true,
      title: `${v.routeShortName} ${v.label}`,
      alt: `Bus ${v.label} on route ${v.routeShortName}`,
    }).addTo(this.map);

    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      this.opts.onVehicleClick(v.vehicleId);
    });

    const body = root.querySelector<HTMLElement>('.bus-marker__body')!;
    const rotator = root.querySelector<HTMLElement>('.bus-marker__rotator')!;
    const labelEl = root.querySelector<HTMLElement>('.bus-marker__label')!;

    body.style.backgroundColor = v.routeColor;
    labelEl.textContent = v.routeShortName;
    rotator.style.transform = `rotate(${Math.round(v.bearing)}deg)`;

    return {
      marker,
      root,
      body,
      rotator,
      labelEl,
      lastAdherence: v.adherence,
      lastLabel: v.routeShortName,
      lastBearing: Math.round(v.bearing),
      lastColor: v.routeColor,
    };
  }

  setSelected(vehicleId: string | null): void {
    this.selectedId = vehicleId;
    for (const [id, handle] of this.markers) {
      handle.root.classList.toggle('is-selected', id === vehicleId);
    }
  }

  panTo(position: { lat: number; lng: number }): void {
    this.map.panTo([position.lat, position.lng], { animate: true, duration: 0.6 });
  }

  invalidate(): void {
    this.map.invalidateSize();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
