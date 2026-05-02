/**
 * In-process registry of in-flight chat generations.
 *
 * Each entry corresponds to a single "send message" call that is currently
 * running an LLM. Used for:
 *  - Abort: client POSTs to /abort, server flips the flag, runner observes
 *    and stops emitting.
 *  - Re-entry guard: prevent two concurrent generations on the same session
 *    (the second POST gets 409).
 *
 * Singleton across hot-reloads in dev.
 */

interface RegistryEntry {
  userId: string;
  abortController: AbortController;
  startedAt: Date;
}

class ChatRegistry {
  private entries = new Map<string, RegistryEntry>();

  begin(sessionId: string, userId: string): { signal: AbortSignal; abort: () => void } | null {
    if (this.entries.has(sessionId)) return null; // already running
    const ac = new AbortController();
    this.entries.set(sessionId, {
      userId,
      abortController: ac,
      startedAt: new Date(),
    });
    return {
      signal: ac.signal,
      abort: () => ac.abort(),
    };
  }

  abort(sessionId: string, userId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.userId !== userId) return false;
    entry.abortController.abort();
    return true;
  }

  end(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __remarkaChatRegistry: ChatRegistry | undefined;
}

export const chatRegistry: ChatRegistry =
  globalThis.__remarkaChatRegistry ??
  (globalThis.__remarkaChatRegistry = new ChatRegistry());
