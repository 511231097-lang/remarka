/**
 * Server-side helpers for emitting events.
 *
 * Two flavors:
 *
 *  - emitToUser(userId, type, data): pushes an event into the local
 *    EventBus. Use from the same web process that handles chat streaming.
 *    Sub-millisecond latency. Does NOT cross processes.
 *
 *  - notifyUserEvent(userId, type, data): writes to Postgres NOTIFY
 *    `user_events` channel. Any web process LISTEN'ing on that channel will
 *    pick it up and dispatch into its local bus. Use from the worker (or any
 *    place that doesn't share the EventBus instance with the SSE endpoint).
 *
 * For events that originate inside the web process and only need to reach
 * connected clients of THIS process — prefer emitToUser. For events from the
 * worker — use notifyUserEvent.
 *
 * Phase 1 has a single web instance, so emitToUser is sufficient for all
 * web-originated events. When we go horizontally scaled, we'll need to
 * re-publish web emits via NOTIFY too.
 */

import { prisma } from "@remarka/db";

import { eventBus } from "./bus";
import { nextEventId } from "./eventId";
import {
  USER_EVENTS_CHANNEL,
  type EventDataMap,
  type EventType,
  type UserEvent,
} from "./types";

export function emitToUser<T extends EventType>(
  userId: string,
  type: T,
  data: EventDataMap[T]
): UserEvent<T> {
  const event: UserEvent<T> = {
    id: nextEventId(),
    type,
    ts: new Date().toISOString(),
    data,
  };
  eventBus.emit(userId, event);
  return event;
}

const NOTIFY_PAYLOAD_LIMIT = 7500; // pg NOTIFY limit is ~8KB; keep margin

export async function notifyUserEvent<T extends EventType>(
  userId: string,
  type: T,
  data: EventDataMap[T]
): Promise<void> {
  const id = nextEventId();
  const payload = JSON.stringify({
    id,
    userId,
    type,
    ts: new Date().toISOString(),
    data,
  });

  if (payload.length > NOTIFY_PAYLOAD_LIMIT) {
    throw new Error(
      `[events.notifyUserEvent] payload ${payload.length} exceeds ${NOTIFY_PAYLOAD_LIMIT}B for ${type}; reduce data size or use emitToUser`
    );
  }

  // Single-arg form is broadcast-safe; we sanitize via parameterized query.
  await prisma.$executeRaw`SELECT pg_notify(${USER_EVENTS_CHANNEL}, ${payload})`;
}
