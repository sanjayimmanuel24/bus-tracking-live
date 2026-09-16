/**
 * WebSocket fanout.
 *
 * VIEWPORT-SCOPED SUBSCRIPTIONS: a client declares the map area it is looking at
 * and which routes it wants, and receives only vehicles matching. At 48 buses
 * this is an optimisation; at city scale it is the difference between a usable
 * product and one that ships several megabytes a minute to a phone showing six
 * streets. Building it in now means the client already speaks the protocol when
 * the fleet grows.
 *
 * Messages are newline-free JSON objects with a `type` discriminator. Anything a
 * client sends is untrusted input and is validated before it touches state.
 */

import type { WebSocket } from 'ws';
import { z } from 'zod';

import type { RealtimeSnapshot, ServiceAlert } from '@citybus/shared';

/** [west, south, east, north] in degrees. */
const BBox = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    /** Omit to receive the whole network. */
    bbox: BBox.optional(),
    /** Omit to receive every route. */
    routes: z.array(z.string().max(64)).max(200).optional(),
  }),
  z.object({ type: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

interface Subscription {
  socket: WebSocket;
  bbox: [number, number, number, number] | null;
  routes: Set<string> | null;
  /** Skip a send when nothing in this client's view changed. */
  lastPayloadHash: string;
}

export class RealtimeHub {
  private readonly clients = new Map<WebSocket, Subscription>();

  get clientCount(): number {
    return this.clients.size;
  }

  add(socket: WebSocket): void {
    this.clients.set(socket, { socket, bbox: null, routes: null, lastPayloadHash: '' });

    socket.on('message', (raw: unknown) => this.onMessage(socket, raw));
    socket.on('close', () => this.clients.delete(socket));
    // Without a handler, a socket error is an unhandled 'error' event and takes
    // the process down.
    socket.on('error', () => this.clients.delete(socket));
  }

  private onMessage(socket: WebSocket, raw: unknown): void {
    const subscription = this.clients.get(socket);
    if (!subscription) return;

    let parsed: ClientMessage;
    try {
      const text = typeof raw === 'string' ? raw : String(raw);
      // Cheap guard against a client streaming megabytes at us.
      if (text.length > 8192) return;
      parsed = ClientMessage.parse(JSON.parse(text));
    } catch {
      // Malformed input is ignored rather than closing the socket: a client bug
      // should not cost the user their live map.
      return;
    }

    if (parsed.type === 'ping') {
      send(socket, { type: 'pong', at: Date.now() });
      return;
    }

    subscription.bbox = parsed.bbox ?? null;
    subscription.routes = parsed.routes && parsed.routes.length > 0
      ? new Set(parsed.routes)
      : null;
    // The next broadcast must go out even if the network state is unchanged,
    // because this client's *view* of it changed.
    subscription.lastPayloadHash = '';
  }

  /** Push a snapshot to every client, filtered to what each asked for. */
  broadcast(snapshot: RealtimeSnapshot): void {
    for (const subscription of this.clients.values()) {
      if (subscription.socket.readyState !== 1 /* OPEN */) continue;

      const filtered = filterSnapshot(snapshot, subscription);
      // Vehicle count and timestamp are enough to detect "nothing moved here".
      const hash = `${filtered.vehiclePositions.length}:${filtered.header.timestamp}`;
      if (hash === subscription.lastPayloadHash) continue;
      subscription.lastPayloadHash = hash;

      send(subscription.socket, { type: 'snapshot', snapshot: filtered });
    }
  }

  closeAll(): void {
    for (const { socket } of this.clients.values()) {
      try { socket.close(1001, 'server shutting down'); } catch { /* already gone */ }
    }
    this.clients.clear();
  }
}

function filterSnapshot(snapshot: RealtimeSnapshot, sub: Subscription): RealtimeSnapshot {
  if (!sub.bbox && !sub.routes) return snapshot;

  const vehiclePositions = snapshot.vehiclePositions.filter((vp) => {
    if (sub.routes && !sub.routes.has(vp.trip.routeId)) return false;
    if (sub.bbox && !withinBBox(vp.position.latitude, vp.position.longitude, sub.bbox)) return false;
    return true;
  });

  // Only ship trip updates for vehicles the client can actually see. This is the
  // bulk of the payload: a trip update carries a prediction per remaining stop.
  const visible = new Set(vehiclePositions.map((vp) => vp.vehicle.id));
  const tripUpdates = snapshot.tripUpdates.filter((u) => visible.has(u.vehicle.id));

  // Alerts are not filtered by viewport: a disruption two stops beyond the edge
  // of the screen is still the rider's problem.
  const alerts: ServiceAlert[] = sub.routes
    ? snapshot.alerts.filter((a) =>
        a.informedEntity.some((e) => !e.routeId || sub.routes!.has(e.routeId)))
    : snapshot.alerts;

  return { header: snapshot.header, vehiclePositions, tripUpdates, alerts };
}

function withinBBox(lat: number, lng: number, bbox: [number, number, number, number]): boolean {
  const [west, south, east, north] = bbox;
  if (lat < south || lat > north) return false;
  // A viewport spanning the antimeridian has west > east and wraps.
  return west <= east ? lng >= west && lng <= east : lng >= west || lng <= east;
}

function send(socket: WebSocket, payload: unknown): void {
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // A send failure means the socket is going away; the close handler cleans up.
  }
}
