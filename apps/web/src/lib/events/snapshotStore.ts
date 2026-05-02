/**
 * In-flight chat snapshot store.
 *
 * Holds the partial accumulated text for chats that are currently streaming.
 * Used by the SSE endpoint to send a `chat.snapshot` event when a client
 * (re)connects mid-generation, so a page reload doesn't lose what's already
 * been printed.
 *
 * Lifecycle:
 *   beginChat(userId, sessionId)   — when the LLM call starts
 *   appendChatToken(...)           — on each delta
 *   updateChatStatus(...)          — on tool / planner status changes
 *   endChat(userId, sessionId)     — on chat.final or chat.error
 *
 * On process crash everything in this store is lost. Watchdog in the worker
 * marks orphaned pending assistant messages as failed (see §11 phase 4).
 *
 * See `docs/research/sse-event-channel.md` §6.2.
 */

export interface InFlightChat {
  sessionId: string;
  accumulated: string;
  status: string | null;
  startedAt: Date;
}

class SnapshotStore {
  private store = new Map<string, Map<string, InFlightChat>>();

  beginChat(userId: string, sessionId: string): void {
    let bucket = this.store.get(userId);
    if (!bucket) {
      bucket = new Map();
      this.store.set(userId, bucket);
    }
    bucket.set(sessionId, {
      sessionId,
      accumulated: "",
      status: null,
      startedAt: new Date(),
    });
  }

  appendChatToken(userId: string, sessionId: string, text: string): void {
    const entry = this.store.get(userId)?.get(sessionId);
    if (!entry) return;
    entry.accumulated += text;
  }

  updateChatStatus(userId: string, sessionId: string, status: string): void {
    const entry = this.store.get(userId)?.get(sessionId);
    if (!entry) return;
    entry.status = status;
  }

  endChat(userId: string, sessionId: string): void {
    const bucket = this.store.get(userId);
    if (!bucket) return;
    bucket.delete(sessionId);
    if (bucket.size === 0) this.store.delete(userId);
  }

  getActiveForUser(userId: string): InFlightChat[] {
    const bucket = this.store.get(userId);
    if (!bucket || bucket.size === 0) return [];
    return Array.from(bucket.values()).map((entry) => ({
      sessionId: entry.sessionId,
      accumulated: entry.accumulated,
      status: entry.status,
      startedAt: entry.startedAt,
    }));
  }

  hasActiveChat(userId: string, sessionId: string): boolean {
    return this.store.get(userId)?.has(sessionId) ?? false;
  }

  /** Test-only. */
  __resetForTests(): void {
    this.store.clear();
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __remarkaSnapshotStore: SnapshotStore | undefined;
}

export const snapshotStore: SnapshotStore =
  globalThis.__remarkaSnapshotStore ??
  (globalThis.__remarkaSnapshotStore = new SnapshotStore());
