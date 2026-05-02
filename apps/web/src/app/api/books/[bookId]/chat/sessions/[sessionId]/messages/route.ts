/**
 * Chat messages — list (GET) and send (POST).
 *
 * GET  → list persisted messages for a session.
 * POST → enqueue a new turn:
 *        body: { message: string }
 *        ← 202 Accepted, { userMessage, sessionId }
 *
 *        Persists the user message synchronously, then runs the LLM call as
 *        a fire-and-forget background task. Tokens, status, tool events, and
 *        the final assistant message are delivered through the persistent SSE
 *        channel at `/api/events/stream` (events `chat.token`, `chat.status`,
 *        `chat.tool`, `chat.final`, `chat.error`).
 *
 * See `docs/research/sse-event-channel.md` §7.3.
 */

import { NextResponse } from "next/server";

import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";
import {
  BookChatError,
  listBookChatMessages,
  prepareBookChatTurn,
  runBookChatTurn,
} from "@/lib/bookChatService";
import { chatRegistry } from "@/lib/events/chatRegistry";
import { emitToUser } from "@/lib/events/emit";
import { snapshotStore } from "@/lib/events/snapshotStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ bookId: string; sessionId: string }>;
}

function toMessageDTO(message: {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    rawAnswer: message.role === "assistant" ? message.content : null,
    evidence: [],
    usedSources: [],
    confidence: null,
    mode: null,
    citations: [],
    inlineCitations: [],
    answerItems: [],
    referenceResolution: null,
    createdAt: message.createdAt,
  };
}

function statusForToolCall(toolName: string): string {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (
    normalized === "search_paragraphs" ||
    normalized === "search_paragraphs_hybrid" ||
    normalized === "search_paragraphs_lexical"
  ) {
    return "Ищу нужные параграфы";
  }
  if (normalized === "search_scenes") return "Ищу подходящие сцены";
  if (normalized === "get_scene_context") return "Изучаю сцену";
  if (normalized === "read_passages" || normalized === "get_paragraph_slice") return "Читаю фрагмент";
  return "Проверяю фрагменты";
}

function statusForToolResult(toolName: string): string {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (
    normalized === "search_paragraphs" ||
    normalized === "search_paragraphs_hybrid" ||
    normalized === "search_paragraphs_lexical"
  ) {
    return "Анализирую параграфы";
  }
  if (normalized === "search_scenes") return "Анализирую сцены";
  if (normalized === "get_scene_context") return "Связываю детали сцены";
  if (normalized === "read_passages" || normalized === "get_paragraph_slice") return "Связываю контекст";
  return "Формирую ответ";
}

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const sessionId = String(params.sessionId || "").trim();

  if (!bookId) return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });

  const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  try {
    const messages = await listBookChatMessages({
      bookId: book.id,
      threadId: sessionId,
      ownerUserId: authUser.id,
    });

    return NextResponse.json({
      items: messages.map(toMessageDTO),
    });
  } catch (error) {
    if (error instanceof BookChatError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to list chat messages" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  const sessionId = String(params.sessionId || "").trim();
  if (!bookId) return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });

  const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
  if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const message = String(body?.message || "").trim().slice(0, 2000);
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // Reserve the session BEFORE persisting anything: a duplicate POST while a
  // previous turn is still running should be rejected, not double-persisted.
  const reservation = chatRegistry.begin(sessionId, authUser.id);
  if (!reservation) {
    return NextResponse.json(
      { error: "Чат уже обрабатывает предыдущее сообщение", code: "ALREADY_RUNNING" },
      { status: 409 }
    );
  }

  let prepared;
  try {
    prepared = await prepareBookChatTurn({
      bookId: book.id,
      threadId: sessionId,
      ownerUserId: authUser.id,
      userText: message,
    });
  } catch (error) {
    chatRegistry.end(sessionId);
    if (error instanceof BookChatError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Не удалось отправить сообщение" },
      { status: 500 }
    );
  }

  const userId = authUser.id;
  snapshotStore.beginChat(userId, sessionId);

  // Fire-and-forget background runner. We intentionally do NOT await it —
  // the HTTP response returns 202 immediately so the client can render the
  // user message and start listening for chat.token events.
  void runStreamingTurn({
    bookId: book.id,
    sessionId,
    userId,
    abortSignal: reservation.signal,
  });

  return NextResponse.json(
    {
      userMessage: prepared.userMessage,
      thread: prepared.thread,
      sessionId,
    },
    { status: 202 }
  );
}

async function runStreamingTurn(params: {
  bookId: string;
  sessionId: string;
  userId: string;
  abortSignal: AbortSignal;
}): Promise<void> {
  const { bookId, sessionId, userId, abortSignal } = params;
  const isAborted = () => abortSignal.aborted;

  try {
    const completed = await runBookChatTurn({
      bookId,
      threadId: sessionId,
      ownerUserId: userId,
      onStatus: (status) => {
        if (isAborted()) return;
        const text = String(status || "").trim();
        if (!text) return;
        snapshotStore.updateChatStatus(userId, sessionId, text);
        emitToUser(userId, "chat.status", { sessionId, text });
      },
      onToolCall: (event) => {
        if (isAborted()) return;
        emitToUser(userId, "chat.tool", { sessionId, kind: "call", toolName: event.toolName });
        emitToUser(userId, "chat.status", { sessionId, text: statusForToolCall(event.toolName) });
      },
      onToolResult: (event) => {
        if (isAborted()) return;
        emitToUser(userId, "chat.tool", { sessionId, kind: "result", toolName: event.toolName });
        emitToUser(userId, "chat.status", { sessionId, text: statusForToolResult(event.toolName) });
      },
      onDelta: (delta) => {
        if (isAborted()) return;
        if (!delta) return;
        snapshotStore.appendChatToken(userId, sessionId, delta);
        emitToUser(userId, "chat.token", { sessionId, text: delta });
      },
    });

    emitToUser(userId, "chat.final", {
      sessionId,
      messageId: completed.assistantMessage.id,
    });
  } catch (error) {
    if (abortSignal.aborted) {
      emitToUser(userId, "chat.error", {
        sessionId,
        error: "Генерация прервана",
        code: "ABORTED",
      });
    } else if (error instanceof BookChatError) {
      emitToUser(userId, "chat.error", {
        sessionId,
        error: error.message,
        code: error.code,
      });
    } else {
      // eslint-disable-next-line no-console
      console.error("[chat.messages] background runner crashed", error);
      emitToUser(userId, "chat.error", {
        sessionId,
        error: error instanceof Error ? error.message : "Chat stream failed",
      });
    }
  } finally {
    snapshotStore.endChat(userId, sessionId);
    chatRegistry.end(sessionId);
  }
}
