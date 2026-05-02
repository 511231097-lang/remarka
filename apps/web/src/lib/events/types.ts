/**
 * Per-user SSE event channel — wire format & event type registry.
 *
 * All events flow through the in-process EventBus and are delivered to clients
 * via the long-lived SSE endpoint at `/api/events/stream`. Events are
 * best-effort signals: the source of truth lives in REST/DB, an event tells
 * the client "go look".
 *
 * See `docs/research/sse-event-channel.md` §4 for the full contract and §6 for
 * snapshot semantics.
 */

export type EventType =
  | "chat.token"
  | "chat.status"
  | "chat.tool"
  | "chat.final"
  | "chat.error"
  | "chat.snapshot"
  | "book.analysis.progress"
  | "book.analysis.done";

export interface ChatTokenData {
  sessionId: string;
  text: string;
}

export interface ChatStatusData {
  sessionId: string;
  text: string;
}

export interface ChatToolData {
  sessionId: string;
  kind: "call" | "result";
  toolName: string;
}

export interface ChatFinalData {
  sessionId: string;
  messageId: string;
}

export interface ChatErrorData {
  sessionId: string;
  error: string;
  code?: string;
}

export interface ChatSnapshotData {
  sessionId: string;
  accumulated: string;
  status: string | null;
  startedAt: string; // ISO8601
}

export interface BookAnalysisProgressData {
  bookId: string;
  phase: string;
  pct?: number;
}

export interface BookAnalysisDoneData {
  bookId: string;
  status: "ready" | "failed";
}

export type EventDataMap = {
  "chat.token": ChatTokenData;
  "chat.status": ChatStatusData;
  "chat.tool": ChatToolData;
  "chat.final": ChatFinalData;
  "chat.error": ChatErrorData;
  "chat.snapshot": ChatSnapshotData;
  "book.analysis.progress": BookAnalysisProgressData;
  "book.analysis.done": BookAnalysisDoneData;
};

export interface UserEvent<T extends EventType = EventType> {
  id: string; // ULID-ish, monotonic per process
  type: T;
  ts: string; // ISO8601
  data: EventDataMap[T];
}

/**
 * Postgres NOTIFY payload format. The userId is stripped before delivery to
 * subscribers (the bus already filters by userId — clients only receive their
 * own events).
 */
export interface NotifyPayload {
  userId: string;
  type: EventType;
  data: unknown;
  ts?: string;
  id?: string;
}

export const USER_EVENTS_CHANNEL = "user_events";
