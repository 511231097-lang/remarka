/**
 * Postgres LISTEN bridge.
 *
 * Single shared `pg.Client` per web process holds `LISTEN user_events`. On
 * each NOTIFY, parses the JSON payload and dispatches into the in-process
 * EventBus filtered by userId. This means: on N concurrent SSE clients we
 * still hold ONE postgres connection for cross-process events. Per-connection
 * queries (e.g. session resolution) use the regular Prisma pool.
 *
 * Reconnect strategy: exponential backoff (capped at 30s) with jitter.
 *
 * See `docs/research/sse-event-channel.md` §5.3.
 */

import { Client as PgClient } from "pg";

import { eventBus } from "./bus";
import { nextEventId } from "./eventId";
import {
  USER_EVENTS_CHANNEL,
  type EventType,
  type NotifyPayload,
  type UserEvent,
} from "./types";

interface BridgeMetrics {
  notifyReceivedTotal: number;
  notifyParseErrorTotal: number;
  reconnectTotal: number;
  connected: boolean;
  lastError: string | null;
}

const KNOWN_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "chat.token",
  "chat.status",
  "chat.tool",
  "chat.final",
  "chat.error",
  "chat.snapshot",
  "book.analysis.progress",
  "book.analysis.done",
]);

class ListenBridge {
  private client: PgClient | null = null;
  private starting = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private metrics: BridgeMetrics = {
    notifyReceivedTotal: 0,
    notifyParseErrorTotal: 0,
    reconnectTotal: 0,
    connected: false,
    lastError: null,
  };

  async start(connectionString: string): Promise<void> {
    if (this.starting || this.client) return;
    this.starting = true;
    this.stopped = false;

    try {
      const client = new PgClient({ connectionString });
      this.bindClient(client, connectionString);
      await client.connect();
      await client.query(`LISTEN ${USER_EVENTS_CHANNEL}`);
      this.client = client;
      this.metrics.connected = true;
      this.reconnectAttempt = 0;
      this.metrics.lastError = null;
      // eslint-disable-next-line no-console
      console.info("[events.listenBridge] connected and LISTENing on", USER_EVENTS_CHANNEL);
    } catch (error) {
      this.metrics.lastError = error instanceof Error ? error.message : String(error);
      this.metrics.connected = false;
      // eslint-disable-next-line no-console
      console.error("[events.listenBridge] connect failed:", this.metrics.lastError);
      this.scheduleReconnect(connectionString);
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    this.metrics.connected = false;
    if (client) {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }

  getMetrics(): Readonly<BridgeMetrics> {
    return { ...this.metrics };
  }

  private bindClient(client: PgClient, connectionString: string): void {
    client.on("notification", (msg) => {
      if (msg.channel !== USER_EVENTS_CHANNEL || !msg.payload) return;
      this.metrics.notifyReceivedTotal += 1;
      this.dispatchPayload(msg.payload);
    });

    client.on("error", (err) => {
      this.metrics.lastError = err instanceof Error ? err.message : String(err);
      this.metrics.connected = false;
      // eslint-disable-next-line no-console
      console.error("[events.listenBridge] pg client error:", this.metrics.lastError);
      this.client = null;
      this.scheduleReconnect(connectionString);
    });

    client.on("end", () => {
      this.metrics.connected = false;
      if (this.client === client) {
        this.client = null;
        this.scheduleReconnect(connectionString);
      }
    });
  }

  private dispatchPayload(raw: string): void {
    let parsed: NotifyPayload;
    try {
      parsed = JSON.parse(raw) as NotifyPayload;
    } catch {
      this.metrics.notifyParseErrorTotal += 1;
      return;
    }

    const userId = String(parsed.userId || "").trim();
    const type = parsed.type as EventType;
    if (!userId || !KNOWN_EVENT_TYPES.has(type)) {
      this.metrics.notifyParseErrorTotal += 1;
      return;
    }

    const event: UserEvent = {
      id: parsed.id || nextEventId(),
      type,
      ts: parsed.ts || new Date().toISOString(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: parsed.data as any,
    };

    eventBus.emit(userId, event);
  }

  private scheduleReconnect(connectionString: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    this.metrics.reconnectTotal += 1;
    const base = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    const jitter = Math.floor(Math.random() * 250);
    const delay = base + jitter;
    // eslint-disable-next-line no-console
    console.warn(
      `[events.listenBridge] scheduling reconnect attempt #${this.reconnectAttempt} in ${delay}ms`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start(connectionString);
    }, delay);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __remarkaListenBridge: ListenBridge | undefined;
}

export const listenBridge: ListenBridge =
  globalThis.__remarkaListenBridge ??
  (globalThis.__remarkaListenBridge = new ListenBridge());
