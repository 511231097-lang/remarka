import { prisma } from "@remarka/db";
import {
  BOOK_PIPELINE_STAGE_KEYS,
  type BookAnalysisChapterStateDTO,
  type BookAnalysisStatusDTO,
  type BookAnalyzerStateDTO,
  type BookAnalyzerStatusDTO,
  type BookPipelineStageKeyDTO,
} from "@/lib/books";
import { buildBookCapabilitySnapshot } from "@/lib/bookCapabilitySnapshot";
import {
  buildAnalysisViews,
  buildBookChatReadiness,
  createEmptyAnalyzerStatus,
  normalizePipelineAnalyzers,
} from "@/lib/bookChatReadiness";

function cloneStatus(status: BookAnalyzerStatusDTO): BookAnalyzerStatusDTO {
  return {
    state: status.state,
    error: status.error,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
  };
}

function createAnalyzerStatuses(params: {
  status: "not_started" | "queued" | "running" | "completed" | "failed";
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}): Record<BookPipelineStageKeyDTO, BookAnalyzerStatusDTO> {
  const base = createEmptyAnalyzerStatus();
  const startedAtIso = params.startedAt ? params.startedAt.toISOString() : null;
  const finishedAtIso = params.finishedAt ? params.finishedAt.toISOString() : null;

  const filled = (state: BookAnalyzerStateDTO): BookAnalyzerStatusDTO => ({
    state,
    error: state === "failed" ? params.error || "Analysis failed" : null,
    startedAt: startedAtIso,
    completedAt: state === "completed" || state === "failed" ? finishedAtIso : null,
  });

  const out = Object.fromEntries(
    BOOK_PIPELINE_STAGE_KEYS.map((key) => [key, cloneStatus(base)])
  ) as Record<BookPipelineStageKeyDTO, BookAnalyzerStatusDTO>;

  if (params.status === "not_started") {
    return out;
  }

  if (params.status === "queued") {
    out.ingest_normalize = filled("queued");
    return out;
  }

  if (params.status === "running") {
    out.ingest_normalize = filled("completed");
    out.structural_pass = filled("running");
    for (const key of BOOK_PIPELINE_STAGE_KEYS) {
      if (key === "ingest_normalize" || key === "structural_pass") continue;
      out[key] = filled("queued");
    }
    return out;
  }

  if (params.status === "failed") {
    out.ingest_normalize = filled("failed");
    return out;
  }

  for (const key of BOOK_PIPELINE_STAGE_KEYS) {
    out[key] = filled("completed");
  }
  return out;
}

function toOverallState(status: "not_started" | "queued" | "running" | "completed" | "failed"): BookAnalysisStatusDTO["overallState"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "queued";
}

function toCoverage(status: "not_started" | "queued" | "running" | "completed" | "failed", sceneCount: number): BookAnalysisStatusDTO["coverage"] {
  if (status === "completed") return sceneCount > 0 ? "full" : "partial";
  if (status === "running" || status === "queued") return sceneCount > 0 ? "partial" : "unknown";
  if (status === "failed") return sceneCount > 0 ? "partial" : "unknown";
  return "unknown";
}

function asInt(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asIso(value: unknown): string | null {
  if (!value) return null;
  const ts = Date.parse(String(value));
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function toChapterState(value: unknown): BookAnalysisChapterStateDTO {
  const normalized = asString(value).toLowerCase();
  if (normalized === "running") return "running";
  if (normalized === "completed") return "completed";
  if (normalized === "failed") return "failed";
  return "queued";
}

function normalizeChapterStats(value: unknown): BookAnalysisStatusDTO["chapterStats"] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const totalBlocks = Math.max(0, asInt(row.totalBlocks));
      const checkedBlocks = Math.max(0, asInt(row.checkedBlocks));

      return {
        chapterId: asString(row.chapterId),
        chapterOrderIndex: Math.max(0, asInt(row.chapterOrderIndex)),
        chapterTitle: asString(row.chapterTitle) || "Без названия",
        state: toChapterState(row.status),
        totalBlocks,
        checkedBlocks,
        remainingBlocks: Math.max(0, totalBlocks - checkedBlocks),
        startedAt: asIso(row.startedAt),
        completedAt: asIso(row.finishedAt),
      } satisfies BookAnalysisStatusDTO["chapterStats"][number];
    })
    .filter((item): item is BookAnalysisStatusDTO["chapterStats"][number] => Boolean(item))
    .sort((left, right) => left.chapterOrderIndex - right.chapterOrderIndex);
}

export async function buildBookAnalysisStatusDTO(bookId: string): Promise<BookAnalysisStatusDTO> {
  const [book, sourceChapterCount, sceneCount, paragraphEmbeddingCount] = await Promise.all([
    prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        analysisStatus: true,
        analysisError: true,
        analysisStartedAt: true,
        analysisFinishedAt: true,
        analysisChapterStatsJson: true,
      },
    }),
    prisma.bookChapter.count({ where: { bookId } }),
    prisma.bookAnalysisScene.count({ where: { bookId } }),
    prisma.bookParagraphEmbedding.count({ where: { bookId } }),
  ]);

  const resolvedStatus =
    book?.analysisStatus === "queued" ||
    book?.analysisStatus === "running" ||
    book?.analysisStatus === "completed" ||
    book?.analysisStatus === "failed"
      ? book.analysisStatus
      : "not_started";

  const analyzers = normalizePipelineAnalyzers({
    analyzers: createAnalyzerStatuses({
      status: resolvedStatus,
      error: book?.analysisError || null,
      startedAt: book?.analysisStartedAt || null,
      finishedAt: book?.analysisFinishedAt || null,
    }),
    presence: {
      paragraphs: paragraphEmbeddingCount > 0,
      sentences: false,
      scenes: sceneCount > 0,
      entities: sceneCount > 0,
      events: sceneCount > 0,
      summaries: sceneCount > 0,
      evidence: sceneCount > 0,
      quotes: sceneCount > 0,
    },
  });

  const counts = {
    source: {
      chapters: sourceChapterCount,
      paragraphs: paragraphEmbeddingCount,
      windows: 0,
    },
    observations: {
      total: sceneCount,
      valid: sceneCount,
      invalid: 0,
    },
    canonical: {
      entities: sceneCount > 0 ? 1 : 0,
      scenes: sceneCount,
      events: sceneCount > 0 ? 1 : 0,
      relations: 0,
      quotes: 0,
      summaries: sceneCount > 0 ? 1 : 0,
    },
    readLayer: {
      entityCards: 0,
      sceneCards: 0,
      relationCards: 0,
      timelineSlices: 0,
      quoteSlices: 0,
      searchDocuments: paragraphEmbeddingCount,
      evidenceHits: sceneCount,
      presenceMaps: sceneCount > 0 ? 1 : 0,
      processingReports: 0,
    },
  };

  const overallState = toOverallState(resolvedStatus);
  const coverage = toCoverage(resolvedStatus, sceneCount);
  const capabilitySnapshot = buildBookCapabilitySnapshot({
    bookId,
    contentVersion: sceneCount > 0 ? 1 : null,
    overallState,
    coverage,
    analyzers,
    counts,
  });

  const views = buildAnalysisViews({
    analyzers,
    presence: {
      paragraphs: paragraphEmbeddingCount > 0,
      sentences: false,
      scenes: sceneCount > 0,
      entities: sceneCount > 0,
      events: sceneCount > 0,
      summaries: sceneCount > 0,
      evidence: sceneCount > 0,
      quotes: false,
    },
  });

  const chatReadiness = buildBookChatReadiness(analyzers, capabilitySnapshot);
  const chapterStats = normalizeChapterStats(book?.analysisChapterStatsJson);
  const shouldPoll = resolvedStatus === "queued" || resolvedStatus === "running";

  return {
    bookId,
    contentVersion: sceneCount > 0 ? 1 : null,
    overallState,
    coverage,
    capabilitySnapshot,
    analyzers,
    views,
    chatReadiness,
    counts,
    unresolvedIssues: {
      paragraphsWithoutScene: 0,
      ambiguousEntities: 0,
      validationFailures: 0,
    },
    chapterStats,
    shouldPoll,
    pollIntervalMs: shouldPoll ? 2500 : 0,
  };
}
