/**
 * In-process per-user event bus.
 *
 * Singleton owned by the web process. Sources of events:
 *  - Chat in-flight: `bookChatService` calls `eventBus.emit(userId, ...)`
 *  - Postgres LISTEN bridge: parses NOTIFY payload and dispatches into bus
 *
 * Subscribers (SSE connections + in-memory snapshot store) register listeners
 * and receive events for the userId they belong to. Cross-user events are
 * impossible by construction — emit() takes a userId and only fans out to
 * listeners registered for that userId.
 *
 * See `docs/research/sse-event-channel.md` §5.2.
 */

import type { EventType, UserEvent } from "./types";

export type EventListener = (event: UserEvent) => void;

interface BusMetrics {
  emittedTotal: number;
  emittedByType: Map<EventType, number>;
  droppedTotal: number; // listener threw
  activeListeners: number;
}

class EventBus {
  private listeners = new Map<string, Set<EventListener>>();
  private metrics: BusMetrics = {
    emittedTotal: 0,
    emittedByType: new Map(),
    droppedTotal: 0,
    activeListeners: 0,
  };

  subscribe(userId: string, listener: EventListener): () => void {
    let bucket = this.listeners.get(userId);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(userId, bucket);
    }
    bucket.add(listener);
    this.metrics.activeListeners += 1;

    return () => {
      const current = this.listeners.get(userId);
      if (!current) return;
      if (current.delete(listener)) {
        this.metrics.activeListeners -= 1;
      }
      if (current.size === 0) {
        this.listeners.delete(userId);
      }
    };
  }

  emit(userId: string, event: UserEvent): void {
    this.metrics.emittedTotal += 1;
    const byType = this.metrics.emittedByType.get(event.type) || 0;
    this.metrics.emittedByType.set(event.type, byType + 1);

    const bucket = this.listeners.get(userId);
    if (!bucket || bucket.size === 0) return;

    // Snapshot the listeners before iterating — listeners may unsubscribe
    // synchronously inside their handler (e.g. on chat.final the BookChat
    // unsubscribes from chat.token). Mutating the Set during iteration would
    // skip listeners or throw in strict mode.
    const snapshot = Array.from(bucket);
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        this.metrics.droppedTotal += 1;
        // Listener crash must never crash the bus. We swallow + count.
      }
    }
  }

  getMetrics(): Readonly<BusMetrics> {
    return {
      emittedTotal: this.metrics.emittedTotal,
      emittedByType: new Map(this.metrics.emittedByType),
      droppedTotal: this.metrics.droppedTotal,
      activeListeners: this.metrics.activeListeners,
    };
  }

  /** Test-only helper — clears all listeners. Not exported from index. */
  __resetForTests(): void {
    this.listeners.clear();
    this.metrics = {
      emittedTotal: 0,
      emittedByType: new Map(),
      droppedTotal: 0,
      activeListeners: 0,
    };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __remarkaEventBus: EventBus | undefined;
}

// Singleton across hot-reloads in dev. In prod (single Node process) this is
// just a module-level singleton.
export const eventBus: EventBus =
  globalThis.__remarkaEventBus ?? (globalThis.__remarkaEventBus = new EventBus());
