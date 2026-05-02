"use client";

/**
 * Client-side provider for the per-user SSE event channel.
 *
 * Mounts a single EventSource to `/api/events/stream` for the duration of
 * the user's session inside the protected app shell. Components subscribe
 * to event types via `useEventChannel().subscribe(...)`.
 *
 * Design notes:
 *  - We DON'T use the native EventSource because it can't send credentials
 *    in some setups and has fewer hooks. Instead we use fetch-based SSE
 *    parsing — same wire format, more control over reconnect.
 *  - On disconnect we attempt automatic reconnect with exponential backoff.
 *  - On reconnect we fire `onReconnect` handlers so subscribers can do a
 *    REST refetch of their state (chat history, library, etc.).
 *
 * See `docs/research/sse-event-channel.md` §7.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { EventDataMap, EventType, UserEvent } from "./types";

type AnyHandler = (event: UserEvent) => void;
type ReconnectHandler = () => void;

export type ChannelStatus = "idle" | "connecting" | "open" | "reconnecting" | "error";

interface ChannelContextValue {
  status: ChannelStatus;
  subscribe<T extends EventType>(
    type: T,
    handler: (event: UserEvent<T>) => void
  ): () => void;
  onReconnect(handler: ReconnectHandler): () => void;
}

const ChannelContext = createContext<ChannelContextValue | null>(null);

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

export function EventChannelProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ChannelStatus>("idle");
  const handlersRef = useRef(new Map<EventType, Set<AnyHandler>>());
  const reconnectHandlersRef = useRef(new Set<ReconnectHandler>());
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const everConnectedRef = useRef(false);
  const stoppedRef = useRef(false);

  const dispatch = useCallback((event: UserEvent) => {
    const bucket = handlersRef.current.get(event.type);
    if (!bucket) return;
    for (const handler of Array.from(bucket)) {
      try {
        handler(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[EventChannel] handler crashed", err);
      }
    }
  }, []);

  const fireReconnect = useCallback(() => {
    for (const handler of Array.from(reconnectHandlersRef.current)) {
      try {
        handler();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[EventChannel] reconnect handler crashed", err);
      }
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return;
    if (reconnectTimerRef.current) return;
    reconnectAttemptRef.current += 1;
    const attempt = reconnectAttemptRef.current;
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6));
    const delay = base + Math.floor(Math.random() * 250);
    setStatus("reconnecting");
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void connect();
    }, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async () => {
    if (stoppedRef.current) return;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setStatus(everConnectedRef.current ? "reconnecting" : "connecting");

    try {
      const response = await fetch("/api/events/stream", {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
        credentials: "same-origin",
        signal: ac.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`stream HTTP ${response.status}`);
      }

      setStatus("open");
      reconnectAttemptRef.current = 0;
      const wasReconnect = everConnectedRef.current;
      everConnectedRef.current = true;
      if (wasReconnect) fireReconnect();

      await readStream(response.body, dispatch, ac.signal);
      // If readStream returns normally, the server closed the stream. We
      // attempt to reconnect — server-side this is usually a deploy/restart.
      if (!stoppedRef.current && !ac.signal.aborted) {
        scheduleReconnect();
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      // eslint-disable-next-line no-console
      console.warn("[EventChannel] connection error, will reconnect:", err);
      setStatus("error");
      scheduleReconnect();
    }
  }, [dispatch, fireReconnect, scheduleReconnect]);

  useEffect(() => {
    stoppedRef.current = false;
    void connect();

    const onVisibility = () => {
      if (document.visibilityState === "visible" && status !== "open") {
        // Force a reconnect attempt when tab becomes visible — useful after
        // resume from sleep where the socket may be silently dead.
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        reconnectAttemptRef.current = 0;
        void connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stoppedRef.current = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      setStatus("idle");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribe = useCallback(
    <T extends EventType>(type: T, handler: (event: UserEvent<T>) => void): (() => void) => {
      let bucket = handlersRef.current.get(type);
      if (!bucket) {
        bucket = new Set();
        handlersRef.current.set(type, bucket);
      }
      // We store the handler as an opaque AnyHandler — the dispatch path
      // calls it with the raw event; the type narrowing via the EventType
      // generic is purely a compile-time aid.
      const opaque = handler as unknown as AnyHandler;
      bucket.add(opaque);
      return () => {
        const current = handlersRef.current.get(type);
        if (!current) return;
        current.delete(opaque);
        if (current.size === 0) handlersRef.current.delete(type);
      };
    },
    []
  );

  const onReconnect = useCallback((handler: ReconnectHandler): (() => void) => {
    reconnectHandlersRef.current.add(handler);
    return () => {
      reconnectHandlersRef.current.delete(handler);
    };
  }, []);

  const value = useMemo<ChannelContextValue>(
    () => ({ status, subscribe, onReconnect }),
    [status, subscribe, onReconnect]
  );

  return <ChannelContext.Provider value={value}>{children}</ChannelContext.Provider>;
}

export function useEventChannel(): ChannelContextValue {
  const ctx = useContext(ChannelContext);
  if (!ctx) {
    throw new Error("useEventChannel must be used inside <EventChannelProvider>");
  }
  return ctx;
}

/**
 * Convenience hook: subscribe to an event type with a stable handler ref.
 * Re-subscribes when `type` changes; the handler itself is read from a ref
 * so callers don't need to memoize their handlers.
 */
export function useEventSubscription<T extends EventType>(
  type: T,
  handler: (event: UserEvent<T>) => void
): void {
  const { subscribe } = useEventChannel();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const off = subscribe(type, (event) => handlerRef.current(event));
    return off;
  }, [type, subscribe]);
}

/** Same idea for reconnect callbacks. */
export function useEventReconnect(handler: () => void): void {
  const { onReconnect } = useEventChannel();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const off = onReconnect(() => handlerRef.current());
    return off;
  }, [onReconnect]);
}

// Compile-time: ensure EventDataMap is consumed so unused-symbol lints don't fire.
type _Touch = EventDataMap;

/* ---------------------------------------------------------------------- */
/*                      SSE wire format parser (fetch)                    */
/* ---------------------------------------------------------------------- */

async function readStream(
  body: ReadableStream<Uint8Array>,
  dispatch: (event: UserEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // Parse complete SSE blocks separated by \n\n.
      let blockEnd = buffer.indexOf("\n\n");
      while (blockEnd !== -1) {
        const block = buffer.slice(0, blockEnd);
        buffer = buffer.slice(blockEnd + 2);
        blockEnd = buffer.indexOf("\n\n");
        const event = parseSseBlock(block);
        if (event) dispatch(event);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function parseSseBlock(block: string): UserEvent | null {
  let id = "";
  let type = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comment / heartbeat
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") type = value;
    else if (field === "data") data = data ? `${data}\n${value}` : value;
  }

  if (!type || !data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  return {
    id,
    type: type as EventType,
    ts: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: parsed as any,
  };
}
