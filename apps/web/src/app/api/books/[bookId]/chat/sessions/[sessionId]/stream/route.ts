import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";
import { BookChatError, streamBookChatThreadReply } from "@/lib/bookChatService";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ bookId: string; sessionId: string }>;
}

function toSseEvent(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
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
  if (normalized === "search_scenes") {
    return "Ищу подходящие сцены";
  }
  if (normalized === "get_scene_context") {
    return "Изучаю сцену";
  }
  if (normalized === "read_passages" || normalized === "get_paragraph_slice") {
    return "Читаю фрагмент";
  }
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
  if (normalized === "search_scenes") {
    return "Анализирую сцены";
  }
  if (normalized === "get_scene_context") {
    return "Связываю детали сцены";
  }
  if (normalized === "read_passages" || normalized === "get_paragraph_slice") {
    return "Связываю контекст";
  }
  return "Формирую ответ";
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

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendEvent = (event: string, payload: Record<string, unknown>) => {
        if (closed || request.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(toSseEvent(event, payload)));
        } catch {
          closed = true;
        }
      };
      let lastStatus = "";
      const sendStatus = (status: string) => {
        const text = String(status || "").trim();
        if (!text || text === lastStatus) return;
        lastStatus = text;
        sendEvent("status", { text });
      };

      void (async () => {
        try {
          sendEvent("session", {
            sessionId,
          });
          // Initial "Думаю над вопросом" is set client-side; we don't echo a
          // duplicate server-side status here. The next status message will
          // come from history compaction / planner / tool calls naturally.

          const result = await streamBookChatThreadReply({
            bookId: book.id,
            threadId: sessionId,
            ownerUserId: authUser.id,
            userText: message,
            // Internal model thoughts are intentionally not streamed to the UI.
            // Some providers emit many repeated reasoning deltas, which can flood the chat surface.
            onStatus: async (status) => {
              sendStatus(status);
            },
            onToolCall: async (event) => {
              sendStatus(statusForToolCall(event.toolName));
            },
            onToolResult: async (event) => {
              sendStatus(statusForToolResult(event.toolName));
            },
            onDelta: async (delta) => {
              if (!delta) return;
              sendEvent("token", { text: delta });
            },
          });

          sendEvent("final", {
            sessionId,
            messageId: result.assistantMessage.id,
            answer: result.assistantMessage.content,
            rawAnswer: result.assistantMessage.content,
            evidence: [],
            usedSources: [],
            confidence: null,
            mode: "fast",
            citations: [],
            inlineCitations: [],
            answerItems: [],
            referenceResolution: null,
          });

          if (!closed) {
            closed = true;
            controller.close();
          }
        } catch (error) {
          if (error instanceof BookChatError) {
            sendEvent("error", {
              error: error.message,
              code: error.code,
            });
          } else {
            sendEvent("error", {
              error: error instanceof Error ? error.message : "Chat stream failed",
            });
          }
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      })();
    },
    cancel() {
      closed = true;
      // Client can disconnect while backend keeps processing and persisting the answer.
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
