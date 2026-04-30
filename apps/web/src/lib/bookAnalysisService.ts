import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  createArtifactBlobStoreFromEnv,
  createNpzPrismaAdapter,
  enqueueOutboxEvent,
  getArtifactPayload,
  prisma as basePrisma,
} from "@remarka/db";
import {
  toBookAnalysisArtifactDTO,
  toBookAnalysisDTO,
  type BookAnalysisArtifactListDTO,
  type BookAnalysisDTO,
} from "./npzBooks";

const prisma = createNpzPrismaAdapter(basePrisma);

type AnalysisTriggerSource = "auto" | "manual";

export class BookAnalysisRequestError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "BookAnalysisRequestError";
  }
}

function hasVertexApiKey() {
  return String(process.env.VERTEX_API_KEY || "").trim().length > 0;
}

async function readBookAnalysisRecord(bookId: string) {
  return prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      latestAnalysisRunId: true,
      analysisStatus: true,
      analysisError: true,
      analysisTotalBlocks: true,
      analysisCheckedBlocks: true,
      analysisPromptTokens: true,
      analysisCompletionTokens: true,
      analysisTotalTokens: true,
      analysisChapterStatsJson: true,
      analysisStartedAt: true,
      analysisFinishedAt: true,
      updatedAt: true,
      analysisScenes: {
        orderBy: [{ chapter: { orderIndex: "asc" } }, { sceneIndex: "asc" }],
        select: {
          id: true,
          bookId: true,
          chapterId: true,
          sceneIndex: true,
          paragraphStart: true,
          paragraphEnd: true,
          locationLabel: true,
          timeLabel: true,
          participantsJson: true,
          mentionedEntitiesJson: true,
          locationHintsJson: true,
          timeHintsJson: true,
          eventLabelsJson: true,
          unresolvedFormsJson: true,
          factsJson: true,
          evidenceSpansJson: true,
          sceneCard: true,
          sceneSummary: true,
          changeSignal: true,
          excerptText: true,
          chapter: {
            select: {
              orderIndex: true,
              title: true,
            },
          },
        },
      },
    },
  });
}

async function readBookAnalysisArtifactSummary(bookId: string, runId?: string | null) {
  const where = {
    bookId,
    ...(runId ? { runId } : {}),
  };
  const [total, failed, latest] = await Promise.all([
    prisma.bookAnalysisArtifact.count({
      where,
    }),
    prisma.bookAnalysisArtifact.count({
      where: {
        ...where,
        status: "error",
      },
    }),
    prisma.bookAnalysisArtifact.findFirst({
      where,
      orderBy: {
        createdAt: "desc",
      },
      select: {
        createdAt: true,
      },
    }),
  ]);

  return {
    total,
    failed,
    lastArtifactAt: latest?.createdAt ? latest.createdAt.toISOString() : null,
  };
}

export async function getBookAnalysis(bookId: string): Promise<BookAnalysisDTO | null> {
  const row = await readBookAnalysisRecord(bookId);
  if (!row) return null;
  const [artifactSummary, latestRun] = await Promise.all([
    readBookAnalysisArtifactSummary(bookId, row.latestAnalysisRunId),
    row.latestAnalysisRunId
      ? prisma.bookAnalysisRun.findUnique({
          where: { id: row.latestAnalysisRunId },
          select: {
            qualityFlagsJson: true,
          },
        })
      : null,
  ]);

  return toBookAnalysisDTO({
    configured: hasVertexApiKey(),
    book: row,
    latestRunQualityFlags: latestRun?.qualityFlagsJson ?? null,
    scenes: row.analysisScenes,
    artifactSummary,
  });
}

export async function getBookAnalysisArtifacts(params: {
  bookId: string;
  limit?: number;
  runId?: string | null;
  includePayload?: boolean;
}): Promise<BookAnalysisArtifactListDTO | null> {
  const bookId = String(params.bookId || "").trim();
  if (!bookId) return null;

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      latestAnalysisRunId: true,
    },
  });
  if (!book) return null;

  const limit = Math.min(200, Math.max(1, Number(params.limit || 50)));
  const runId = String(params.runId || "").trim() || String(book.latestAnalysisRunId || "").trim() || null;
  const [summary, rows] = await Promise.all([
    readBookAnalysisArtifactSummary(bookId, runId),
    prisma.bookAnalysisArtifact.findMany({
      where: {
        bookId,
        ...(runId ? { runId } : {}),
      },
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
      select: {
        id: true,
        runId: true,
        bookId: true,
        chapterId: true,
        chapterOrderIndex: true,
        chapterTitle: true,
        chunkStartParagraph: true,
        chunkEndParagraph: true,
        attempt: true,
        stageKey: true,
        phase: true,
        status: true,
        llmModel: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        elapsedMs: true,
        storageProvider: true,
        payloadKey: true,
        payloadSizeBytes: true,
        compression: true,
        schemaVersion: true,
        promptText: true,
        inputJson: true,
        responseText: true,
        parsedJson: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
  ]);

  let rowsWithPayload = rows as any[];
  if (params.includePayload) {
    let store:
      | ReturnType<typeof createArtifactBlobStoreFromEnv>
      | null = null;
    try {
      store = createArtifactBlobStoreFromEnv();
    } catch {
      store = null;
    }

    if (store) {
      rowsWithPayload = await Promise.all(
        rows.map(async (row: any) => {
          if (!row.payloadKey) return row;
          try {
            const payload = (await getArtifactPayload({
              store,
              storageKey: String(row.payloadKey),
              compression: row.compression ? String(row.compression) : null,
            })) as Record<string, unknown>;

            return {
              ...row,
              promptText: typeof payload.prompt === "string" ? payload.prompt : row.promptText,
              inputJson: payload.input && typeof payload.input === "object" ? payload.input : row.inputJson,
              responseText: typeof payload.response === "string" ? payload.response : row.responseText,
              parsedJson: payload.parsed && typeof payload.parsed === "object" ? payload.parsed : row.parsedJson,
            };
          } catch {
            return row;
          }
        })
      );
    }
  }

  return {
    bookId,
    runId,
    limit,
    summary,
    items: rowsWithPayload.map((row: any) => toBookAnalysisArtifactDTO(row)),
  };
}

export async function listBookAnalysisRuns(params: { bookId: string; limit?: number }) {
  const bookId = String(params.bookId || "").trim();
  if (!bookId) return [];

  const limit = Math.min(50, Math.max(1, Number(params.limit || 20)));
  const rows = await prisma.bookAnalysisRun.findMany({
    where: { bookId },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
    select: {
      id: true,
      contentVersionId: true,
      attempt: true,
      state: true,
      currentStageKey: true,
      error: true,
      configVersion: true,
      configHash: true,
      extractModel: true,
      chatModel: true,
      embeddingModel: true,
      pricingVersion: true,
      llmPromptTokens: true,
      llmCompletionTokens: true,
      llmTotalTokens: true,
      embeddingInputTokens: true,
      embeddingTotalTokens: true,
      llmCostUsd: true,
      embeddingCostUsd: true,
      totalCostUsd: true,
      totalElapsedMs: true,
      llmLatencyMs: true,
      embeddingLatencyMs: true,
      chunkCount: true,
      chunkFailedCount: true,
      llmCalls: true,
      llmRetries: true,
      embeddingCalls: true,
      paragraphEmbeddingCount: true,
      sceneCount: true,
      artifactCount: true,
      storageBytesJson: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return rows.map((row: any) => ({
    ...row,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function getBookAnalysisRun(params: { bookId: string; runId: string }) {
  const bookId = String(params.bookId || "").trim();
  const runId = String(params.runId || "").trim();
  if (!bookId || !runId) return null;

  const row = await prisma.bookAnalysisRun.findFirst({
    where: {
      id: runId,
      bookId,
    },
    select: {
      id: true,
      contentVersionId: true,
      attempt: true,
      state: true,
      currentStageKey: true,
      error: true,
      configVersion: true,
      configHash: true,
      extractModel: true,
      chatModel: true,
      embeddingModel: true,
      pricingVersion: true,
      llmPromptTokens: true,
      llmCompletionTokens: true,
      llmTotalTokens: true,
      embeddingInputTokens: true,
      embeddingTotalTokens: true,
      llmCostUsd: true,
      embeddingCostUsd: true,
      totalCostUsd: true,
      totalElapsedMs: true,
      llmLatencyMs: true,
      embeddingLatencyMs: true,
      chunkCount: true,
      chunkFailedCount: true,
      llmCalls: true,
      llmRetries: true,
      embeddingCalls: true,
      paragraphEmbeddingCount: true,
      sceneCount: true,
      artifactCount: true,
      storageBytesJson: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      stageExecutions: {
        orderBy: [{ stageKey: "asc" }],
        select: {
          stageKey: true,
          state: true,
          error: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          embeddingInputTokens: true,
          embeddingTotalTokens: true,
          llmCostUsd: true,
          embeddingCostUsd: true,
          totalCostUsd: true,
          elapsedMs: true,
          retryCount: true,
          llmCalls: true,
          embeddingCalls: true,
          chunkCount: true,
          chunkFailedCount: true,
          outputRowCount: true,
          storageBytesJson: true,
          startedAt: true,
          completedAt: true,
        },
      },
      chapterMetrics: {
        orderBy: [{ chapterOrderIndex: "asc" }, { stageKey: "asc" }],
        select: {
          chapterId: true,
          chapterOrderIndex: true,
          chapterTitle: true,
          stageKey: true,
          state: true,
          error: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          embeddingInputTokens: true,
          embeddingTotalTokens: true,
          elapsedMs: true,
          retryCount: true,
          llmCalls: true,
          embeddingCalls: true,
          chunkCount: true,
          chunkFailedCount: true,
          outputRowCount: true,
          storageBytesJson: true,
          startedAt: true,
          completedAt: true,
        },
      },
    },
  });

  if (!row) return null;

  return {
    ...row,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stageExecutions: row.stageExecutions.map((item: any) => ({
      ...item,
      startedAt: item.startedAt ? item.startedAt.toISOString() : null,
      completedAt: item.completedAt ? item.completedAt.toISOString() : null,
    })),
    chapterMetrics: row.chapterMetrics.map((item: any) => ({
      ...item,
      startedAt: item.startedAt ? item.startedAt.toISOString() : null,
      completedAt: item.completedAt ? item.completedAt.toISOString() : null,
    })),
  };
}

export async function requestBookAnalysis(bookId: string, source: AnalysisTriggerSource): Promise<BookAnalysisDTO> {
  if (!hasVertexApiKey()) {
    throw new BookAnalysisRequestError("VERTEX_NOT_CONFIGURED", 409, "VERTEX_API_KEY is not configured");
  }

  const now = new Date();
  const requestedAt = now.toISOString();

  await prisma.$transaction(async (tx: any) => {
    const book = await tx.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        analysisStatus: true,
        ownerUserId: true,
      },
    });

    if (!book) {
      throw new BookAnalysisRequestError("BOOK_NOT_FOUND", 404, "Book not found");
    }

    if (book.analysisStatus === "queued" || book.analysisStatus === "running") {
      throw new BookAnalysisRequestError("ANALYSIS_ALREADY_RUNNING", 409, "Analysis is already queued or running");
    }

    await tx.bookAnalysisScene.deleteMany({
      where: {
        bookId,
      },
    });

    await tx.book.update({
      where: { id: bookId },
      data: {
        analysisState: "queued",
        analysisStatus: "queued",
        analysisError: null,
        analysisTotalBlocks: 0,
        analysisCheckedBlocks: 0,
        analysisPromptTokens: 0,
        analysisCompletionTokens: 0,
        analysisTotalTokens: 0,
        analysisChapterStatsJson: [] as Prisma.InputJsonValue,
        analysisRequestedAt: now,
        analysisStartedAt: null,
        analysisFinishedAt: null,
        analysisCompletedAt: null,
        currentAnalysisRunId: null,
      },
    });

    await enqueueOutboxEvent({
      client: tx,
      aggregateType: "book",
      aggregateId: bookId,
      eventType: "book.npz-analysis.requested",
      payloadJson: {
        bookId,
        ownerUserId: book.ownerUserId,
        requestedAt,
        requestId: randomUUID(),
        triggerSource: source,
        source,
      } as Prisma.InputJsonValue,
    });
  });

  const row = await readBookAnalysisRecord(bookId);
  if (!row) {
    throw new BookAnalysisRequestError("BOOK_NOT_FOUND", 404, "Book not found");
  }

  const artifactSummary = await readBookAnalysisArtifactSummary(bookId);

  return toBookAnalysisDTO({
    configured: hasVertexApiKey(),
    book: row,
    latestRunQualityFlags: null,
    scenes: row.analysisScenes,
    artifactSummary,
  });
}

export function isBookAnalysisConfigured() {
  return hasVertexApiKey();
}
