import type { BookAnalyzerType, Prisma } from "@prisma/client";
import { prisma } from "./client";

type DbExecutor = Prisma.TransactionClient | typeof prisma;

const BOOK_ANALYZER_REQUESTED_EVENT = "book.analyzer.requested";

function matchesAnalyzerEventPayload(payload: unknown, params: { bookId: string; analyzerType: string }): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return record.bookId === params.bookId && record.analyzerType === params.analyzerType;
}

export async function enqueueBookAnalyzerStage(params: {
  client?: DbExecutor;
  bookId: string;
  analyzerType: BookAnalyzerType | string;
  publishEvent?: boolean;
  force?: boolean;
  availableAt?: Date | null;
}): Promise<void> {
  const client = params.client || prisma;
  const bookId = String(params.bookId || "").trim();
  const analyzerType = String(params.analyzerType || "").trim();
  const publishEvent = params.publishEvent !== false;
  const force = params.force === true;
  const availableAt = params.availableAt || new Date();
  if (!bookId) throw new Error("enqueueBookAnalyzerStage requires bookId");
  if (!analyzerType) throw new Error("enqueueBookAnalyzerStage requires analyzerType");

  const existing = await client.bookAnalyzerTask.findUnique({
    where: {
      bookId_analyzerType: {
        bookId,
        analyzerType: analyzerType as BookAnalyzerType,
      },
    },
    select: {
      state: true,
    },
  });

  if ((existing?.state === "completed" && !force) || (existing?.state === "running" && !force)) {
    return;
  }

  await client.bookAnalyzerTask.upsert({
    where: {
      bookId_analyzerType: {
        bookId,
        analyzerType: analyzerType as BookAnalyzerType,
      },
    },
    create: {
      bookId,
      analyzerType: analyzerType as BookAnalyzerType,
      state: "queued",
      error: null,
      startedAt: null,
      completedAt: null,
    },
    update: {
      state: "queued",
      error: null,
      startedAt: null,
      completedAt: null,
    },
  });

  if (!publishEvent) {
    return;
  }

  const pendingEvents = await client.outbox.findMany({
    where: {
      aggregateType: "book",
      aggregateId: bookId,
      eventType: BOOK_ANALYZER_REQUESTED_EVENT,
      processedAt: null,
    },
    select: {
      id: true,
      payloadJson: true,
      availableAt: true,
    },
  });

  const pendingEvent = pendingEvents.find((event) =>
    matchesAnalyzerEventPayload(event.payloadJson, { bookId, analyzerType })
  );

  if (pendingEvent) {
    if (pendingEvent.availableAt.getTime() > availableAt.getTime()) {
      await client.outbox.update({
        where: { id: pendingEvent.id },
        data: {
          availableAt,
        },
      });
    }
    return;
  }

  await client.outbox.create({
    data: {
      aggregateType: "book",
      aggregateId: bookId,
      eventType: BOOK_ANALYZER_REQUESTED_EVENT,
      payloadJson: {
        bookId,
        analyzerType,
      },
      availableAt,
    },
  });
}
