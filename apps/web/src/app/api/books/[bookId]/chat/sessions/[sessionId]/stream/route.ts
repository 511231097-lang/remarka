import { NextResponse } from "next/server";
import { isBookChatToolName, type BookChatToolName } from "@/lib/bookChatTools";
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
  if (normalized === "search_paragraphs_hybrid" || normalized === "search_paragraphs_lexical") {
    return "Ищу подходящий параграф";
  }
  if (normalized === "search_scenes") {
    return "Ищу подходящую сцену";
  }
  if (normalized === "get_scene_context") {
    return "Детально изучаю сцену";
  }
  if (normalized === "get_paragraph_slice") {
    return "Проверяю контекст фрагмента";
  }
  return "Проверяю релевантные фрагменты";
}

function statusForToolResult(toolName: string): string {
  const normalized = String(toolName || "").trim().toLowerCase();
  if (normalized === "search_paragraphs_hybrid" || normalized === "search_paragraphs_lexical") {
    return "Нашёл релевантные абзацы, собираю ответ";
  }
  if (normalized === "search_scenes") {
    return "Сцена найдена, собираю опорный контекст";
  }
  if (normalized === "get_scene_context") {
    return "Сцена изучена, формулирую вывод";
  }
  if (normalized === "get_paragraph_slice") {
    return "Контекст проверен, формулирую ответ";
  }
  return "Собираю ответ";
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

  let selectedTools: BookChatToolName[] | undefined;
  if (body.selectedTools !== undefined) {
    if (!Array.isArray(body.selectedTools)) {
      return NextResponse.json({ error: "selectedTools must be an array" }, { status: 400 });
    }

    const invalidTools = body.selectedTools
      .map((item) => String(item || "").trim())
      .filter((item) => item && !isBookChatToolName(item));
    if (invalidTools.length > 0) {
      return NextResponse.json(
        { error: `Unsupported tools: ${invalidTools.join(", ")}` },
        { status: 400 }
      );
    }

    selectedTools = Array.from(
      new Set(
        body.selectedTools
          .map((item) => String(item || "").trim())
          .filter((item): item is BookChatToolName => isBookChatToolName(item))
      )
    );
    if (selectedTools.length === 0) {
      return NextResponse.json({ error: "At least one tool must be selected" }, { status: 400 });
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendEvent = (event: string, payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(toSseEvent(event, payload)));
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
          sendStatus("Разбираю вопрос и подбираю опоры в тексте");

          const result = await streamBookChatThreadReply({
            bookId: book.id,
            threadId: sessionId,
            ownerUserId: authUser.id,
            userText: message,
            selectedTools,
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

          controller.close();
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
          controller.close();
        }
      })();
    },
    cancel() {
      // Client can disconnect while backend keeps processing.
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
