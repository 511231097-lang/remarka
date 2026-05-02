/**
 * Per-user SSE event channel endpoint.
 *
 * GET /api/events/stream
 *
 * The single long-lived connection that delivers all realtime events for the
 * authenticated user. Replaces:
 *  - per-message chat streaming (`/api/books/.../chat/sessions/.../stream`)
 *  - short-polling of analyzing books (`Library.tsx` setInterval)
 *
 * Lifecycle:
 *  1. Resolve userId from session (401 otherwise).
 *  2. On connect, send chat.snapshot for any active in-flight chat — so a
 *     page reload mid-generation continues seamlessly.
 *  3. Subscribe to the EventBus for this userId; pipe events to client.
 *  4. Heartbeat every 25s (`: ping`) to keep idle connection alive.
 *  5. On TCP close (request.signal.aborted) — unsubscribe + close stream.
 *
 * See `docs/research/sse-event-channel.md`.
 */

import { NextResponse } from "next/server";

import { resolveAuthUser } from "@/lib/authUser";
import { eventBus } from "@/lib/events/bus";
import { nextEventId } from "@/lib/events/eventId";
import { snapshotStore } from "@/lib/events/snapshotStore";
import { formatSseComment, formatSseEvent } from "@/lib/events/sse";
import type { UserEvent } from "@/lib/events/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_INTERVAL_MS = 25_000;

export async function GET(request: Request) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = authUser.id;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          // Stream already closed (client disconnected mid-write).
          closeAll();
          return false;
        }
      };

      const closeAll = () => {
        if (closed) return;
        closed = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // 1. Tell the client we're up.
      safeEnqueue(formatSseComment(`connected ${new Date().toISOString()}`));

      // 2. Replay any in-flight chat snapshots.
      for (const inflight of snapshotStore.getActiveForUser(userId)) {
        const snapshotEvent: UserEvent<"chat.snapshot"> = {
          id: nextEventId(),
          type: "chat.snapshot",
          ts: new Date().toISOString(),
          data: {
            sessionId: inflight.sessionId,
            accumulated: inflight.accumulated,
            status: inflight.status,
            startedAt: inflight.startedAt.toISOString(),
          },
        };
        safeEnqueue(formatSseEvent(snapshotEvent));
      }

      // 3. Live subscription.
      unsubscribe = eventBus.subscribe(userId, (event) => {
        safeEnqueue(formatSseEvent(event));
      });

      // 4. Heartbeat to keep the connection alive past nginx/Cloudflare idle
      //    timeouts (default ~60s without proxy_read_timeout override).
      heartbeat = setInterval(() => {
        safeEnqueue(formatSseComment(`ping ${Date.now()}`));
      }, HEARTBEAT_INTERVAL_MS);

      // 5. Tear down on client disconnect.
      const onAbort = () => {
        request.signal.removeEventListener("abort", onAbort);
        closeAll();
      };
      if (request.signal.aborted) {
        closeAll();
      } else {
        request.signal.addEventListener("abort", onAbort);
      }
    },

    cancel() {
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
