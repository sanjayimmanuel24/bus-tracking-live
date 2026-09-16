/**
 * Realtime data over a WebSocket.
 *
 * This is the Phase 2 replacement for the in-browser simulator, and it satisfies
 * the same `FeedSource` interface. Nothing in `src/state/` or `src/ui/` changed
 * when the data moved behind a network boundary -- which was the entire reason
 * for putting the interface there in Phase 1.
 *
 * Adds the concerns a network source has and an in-process one does not:
 * reconnection with backoff, a staleness watchdog, and telling the user honestly
 * when the feed is not live.
 */

import type { FeedSource, RealtimeSnapshot } from '@citybus/shared';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface WebSocketFeedOptions {
  url: string;
  onStateChange?: (state: ConnectionState, detail?: string) => void;
  /** No snapshot for this long means the feed is stale even if the socket is open. */
  stalenessTimeoutMs?: number;
}

/** Reconnect backoff schedule, in milliseconds. Capped so it always retries. */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

export class WebSocketFeedSource implements FeedSource {
  private socket: WebSocket | null = null;
  private listeners = new Set<(snapshot: RealtimeSnapshot) => void>();
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private stalenessTimer: number | null = null;
  private stopped = true;
  private state: ConnectionState = 'offline';

  /** Latest viewport/route filter, re-sent on every reconnect. */
  private subscription: { bbox?: [number, number, number, number]; routes?: string[] } = {};

  constructor(private readonly opts: WebSocketFeedOptions) {}

  subscribe(listener: (snapshot: RealtimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.socket) {
      // Drop handlers first so the close does not schedule a reconnect.
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close(1000, 'client stopping');
      this.socket = null;
    }
    this.setState('offline');
  }

  /**
   * Tell the server which vehicles this client can actually see.
   *
   * At 48 buses the saving is small; at city scale it is the difference between a
   * usable phone client and one streaming the whole fleet to show six streets.
   */
  setViewport(bbox: [number, number, number, number] | null, routes: string[] | null): void {
    this.subscription = {
      ...(bbox ? { bbox } : {}),
      ...(routes && routes.length > 0 ? { routes } : {}),
    };
    this.sendSubscription();
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.opts.url);
    } catch (error) {
      this.scheduleReconnect((error as Error).message);
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setState('live');
      this.sendSubscription();
      this.armStalenessWatchdog();
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // A malformed frame is not worth dropping the connection over.
      }
      if (!isSnapshotMessage(message)) return;

      this.setState('live');
      this.armStalenessWatchdog();
      for (const listener of this.listeners) listener(message.snapshot);
    };

    socket.onerror = () => {
      // The browser gives no useful detail here; 'close' follows and handles it.
    };

    socket.onclose = (event: CloseEvent) => {
      this.socket = null;
      if (this.stopped) return;
      this.scheduleReconnect(`socket closed (${event.code})`);
    };
  }

  private sendSubscription(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify({ type: 'subscribe', ...this.subscription }));
    } catch {
      // The close handler will reconnect.
    }
  }

  private scheduleReconnect(detail: string): void {
    this.clearTimers();
    if (this.stopped) return;

    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.setState('reconnecting', detail);

    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  /**
   * An open socket is not the same as a live feed: the server can stop producing
   * while the connection stays up. Treat silence as an outage and say so.
   */
  private armStalenessWatchdog(): void {
    if (this.stalenessTimer !== null) window.clearTimeout(this.stalenessTimer);
    const timeout = this.opts.stalenessTimeoutMs ?? 15_000;
    this.stalenessTimer = window.setTimeout(() => {
      this.setState('reconnecting', 'no data received');
      this.socket?.close();
    }, timeout);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.stalenessTimer !== null) { window.clearTimeout(this.stalenessTimer); this.stalenessTimer = null; }
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state, detail);
  }
}

function isSnapshotMessage(value: unknown): value is { type: 'snapshot'; snapshot: RealtimeSnapshot } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'snapshot') return false;
  const snapshot = record['snapshot'] as Record<string, unknown> | undefined;
  return (
    typeof snapshot === 'object' && snapshot !== null &&
    Array.isArray(snapshot['vehiclePositions']) &&
    Array.isArray(snapshot['tripUpdates'])
  );
}
