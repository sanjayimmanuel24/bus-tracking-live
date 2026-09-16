/**
 * Route sidebar: per-route visibility toggles and a stop-sequence strip.
 *
 * Route metadata is static, so the markup is built once. Only the live vehicle
 * count and the toggle state change afterwards.
 */

import type { RouteView } from '../state/store.ts';

export interface RouteListOptions {
  onToggle: (routeId: string, visible: boolean) => void;
  onIsolate: (routeId: string) => void;
}

interface RouteHandle {
  root: HTMLElement;
  toggle: HTMLButtonElement;
  count: HTMLElement;
  prevCount: string;
}

export class RouteList {
  private readonly container: HTMLElement;
  private readonly opts: RouteListOptions;
  private readonly handles = new Map<string, RouteHandle>();

  constructor(container: HTMLElement, opts: RouteListOptions) {
    this.container = container;
    this.opts = opts;
  }

  build(routes: RouteView[], visible: Set<string>): void {
    this.container.replaceChildren();
    this.handles.clear();

    for (const route of routes) {
      const root = document.createElement('article');
      root.className = 'route-item';

      const head = document.createElement('div');
      head.className = 'route-item__head';

      const identity = document.createElement('button');
      identity.className = 'route-item__identity';
      identity.type = 'button';
      identity.title = `Show only route ${route.shortName}`;
      identity.addEventListener('click', () => this.opts.onIsolate(route.routeId));

      const number = document.createElement('span');
      number.className = 'route-item__number';
      number.textContent = route.shortName;
      number.style.color = route.color;

      const count = document.createElement('span');
      count.className = 'route-item__count';

      identity.append(number, count);

      const toggle = document.createElement('button');
      toggle.className = 'route-item__toggle';
      toggle.type = 'button';
      toggle.style.setProperty('--route-color', route.color);
      toggle.setAttribute('role', 'switch');
      toggle.addEventListener('click', () => {
        const next = toggle.getAttribute('aria-checked') !== 'true';
        this.opts.onToggle(route.routeId, next);
      });

      head.append(identity, toggle);

      const path = document.createElement('p');
      path.className = 'route-item__path';
      path.textContent = route.longName;

      const strip = document.createElement('ol');
      strip.className = 'route-item__strip';
      strip.setAttribute('aria-label', `Stops on route ${route.shortName}`);

      route.stopNames.forEach((name, i) => {
        const node = document.createElement('li');
        node.className = 'route-item__stop';
        const isTerminus = i === 0 || i === route.stopNames.length - 1;

        const dot = document.createElement('span');
        dot.className = 'route-item__dot';
        dot.style.borderColor = route.color;
        if (isTerminus) dot.style.backgroundColor = route.color;

        const text = document.createElement('span');
        text.className = 'route-item__stop-name';
        text.textContent = name;
        text.title = name;

        node.append(dot, text);
        strip.append(node);
      });

      root.append(head, path, strip);
      this.container.append(root);

      this.handles.set(route.routeId, { root, toggle, count, prevCount: '' });
      this.setVisible(route.routeId, visible.has(route.routeId), route.shortName);
    }
  }

  update(routes: RouteView[], visible: Set<string>): void {
    for (const route of routes) {
      const handle = this.handles.get(route.routeId);
      if (!handle) continue;

      const text = route.activeVehicles === 1 ? '1 bus' : `${route.activeVehicles} buses`;
      if (handle.prevCount !== text) {
        handle.prevCount = text;
        handle.count.textContent = text;
      }
      this.setVisible(route.routeId, visible.has(route.routeId), route.shortName);
    }
  }

  private setVisible(routeId: string, isVisible: boolean, shortName: string): void {
    const handle = this.handles.get(routeId);
    if (!handle) return;
    handle.root.classList.toggle('is-dimmed', !isVisible);
    handle.toggle.setAttribute('aria-checked', String(isVisible));
    handle.toggle.setAttribute(
      'aria-label',
      `${isVisible ? 'Hide' : 'Show'} route ${shortName} on the map`,
    );
  }
}
