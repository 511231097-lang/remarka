export type BookAnalysisStatus = "not_started" | "queued" | "running" | "completed" | "failed";

export interface BookAnalysisChapterStatDTO {
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  status: "pending" | "running" | "completed" | "failed";
  totalBlocks: number;
  checkedBlocks: number;
  remainingBlocks: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmModel: string;
  embeddingModel: string;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  llmTotalTokens: number;
  embeddingInputTokens: number;
  embeddingTotalTokens: number;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
  chunkCount: number;
  chunkFailedCount: number;
  llmCalls: number;
  llmRetries: number;
  llmLatencyMs: number;
  llmAvgLatencyMs: number;
  embeddingCalls: number;
  embeddingLatencyMs: number;
  embeddingAvgLatencyMs: number;
  blocksPerMinute: number;
  tokensPerSecond: number;
}

export interface BookAnalysisArtifactSummaryDTO {
  total: number;
  failed: number;
  lastArtifactAt: string | null;
}

export interface BookAnalysisPerformanceDTO {
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
  blocksPerMinute: number;
  tokensPerSecond: number;
  chunkCount: number;
  chunkFailedCount: number;
  llmCalls: number;
  llmRetries: number;
  llmLatencyMs: number;
  llmAvgLatencyMs: number;
  embeddingCalls: number;
  embeddingLatencyMs: number;
  embeddingAvgLatencyMs: number;
}

export interface BookAnalysisArtifactDTO {
  id: string;
  runId: string | null;
  bookId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  chunkStartParagraph: number;
  chunkEndParagraph: number;
  attempt: number;
  stageKey: string | null;
  phase: string;
  status: "ok" | "error";
  llmModel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  elapsedMs: number;
  storageProvider: string | null;
  payloadKey: string | null;
  payloadSizeBytes: number;
  compression: string | null;
  schemaVersion: string | null;
  promptText: string | null;
  input: Record<string, unknown>;
  responseText: string | null;
  parsed: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface BookAnalysisArtifactListDTO {
  bookId: string;
  runId: string | null;
  limit: number;
  summary: BookAnalysisArtifactSummaryDTO;
  items: BookAnalysisArtifactDTO[];
}

export interface SceneEvidenceSpanDTO {
  label: string;
  paragraphStart: number;
  paragraphEnd: number;
}

export interface SceneDTO {
  sceneId: string;
  bookId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  sceneIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
  locationLabel: string | null;
  timeLabel: string | null;
  participants: string[];
  mentionedEntities: string[];
  locationHints: string[];
  timeHints: string[];
  eventLabels: string[];
  unresolvedForms: string[];
  facts: string[];
  evidenceSpans: SceneEvidenceSpanDTO[];
  sceneCard: string;
  sceneSummary: string;
  changeSignal: string;
  excerptText: string;
}

export interface BookAnalysisDTO {
  configured: boolean;
  status: BookAnalysisStatus;
  checkedBlocks: number;
  totalBlocks: number;
  remainingBlocks: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  chapterStats: BookAnalysisChapterStatDTO[];
  performance: BookAnalysisPerformanceDTO;
  artifacts: BookAnalysisArtifactSummaryDTO;
  error: string | null;
  updatedAt: string;
  scenes: SceneDTO[];
}

function asInt(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNonNegativeInt(value: unknown, fallback = 0): number {
  return Math.max(0, asInt(value, fallback));
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asNullableIso(value: unknown): string | null {
  if (!value) return null;
  const ts = Date.parse(String(value));
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter(Boolean);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeEvidenceSpans(value: unknown): SceneEvidenceSpanDTO[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const paragraphStart = asNonNegativeInt(row.paragraphStart);
      const paragraphEnd = asNonNegativeInt(row.paragraphEnd);
      const label = asString(row.label);
      if (!label || paragraphStart <= 0 || paragraphEnd <= 0 || paragraphStart > paragraphEnd) {
        return null;
      }

      return {
        label,
        paragraphStart,
        paragraphEnd,
      } satisfies SceneEvidenceSpanDTO;
    })
    .filter((item): item is SceneEvidenceSpanDTO => Boolean(item));
}

function normalizeAnalysisStatus(value: unknown): BookAnalysisStatus {
  const normalized = asString(value);
  if (
    normalized === "not_started" ||
    normalized === "queued" ||
    normalized === "running" ||
    normalized === "completed" ||
    normalized === "failed"
  ) {
    return normalized;
  }

  return "not_started";
}

function normalizeChapterAnalysisStatus(value: unknown): BookAnalysisChapterStatDTO["status"] {
  const normalized = asString(value);
  if (normalized === "pending" || normalized === "running" || normalized === "completed" || normalized === "failed") {
    return normalized;
  }
  return "pending";
}

function normalizeChapterStats(value: unknown): BookAnalysisChapterStatDTO[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const totalBlocks = asNonNegativeInt(row.totalBlocks);
      const checkedBlocks = asNonNegativeInt(row.checkedBlocks);
      const llmPromptTokens = asNonNegativeInt(row.llmPromptTokens, asNonNegativeInt(row.promptTokens));
      const llmCompletionTokens = asNonNegativeInt(row.llmCompletionTokens, asNonNegativeInt(row.completionTokens));
      const llmTotalTokens = Math.max(
        asNonNegativeInt(row.llmTotalTokens, asNonNegativeInt(row.totalTokens)),
        llmPromptTokens + llmCompletionTokens
      );
      const embeddingInputTokens = asNonNegativeInt(row.embeddingInputTokens);
      const embeddingTotalTokens = Math.max(asNonNegativeInt(row.embeddingTotalTokens), embeddingInputTokens);
      const promptTokens = asNonNegativeInt(row.promptTokens, llmPromptTokens + embeddingInputTokens);
      const completionTokens = asNonNegativeInt(row.completionTokens, llmCompletionTokens);
      const totalTokens = Math.max(
        asNonNegativeInt(row.totalTokens, llmTotalTokens + embeddingTotalTokens),
        promptTokens + completionTokens
      );
      const elapsedMs = asNonNegativeInt(row.elapsedMs);
      const llmCalls = asNonNegativeInt(row.llmCalls);
      const embeddingCalls = asNonNegativeInt(row.embeddingCalls);
      const llmLatencyMs = asNonNegativeInt(row.llmLatencyMs);
      const embeddingLatencyMs = asNonNegativeInt(row.embeddingLatencyMs);
      const blocksPerMinute =
        elapsedMs > 0 ? Number(((checkedBlocks / elapsedMs) * 60_000).toFixed(3)) : 0;
      const tokensPerSecond =
        elapsedMs > 0 ? Number((totalTokens / (elapsedMs / 1000)).toFixed(3)) : 0;

      return {
        chapterId: asString(row.chapterId),
        chapterOrderIndex: asNonNegativeInt(row.chapterOrderIndex),
        chapterTitle: asString(row.chapterTitle),
        status: normalizeChapterAnalysisStatus(row.status),
        totalBlocks,
        checkedBlocks,
        remainingBlocks: Math.max(0, totalBlocks - checkedBlocks),
        promptTokens,
        completionTokens,
        totalTokens,
        llmModel: asString(row.llmModel) || "unknown-chat-model",
        embeddingModel: asString(row.embeddingModel) || "unknown-embedding-model",
        llmPromptTokens,
        llmCompletionTokens,
        llmTotalTokens,
        embeddingInputTokens,
        embeddingTotalTokens,
        startedAt: asNullableIso(row.startedAt),
        finishedAt: asNullableIso(row.finishedAt),
        elapsedMs,
        chunkCount: asNonNegativeInt(row.chunkCount),
        chunkFailedCount: asNonNegativeInt(row.chunkFailedCount),
        llmCalls,
        llmRetries: asNonNegativeInt(row.llmRetries),
        llmLatencyMs,
        llmAvgLatencyMs: llmCalls > 0 ? Number((llmLatencyMs / llmCalls).toFixed(3)) : 0,
        embeddingCalls,
        embeddingLatencyMs,
        embeddingAvgLatencyMs: embeddingCalls > 0 ? Number((embeddingLatencyMs / embeddingCalls).toFixed(3)) : 0,
        blocksPerMinute,
        tokensPerSecond,
      } satisfies BookAnalysisChapterStatDTO;
    })
    .filter((item): item is BookAnalysisChapterStatDTO => Boolean(item && item.chapterId));
}

function computeBookAnalysisPerformance(params: {
  chapterStats: BookAnalysisChapterStatDTO[];
  checkedBlocks: number;
  totalTokens: number;
  startedAt: string | null;
  finishedAt: string | null;
}): BookAnalysisPerformanceDTO {
  const startedTs = params.startedAt ? Date.parse(params.startedAt) : Number.NaN;
  const finishedTs = params.finishedAt ? Date.parse(params.finishedAt) : Number.NaN;
  const elapsedByBookTimestamps =
    Number.isFinite(startedTs) && Number.isFinite(finishedTs) && finishedTs >= startedTs
      ? Math.round(finishedTs - startedTs)
      : 0;
  const elapsedByChapters = params.chapterStats.reduce((sum, chapter) => sum + chapter.elapsedMs, 0);
  const elapsedMs = Math.max(elapsedByBookTimestamps, elapsedByChapters);
  const chunkCount = params.chapterStats.reduce((sum, chapter) => sum + chapter.chunkCount, 0);
  const chunkFailedCount = params.chapterStats.reduce((sum, chapter) => sum + chapter.chunkFailedCount, 0);
  const llmCalls = params.chapterStats.reduce((sum, chapter) => sum + chapter.llmCalls, 0);
  const llmRetries = params.chapterStats.reduce((sum, chapter) => sum + chapter.llmRetries, 0);
  const llmLatencyMs = params.chapterStats.reduce((sum, chapter) => sum + chapter.llmLatencyMs, 0);
  const embeddingCalls = params.chapterStats.reduce((sum, chapter) => sum + chapter.embeddingCalls, 0);
  const embeddingLatencyMs = params.chapterStats.reduce((sum, chapter) => sum + chapter.embeddingLatencyMs, 0);
  const blocksPerMinute =
    elapsedMs > 0 ? Number(((params.checkedBlocks / elapsedMs) * 60_000).toFixed(3)) : 0;
  const tokensPerSecond =
    elapsedMs > 0 ? Number((params.totalTokens / (elapsedMs / 1000)).toFixed(3)) : 0;

  return {
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    elapsedMs,
    blocksPerMinute,
    tokensPerSecond,
    chunkCount,
    chunkFailedCount,
    llmCalls,
    llmRetries,
    llmLatencyMs,
    llmAvgLatencyMs: llmCalls > 0 ? Number((llmLatencyMs / llmCalls).toFixed(3)) : 0,
    embeddingCalls,
    embeddingLatencyMs,
    embeddingAvgLatencyMs: embeddingCalls > 0 ? Number((embeddingLatencyMs / embeddingCalls).toFixed(3)) : 0,
  };
}

export function toBookAnalysisArtifactDTO(row: {
  id: string;
  runId?: string | null;
  bookId: string;
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  chunkStartParagraph: number;
  chunkEndParagraph: number;
  attempt: number;
  stageKey?: string | null;
  phase: string;
  status: string;
  llmModel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  elapsedMs: number;
  storageProvider?: string | null;
  payloadKey?: string | null;
  payloadSizeBytes?: number;
  compression?: string | null;
  schemaVersion?: string | null;
  promptText: string | null;
  inputJson: unknown | null;
  responseText: string | null;
  parsedJson: unknown;
  errorMessage: string | null;
  createdAt: Date | string;
}): BookAnalysisArtifactDTO {
  const status = asString(row.status).toLowerCase() === "ok" ? "ok" : "error";
  const parsedRecord = toRecord(row.parsedJson);
  return {
    id: row.id,
    runId: row.runId ? String(row.runId) : null,
    bookId: row.bookId,
    chapterId: row.chapterId,
    chapterOrderIndex: asNonNegativeInt(row.chapterOrderIndex),
    chapterTitle: asString(row.chapterTitle),
    chunkStartParagraph: asNonNegativeInt(row.chunkStartParagraph),
    chunkEndParagraph: asNonNegativeInt(row.chunkEndParagraph),
    attempt: Math.max(1, asNonNegativeInt(row.attempt, 1)),
    stageKey: row.stageKey ? String(row.stageKey) : null,
    phase: asString(row.phase),
    status,
    llmModel: asString(row.llmModel),
    promptTokens: asNonNegativeInt(row.promptTokens),
    completionTokens: asNonNegativeInt(row.completionTokens),
    totalTokens: asNonNegativeInt(row.totalTokens),
    elapsedMs: asNonNegativeInt(row.elapsedMs),
    storageProvider: row.storageProvider ? String(row.storageProvider) : null,
    payloadKey: row.payloadKey ? String(row.payloadKey) : null,
    payloadSizeBytes: asNonNegativeInt(row.payloadSizeBytes),
    compression: row.compression ? String(row.compression) : null,
    schemaVersion: row.schemaVersion ? String(row.schemaVersion) : null,
    promptText: row.promptText ? String(row.promptText) : null,
    input: toRecord(row.inputJson),
    responseText: row.responseText ? String(row.responseText) : null,
    parsed: Object.keys(parsedRecord).length ? parsedRecord : null,
    errorMessage: row.errorMessage ? String(row.errorMessage) : null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

export function toBookAnalysisDTO(params: {
  configured: boolean;
  book: {
    id: string;
    analysisStatus: unknown;
    analysisError: string | null;
    analysisTotalBlocks: number;
    analysisCheckedBlocks: number;
    analysisPromptTokens: number;
    analysisCompletionTokens: number;
    analysisTotalTokens: number;
    analysisChapterStatsJson: unknown;
    analysisStartedAt: Date | string | null;
    analysisFinishedAt: Date | string | null;
    updatedAt: Date | string;
  };
  artifactSummary?: {
    total?: number;
    failed?: number;
    lastArtifactAt?: string | null;
  };
  scenes: Array<{
    id: string;
    bookId: string;
    chapterId: string;
    sceneIndex: number;
    paragraphStart: number;
    paragraphEnd: number;
    locationLabel: string | null;
    timeLabel: string | null;
    participantsJson: unknown;
    mentionedEntitiesJson: unknown;
    locationHintsJson: unknown;
    timeHintsJson: unknown;
    eventLabelsJson: unknown;
    unresolvedFormsJson: unknown;
    factsJson: unknown;
    evidenceSpansJson: unknown;
    sceneCard: string;
    sceneSummary: string;
    changeSignal: string;
    excerptText: string;
    chapter: {
      orderIndex: number;
      title: string;
    };
  }>;
}): BookAnalysisDTO {
  const totalBlocks = asNonNegativeInt(params.book.analysisTotalBlocks);
  const checkedBlocks = asNonNegativeInt(params.book.analysisCheckedBlocks);
  const chapterStats = normalizeChapterStats(params.book.analysisChapterStatsJson);
  const startedAt = asNullableIso(params.book.analysisStartedAt);
  const finishedAt = asNullableIso(params.book.analysisFinishedAt);
  const totalTokens = asNonNegativeInt(params.book.analysisTotalTokens);
  const artifacts: BookAnalysisArtifactSummaryDTO = {
    total: asNonNegativeInt(params.artifactSummary?.total),
    failed: asNonNegativeInt(params.artifactSummary?.failed),
    lastArtifactAt: asNullableIso(params.artifactSummary?.lastArtifactAt || null),
  };

  return {
    configured: Boolean(params.configured),
    status: normalizeAnalysisStatus(params.book.analysisStatus),
    checkedBlocks,
    totalBlocks,
    remainingBlocks: Math.max(0, totalBlocks - checkedBlocks),
    promptTokens: asNonNegativeInt(params.book.analysisPromptTokens),
    completionTokens: asNonNegativeInt(params.book.analysisCompletionTokens),
    totalTokens,
    chapterStats,
    performance: computeBookAnalysisPerformance({
      chapterStats,
      checkedBlocks,
      totalTokens,
      startedAt,
      finishedAt,
    }),
    artifacts,
    error: params.book.analysisError ? String(params.book.analysisError) : null,
    updatedAt: new Date(params.book.updatedAt).toISOString(),
    scenes: params.scenes
      .slice()
      .sort((left, right) => {
        if (left.chapter.orderIndex !== right.chapter.orderIndex) {
          return left.chapter.orderIndex - right.chapter.orderIndex;
        }
        return left.sceneIndex - right.sceneIndex;
      })
      .map((scene) => ({
        ...(() => {
          const locationHints = asStringArray(scene.locationHintsJson);
          const timeHints = asStringArray(scene.timeHintsJson);
          const fallbackLocation = scene.locationLabel ? String(scene.locationLabel).trim() : "";
          const fallbackTime = scene.timeLabel ? String(scene.timeLabel).trim() : "";
          return {
            locationHints: locationHints.length ? locationHints : fallbackLocation ? [fallbackLocation] : [],
            timeHints: timeHints.length ? timeHints : fallbackTime ? [fallbackTime] : [],
          };
        })(),
        sceneId: scene.id,
        bookId: scene.bookId,
        chapterId: scene.chapterId,
        chapterOrderIndex: asNonNegativeInt(scene.chapter.orderIndex),
        chapterTitle: asString(scene.chapter.title),
        sceneIndex: asNonNegativeInt(scene.sceneIndex),
        paragraphStart: asNonNegativeInt(scene.paragraphStart),
        paragraphEnd: asNonNegativeInt(scene.paragraphEnd),
        locationLabel: scene.locationLabel ? String(scene.locationLabel) : null,
        timeLabel: scene.timeLabel ? String(scene.timeLabel) : null,
        participants: asStringArray(scene.participantsJson),
        mentionedEntities: asStringArray(scene.mentionedEntitiesJson),
        eventLabels: asStringArray(scene.eventLabelsJson),
        unresolvedForms: asStringArray(scene.unresolvedFormsJson),
        facts: asStringArray(scene.factsJson),
        evidenceSpans: normalizeEvidenceSpans(scene.evidenceSpansJson),
        sceneCard: asString(scene.sceneCard),
        sceneSummary: asString(scene.sceneSummary),
        changeSignal: asString(scene.changeSignal),
        excerptText: asString(scene.excerptText),
      })),
  };
}
