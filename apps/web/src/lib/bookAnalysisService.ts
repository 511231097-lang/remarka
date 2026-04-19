import type { Prisma } from "@prisma/client";
import { createNpzPrismaAdapter, enqueueOutboxEvent, prisma as basePrisma } from "@remarka/db";
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

async function readBookAnalysisArtifactSummary(bookId: string) {
  const [total, failed, latest] = await Promise.all([
    prisma.bookAnalysisArtifact.count({
      where: {
        bookId,
      },
    }),
    prisma.bookAnalysisArtifact.count({
      where: {
        bookId,
        status: "error",
      },
    }),
    prisma.bookAnalysisArtifact.findFirst({
      where: {
        bookId,
      },
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
  const [row, artifactSummary] = await Promise.all([readBookAnalysisRecord(bookId), readBookAnalysisArtifactSummary(bookId)]);
  if (!row) return null;

  return toBookAnalysisDTO({
    configured: hasVertexApiKey(),
    book: row,
    scenes: row.analysisScenes,
    artifactSummary,
  });
}

export async function getBookAnalysisArtifacts(params: {
  bookId: string;
  limit?: number;
}): Promise<BookAnalysisArtifactListDTO | null> {
  const bookId = String(params.bookId || "").trim();
  if (!bookId) return null;

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
    },
  });
  if (!book) return null;

  const limit = Math.min(200, Math.max(1, Number(params.limit || 50)));
  const [summary, rows] = await Promise.all([
    readBookAnalysisArtifactSummary(bookId),
    prisma.bookAnalysisArtifact.findMany({
      where: {
        bookId,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
      select: {
        id: true,
        bookId: true,
        chapterId: true,
        chapterOrderIndex: true,
        chapterTitle: true,
        chunkStartParagraph: true,
        chunkEndParagraph: true,
        attempt: true,
        phase: true,
        status: true,
        llmModel: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        elapsedMs: true,
        promptText: true,
        inputJson: true,
        responseText: true,
        parsedJson: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    bookId,
    limit,
    summary,
    items: rows.map((row: any) => toBookAnalysisArtifactDTO(row)),
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
      },
    });

    if (!book) {
      throw new BookAnalysisRequestError("BOOK_NOT_FOUND", 404, "Book not found");
    }

    if (book.analysisStatus === "queued" || book.analysisStatus === "running") {
      throw new BookAnalysisRequestError("ANALYSIS_ALREADY_RUNNING", 409, "Analysis is already queued or running");
    }

    await tx.bookScene.deleteMany({
      where: {
        bookId,
      },
    });

    await tx.bookAnalysisArtifact.deleteMany({
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
      },
    });

    await enqueueOutboxEvent({
      client: tx,
      aggregateType: "book",
      aggregateId: bookId,
      eventType: "book.npz-analysis.requested",
      payloadJson: {
        bookId,
        requestedAt,
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
    scenes: row.analysisScenes,
    artifactSummary,
  });
}

export function isBookAnalysisConfigured() {
  return hasVertexApiKey();
}
