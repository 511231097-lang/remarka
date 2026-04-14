import { prisma } from "@remarka/db";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook, resolveOwnedChatSession } from "@/lib/chatAccess";
import {
  runManagedBookChatTurn,
  resolveChatTopK,
} from "@/lib/chatRuntime";
import { LITERARY_SECTION_KEYS, type BookChatEntryContextDTO, type LiterarySectionKeyDTO } from "@/lib/books";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ bookId: string; sessionId: string }>;
}

function asSectionKey(value: unknown): LiterarySectionKeyDTO | undefined {
  if (typeof value !== "string") return undefined;
  return LITERARY_SECTION_KEYS.includes(value as LiterarySectionKeyDTO) ? (value as LiterarySectionKeyDTO) : undefined;
}

function asEntryContext(value: unknown): BookChatEntryContextDTO | undefined {
  if (value === "overview" || value === "section" || value === "full_chat") return value;
  return undefined;
}

function toSseEvent(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
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

  const session = await resolveOwnedChatSession({
    sessionId,
    bookId,
    userId: authUser.id,
  });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });

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

  const topK = resolveChatTopK(body?.topK);
  const sectionKey = asSectionKey(body?.sectionKey);
  const entryContext = asEntryContext(body?.entryContext);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const sendEvent = (event: string, payload: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(toSseEvent(event, payload)));
        };

        try {
          sendEvent("session", {
            sessionId: session.id,
          });

          const now = new Date();
          const userMessage = await prisma.bookChatMessage.create({
            data: {
              sessionId: session.id,
              role: "user",
              content: message,
              citationsJson: [],
              promptTokens: null,
              completionTokens: null,
            },
          });

          await prisma.bookChatSession.update({
            where: { id: session.id },
            data: {
              lastMessageAt: now,
              title:
                session.title === "Новый чат"
                  ? message.slice(0, 80)
                  : session.title,
            },
          });

          const historyRows = await prisma.bookChatMessage.findMany({
            where: {
              sessionId: session.id,
              id: {
                not: userMessage.id,
              },
            },
            orderBy: [{ createdAt: "desc" }],
            take: 10,
          });

          const history = [...historyRows]
            .reverse()
            .map((entry) => ({
              role: (entry.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
              content: entry.content,
              payload:
                entry.citationsJson && typeof entry.citationsJson === "object" && !Array.isArray(entry.citationsJson)
                  ? (entry.citationsJson as Record<string, unknown>)
                  : null,
            }));

          const turn = await runManagedBookChatTurn({
            sessionId: session.id,
            bookId,
            question: message,
            history,
            topK,
            sectionKey,
            entryContext,
            onToken: (token) => {
              sendEvent("token", {
                text: token,
              });
            },
          });

          const storagePayload = {
            version: 4,
            evidence: turn.evidence,
            citations: turn.citations,
            usedSources: turn.usedSources,
            confidence: turn.confidence,
            mode: turn.mode,
            intent: turn.intent,
            focusEntities: turn.focusEntities,
            directEvidenceIds: turn.directEvidenceIds,
            contextEvidenceIds: turn.contextEvidenceIds,
            activeIncidentIds: turn.activeIncidentIds,
            activeEntityIds: turn.activeEntityIds,
            mustCarryFacts: turn.mustCarryFacts,
            turnKind: turn.turnKind,
            turnState: turn.turnState,
            planner: turn.planner,
            bundleStats: turn.bundleStats,
            requiredFactIds: turn.requiredFactIds,
            usedEvidenceIds: turn.usedEvidenceIds,
            stateDelta: turn.stateDelta,
            verifier: turn.verifier,
          };

          const assistant = await prisma.bookChatMessage.create({
            data: {
              sessionId: session.id,
              role: "assistant",
              content: turn.answer,
              citationsJson: storagePayload as unknown as Prisma.InputJsonValue,
              promptTokens: turn.promptTokens,
              completionTokens: turn.completionTokens,
            },
          });

          await prisma.bookChatSession.update({
            where: { id: session.id },
            data: {
              lastMessageAt: assistant.createdAt,
            },
          });

          await prisma.bookChatSessionState.upsert({
            where: { sessionId: session.id },
            create: {
              sessionId: session.id,
              bookId,
              stateJson: turn.turnState as unknown as Prisma.InputJsonValue,
            },
            update: {
              stateJson: turn.turnState as unknown as Prisma.InputJsonValue,
            },
          });

          sendEvent("final", {
            sessionId: session.id,
            messageId: assistant.id,
            answer: turn.answer,
            evidence: turn.evidence,
            usedSources: turn.usedSources,
            confidence: turn.confidence,
            mode: turn.mode,
            citations: turn.citations,
          });

          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Chat stream failed";
          sendEvent("error", {
            error: message,
          });
          controller.close();
        }
      })();
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
