/**
 * User event NOTIFY helper — used by worker (and any other backend process)
 * to deliver a realtime event to the user's SSE channel running in the web
 * process.
 *
 * The web process LISTEN's on `user_events`; on NOTIFY, parses the JSON
 * payload, filters by userId, and dispatches into its in-process EventBus.
 *
 * See `docs/research/sse-event-channel.md` §5.3 for the full pipeline.
 *
 * Type contract is intentionally permissive here (`type: string`, `data:
 * unknown`). The strongly-typed helper lives in apps/web/src/lib/events
 * where the EventDataMap is available; the worker uses this loose form to
 * avoid pulling web-specific types into packages/db.
 */

import { prisma } from "./client";

export const USER_EVENTS_CHANNEL = "user_events";

const NOTIFY_PAYLOAD_LIMIT = 7500;

export interface NotifyUserEventInput {
  userId: string;
  type: string;
  data: Record<string, unknown>;
}

export async function notifyUserEvent(input: NotifyUserEventInput): Promise<void> {
  const payload = JSON.stringify({
    userId: input.userId,
    type: input.type,
    ts: new Date().toISOString(),
    data: input.data,
  });
  if (payload.length > NOTIFY_PAYLOAD_LIMIT) {
    throw new Error(
      `notifyUserEvent: payload ${payload.length} exceeds ${NOTIFY_PAYLOAD_LIMIT}B for ${input.type}`
    );
  }
  await prisma.$executeRaw`SELECT pg_notify(${USER_EVENTS_CHANNEL}, ${payload})`;
}
