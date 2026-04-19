import { prisma } from "./client";
import {
  createBookAnalysisRun,
  ensureBookContentVersion,
  replaceBookChatToolRuns,
  upsertBookAnalysisChapterMetric,
  upsertBookChatTurnMetric,
  upsertBookStageExecution,
} from "./bookMetricsStore";
import { resolvePricingVersion, resolveTokenPricing } from "./modelPricing";

const ANALYSIS_CONFIG_VERSION = "legacy-backfill-v1";
const CHAT_PROMPT_VARIANT = "legacy-chat-json-v1";
const CHAT_SYSTEM_PROMPT_VERSION = "legacy-json-v0";
const ANALYSIS_PARAGRAPH_STAGE = "paragraph_embeddings";
const ANALYSIS_SCENE_CHUNK_STAGE = "scene_chunk_llm";
const ANALYSIS_SCENE_EMBEDDING_STAGE = "scene_embeddings";
const ANALYSIS_FINALIZE_STAGE = "finalize";
const VALID_CHAT_TOOL_NAMES = new Set([
  "search_paragraphs_hybrid",
  "search_scenes",
  "get_scene_context",
  "get_paragraph_slice",
]);

type LegacyChapterStat = {
  chapterId: string;
  chapterOrderIndex: number;
  chapterTitle: string;
  status: "pending" | "running" | "completed" | "failed";
  llmModel: string;
  embeddingModel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  llmTotalTokens: number;
  embeddingInputTokens: number;
  embeddingTotalTokens: number;
  elapsedMs: number;
  llmLatencyMs: number;
  embeddingLatencyMs: number;
  llmCalls: number;
  llmRetries: number;
  embeddingCalls: number;
  chunkCount: number;
  chunkFailedCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
};

type LegacyChatMetrics = {
  chatModel: string;
  embeddingModel: string;
  pricingVersion: string;
  selectedTools: string[];
  toolConfigKey: string;
  promptVariant: string;
  systemPromptVersion: string;
  modelInputTokens: number;
  modelOutputTokens: number;
  modelTotalTokens: number;
  embeddingInputTokens: number;
  chatCostUsd: number;
  embeddingCostUsd: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  answerLengthChars: number;
  citationCount: number;
  fallbackUsed: boolean;
  fallbackKind: string | null;
};

type LegacyToolRun = {
  toolName: string;
  argsSummaryJson: Record<string, unknown>;
  resultSummaryJson: Record<string, unknown>;
  latencyMs: number;
  errorCode: string | null;
  errorMessage: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asInt(value: unknown, fallback = 0): number {
  return Math.max(0, Math.round(asNumber(value, fallback)));
}

function asIsoDate(value: unknown): Date | null {
  const normalized = asString(value);
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp);
}

function normalizeRunState(value: unknown): "queued" | "running" | "completed" | "failed" {
  const normalized = asString(value);
  if (normalized === "queued" || normalized === "running" || normalized === "completed" || normalized === "failed") {
    return normalized;
  }
  if (normalized === "not_started") return "queued";
  return "queued";
}

function parseLegacyChapterStats(value: unknown): LegacyChapterStat[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      const row = asRecord(item);
      const chapterId = asString(row.chapterId);
      if (!chapterId) return null;

      const status = normalizeRunState(row.status);
      return {
        chapterId,
        chapterOrderIndex: asInt(row.chapterOrderIndex),
        chapterTitle: asString(row.chapterTitle),
        status,
        llmModel: asString(row.llmModel),
        embeddingModel: asString(row.embeddingModel),
        promptTokens: asInt(row.promptTokens),
        completionTokens: asInt(row.completionTokens),
        totalTokens: asInt(row.totalTokens),
        llmPromptTokens: asInt(row.llmPromptTokens),
        llmCompletionTokens: asInt(row.llmCompletionTokens),
        llmTotalTokens: asInt(row.llmTotalTokens),
        embeddingInputTokens: asInt(row.embeddingInputTokens),
        embeddingTotalTokens: asInt(row.embeddingTotalTokens || row.embeddingInputTokens),
        elapsedMs: asInt(row.elapsedMs),
        llmLatencyMs: asInt(row.llmLatencyMs),
        embeddingLatencyMs: asInt(row.embeddingLatencyMs),
        llmCalls: asInt(row.llmCalls),
        llmRetries: asInt(row.llmRetries),
        embeddingCalls: asInt(row.embeddingCalls),
        chunkCount: asInt(row.chunkCount),
        chunkFailedCount: asInt(row.chunkFailedCount),
        startedAt: asIsoDate(row.startedAt),
        finishedAt: asIsoDate(row.finishedAt),
      } satisfies LegacyChapterStat;
    })
    .filter((item): item is LegacyChapterStat => Boolean(item));
}

function parseLegacyToolRuns(value: unknown): LegacyToolRun[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      const row = asRecord(item);
      const toolName = asString(row.tool);
      if (!VALID_CHAT_TOOL_NAMES.has(toolName)) return null;
      const argsSummaryJson = asRecord(row.args);
      const resultSummaryJson = asRecord(row.resultMeta);
      const errorMessage = typeof resultSummaryJson.error === "string" ? String(resultSummaryJson.error) : null;

      return {
        toolName,
        argsSummaryJson,
        resultSummaryJson,
        latencyMs: asInt(resultSummaryJson.totalMs),
        errorCode: errorMessage,
        errorMessage,
        orderIndex: index,
      };
    })
    .filter((item): item is LegacyToolRun & { orderIndex: number } => Boolean(item))
    .sort((left, right) => left.orderIndex - right.orderIndex)
    .map(({ orderIndex: _ignored, ...item }) => item);
}

function buildToolConfigKey(tools: string[]): string {
  return tools.length ? [...tools].sort().join("|") : "none";
}

function normalizeSelectedTools(metricsRow: Record<string, unknown>, toolRuns: LegacyToolRun[]): string[] {
  const explicit = Array.isArray(metricsRow.selectedTools)
    ? metricsRow.selectedTools.map((item) => asString(item)).filter((tool) => VALID_CHAT_TOOL_NAMES.has(tool))
    : [];
  if (explicit.length) return [...new Set(explicit)];
  return [...new Set(toolRuns.map((run) => run.toolName).filter((tool) => VALID_CHAT_TOOL_NAMES.has(tool)))];
}

function computeChatCostBreakdown(params: {
  chatModel: string;
  embeddingModel: string;
  modelInputTokens: number;
  modelOutputTokens: number;
  embeddingInputTokens: number;
}) {
  const pricing = resolveTokenPricing({
    chatModel: params.chatModel,
    embeddingModel: params.embeddingModel,
  });
  const chatCostUsd =
    (Math.max(0, params.modelInputTokens) / 1_000_000) * pricing.chatInputPer1MUsd +
    (Math.max(0, params.modelOutputTokens) / 1_000_000) * pricing.chatOutputPer1MUsd;
  const embeddingCostUsd = (Math.max(0, params.embeddingInputTokens) / 1_000_000) * pricing.embeddingInputPer1MUsd;

  return {
    chatCostUsd,
    embeddingCostUsd,
    totalCostUsd: chatCostUsd + embeddingCostUsd,
  };
}

function parseLegacyChatMetrics(params: {
  content: string;
  citationsJson: unknown;
  metricsJson: unknown;
  toolRunsJson: unknown;
}): { metrics: LegacyChatMetrics; toolRuns: LegacyToolRun[] } | null {
  const metricsRow = asRecord(params.metricsJson);
  const toolRuns = parseLegacyToolRuns(params.toolRunsJson);
  if (!Object.keys(metricsRow).length && !toolRuns.length) return null;

  const chatModel = asString(metricsRow.chatModel) || "unknown-chat-model";
  const embeddingModel = asString(metricsRow.embeddingModel) || "unknown-embedding-model";
  const selectedTools = normalizeSelectedTools(metricsRow, toolRuns);
  const toolConfigKey = asString(metricsRow.toolConfigKey) || buildToolConfigKey(selectedTools);
  const pricingVersion = asString(metricsRow.pricingVersion) || resolvePricingVersion();
  const modelInputTokens = asInt(metricsRow.modelInputTokens);
  const modelOutputTokens = asInt(metricsRow.modelOutputTokens);
  const modelTotalTokens = asInt(metricsRow.modelTotalTokens || modelInputTokens + modelOutputTokens);
  const embeddingInputTokens = asInt(metricsRow.embeddingInputTokens);
  const computedCosts = computeChatCostBreakdown({
    chatModel,
    embeddingModel,
    modelInputTokens,
    modelOutputTokens,
    embeddingInputTokens,
  });
  const citations = Array.isArray(params.citationsJson) ? params.citationsJson : [];

  return {
    metrics: {
      chatModel,
      embeddingModel,
      pricingVersion,
      selectedTools,
      toolConfigKey,
      promptVariant: asString(metricsRow.promptVariant) || CHAT_PROMPT_VARIANT,
      systemPromptVersion: asString(metricsRow.systemPromptVersion) || CHAT_SYSTEM_PROMPT_VERSION,
      modelInputTokens,
      modelOutputTokens,
      modelTotalTokens,
      embeddingInputTokens,
      chatCostUsd: asNumber(metricsRow.chatCostUsd, computedCosts.chatCostUsd),
      embeddingCostUsd: asNumber(metricsRow.embeddingCostUsd, computedCosts.embeddingCostUsd),
      totalCostUsd: asNumber(metricsRow.totalCostUsd, computedCosts.totalCostUsd),
      totalLatencyMs: asInt(metricsRow.totalLatencyMs),
      answerLengthChars: asInt(metricsRow.answerLengthChars || params.content.length),
      citationCount: asInt(metricsRow.citationCount || citations.length),
      fallbackUsed: Boolean(metricsRow.fallbackUsed),
      fallbackKind: asString(metricsRow.fallbackKind) || null,
    },
    toolRuns,
  };
}

function allocateByCounts(total: number, firstCount: number, secondCount: number) {
  const normalizedTotal = Math.max(0, Math.round(Number(total || 0)));
  const left = Math.max(0, Math.round(Number(firstCount || 0)));
  const right = Math.max(0, Math.round(Number(secondCount || 0)));
  const denominator = left + right;
  if (denominator <= 0) {
    return {
      first: normalizedTotal,
      second: 0,
    };
  }

  const first = Math.round((normalizedTotal * left) / denominator);
  return {
    first,
    second: Math.max(0, normalizedTotal - first),
  };
}

function mapStageState(params: {
  runState: "queued" | "running" | "completed" | "failed";
  hasOutput: boolean;
  isSceneChunk?: boolean;
  isFinalize?: boolean;
}) {
  if (params.isFinalize) return params.runState;
  if (params.runState === "completed") return "completed";
  if (params.runState === "failed") return params.hasOutput && !params.isSceneChunk ? "completed" : "failed";
  if (params.runState === "running") return params.hasOutput ? "completed" : "running";
  return params.hasOutput ? "completed" : "queued";
}

function computeAnalysisCostBreakdown(params: {
  chatModel: string;
  embeddingModel: string;
  llmPromptTokens: number;
  llmCompletionTokens: number;
  embeddingInputTokens: number;
}) {
  const pricing = resolveTokenPricing({
    chatModel: params.chatModel,
    embeddingModel: params.embeddingModel,
  });
  const llmCostUsd =
    (Math.max(0, params.llmPromptTokens) / 1_000_000) * pricing.chatInputPer1MUsd +
    (Math.max(0, params.llmCompletionTokens) / 1_000_000) * pricing.chatOutputPer1MUsd;
  const embeddingCostUsd = (Math.max(0, params.embeddingInputTokens) / 1_000_000) * pricing.embeddingInputPer1MUsd;

  return {
    llmCostUsd,
    embeddingCostUsd,
    totalCostUsd: llmCostUsd + embeddingCostUsd,
  };
}

async function backfillAnalysisRuns() {
  const books = await prisma.book.findMany({
    where: {
      latestAnalysisRunId: null,
      OR: [
        {
          analysisStatus: {
            not: "not_started",
          },
        },
        {
          analysisScenes: {
            some: {},
          },
        },
        {
          analysisArtifacts: {
            some: {},
          },
        },
        {
          paragraphEmbeddings: {
            some: {},
          },
        },
      ],
    },
    select: {
      id: true,
      fileSha256: true,
      fileName: true,
      mimeType: true,
      analysisStatus: true,
      analysisError: true,
      analysisRequestedAt: true,
      analysisStartedAt: true,
      analysisFinishedAt: true,
      analysisCompletedAt: true,
      analysisPromptTokens: true,
      analysisCompletionTokens: true,
      analysisTotalTokens: true,
      analysisChapterStatsJson: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  let backfilled = 0;
  for (const book of books) {
    await prisma.$transaction(async (tx) => {
      const existingRun = await tx.bookAnalysisRun.findFirst({
        where: { bookId: book.id },
        orderBy: [{ createdAt: "desc" }],
        select: { id: true },
      });

      const contentVersion = await ensureBookContentVersion({
        client: tx,
        bookId: book.id,
        fileSha256: book.fileSha256,
        fileName: book.fileName,
        mimeType: book.mimeType,
      });

      const chapterStats = parseLegacyChapterStats(book.analysisChapterStatsJson);
      const runState = normalizeRunState(book.analysisStatus);
      const fallbackChatModel =
        chapterStats.find((row) => row.llmModel)?.llmModel || "gemini-3.1-flash-lite-preview";
      const fallbackEmbeddingModel =
        chapterStats.find((row) => row.embeddingModel)?.embeddingModel || "gemini-embedding-001";
      const runId =
        existingRun?.id ||
        (
          await createBookAnalysisRun({
            client: tx,
            bookId: book.id,
            contentVersionId: contentVersion.id,
            configVersion: ANALYSIS_CONFIG_VERSION,
            configHash: null,
            extractModel: fallbackChatModel,
            chatModel: fallbackChatModel,
            embeddingModel: fallbackEmbeddingModel,
            pricingVersion: resolvePricingVersion(),
            startedAt: book.analysisStartedAt || book.analysisRequestedAt || book.analysisFinishedAt || new Date(),
          })
        ).id;

      const [paragraphCounts, sceneCounts, sceneEmbeddingCounts, artifactCounts] = await Promise.all([
        tx.bookParagraphEmbedding.groupBy({
          by: ["chapterId"],
          where: { bookId: book.id },
          _count: { _all: true },
        }),
        tx.bookAnalysisScene.groupBy({
          by: ["chapterId"],
          where: { bookId: book.id },
          _count: { _all: true },
        }),
        tx.bookSceneEmbedding.groupBy({
          by: ["chapterId"],
          where: { bookId: book.id },
          _count: { _all: true },
        }),
        tx.bookAnalysisArtifact.groupBy({
          by: ["chapterId"],
          where: { bookId: book.id },
          _count: { _all: true },
        }),
      ]);

      const paragraphCountByChapter = new Map(paragraphCounts.map((row) => [row.chapterId, row._count._all]));
      const sceneCountByChapter = new Map(sceneCounts.map((row) => [row.chapterId, row._count._all]));
      const sceneEmbeddingCountByChapter = new Map(sceneEmbeddingCounts.map((row) => [row.chapterId, row._count._all]));
      const artifactCountByChapter = new Map(artifactCounts.map((row) => [row.chapterId, row._count._all]));

      const paragraphEmbeddingCount = paragraphCounts.reduce((sum, row) => sum + row._count._all, 0);
      const sceneCount = sceneCounts.reduce((sum, row) => sum + row._count._all, 0);
      const sceneEmbeddingCount = sceneEmbeddingCounts.reduce((sum, row) => sum + row._count._all, 0);
      const artifactCount = artifactCounts.reduce((sum, row) => sum + row._count._all, 0);
      const totals = chapterStats.reduce(
        (acc, row) => {
          acc.llmPromptTokens += row.llmPromptTokens || row.promptTokens;
          acc.llmCompletionTokens += row.llmCompletionTokens || row.completionTokens;
          acc.llmTotalTokens += row.llmTotalTokens || row.totalTokens;
          acc.embeddingInputTokens += row.embeddingInputTokens;
          acc.embeddingTotalTokens += row.embeddingTotalTokens || row.embeddingInputTokens;
          acc.llmLatencyMs += row.llmLatencyMs;
          acc.embeddingLatencyMs += row.embeddingLatencyMs;
          acc.chunkCount += row.chunkCount;
          acc.chunkFailedCount += row.chunkFailedCount;
          acc.llmCalls += row.llmCalls;
          acc.llmRetries += row.llmRetries;
          acc.embeddingCalls += row.embeddingCalls;
          return acc;
        },
        {
          llmPromptTokens: 0,
          llmCompletionTokens: 0,
          llmTotalTokens: 0,
          embeddingInputTokens: 0,
          embeddingTotalTokens: 0,
          llmLatencyMs: 0,
          embeddingLatencyMs: 0,
          chunkCount: 0,
          chunkFailedCount: 0,
          llmCalls: 0,
          llmRetries: 0,
          embeddingCalls: 0,
        }
      );

      const totalElapsedMs =
        book.analysisStartedAt && (book.analysisCompletedAt || book.analysisFinishedAt)
          ? Math.max(
              0,
              (book.analysisCompletedAt || book.analysisFinishedAt)!.getTime() - book.analysisStartedAt.getTime()
            )
          : 0;
      const runCost = computeAnalysisCostBreakdown({
        chatModel: fallbackChatModel,
        embeddingModel: fallbackEmbeddingModel,
        llmPromptTokens: totals.llmPromptTokens || book.analysisPromptTokens,
        llmCompletionTokens: totals.llmCompletionTokens || book.analysisCompletionTokens,
        embeddingInputTokens: totals.embeddingInputTokens,
      });
      const runCurrentStageKey =
        runState === "completed" ? ANALYSIS_FINALIZE_STAGE : runState === "failed" ? ANALYSIS_SCENE_CHUNK_STAGE : ANALYSIS_SCENE_CHUNK_STAGE;

      await tx.bookAnalysisRun.update({
        where: { id: runId },
        data: {
          state: runState,
          currentStageKey: runCurrentStageKey,
          error: book.analysisError,
          configVersion: ANALYSIS_CONFIG_VERSION,
          extractModel: fallbackChatModel,
          chatModel: fallbackChatModel,
          embeddingModel: fallbackEmbeddingModel,
          pricingVersion: resolvePricingVersion(),
          llmPromptTokens: totals.llmPromptTokens || book.analysisPromptTokens,
          llmCompletionTokens: totals.llmCompletionTokens || book.analysisCompletionTokens,
          llmTotalTokens: totals.llmTotalTokens || book.analysisTotalTokens,
          embeddingInputTokens: totals.embeddingInputTokens,
          embeddingTotalTokens: totals.embeddingTotalTokens,
          llmCostUsd: runCost.llmCostUsd,
          embeddingCostUsd: runCost.embeddingCostUsd,
          totalCostUsd: runCost.totalCostUsd,
          totalElapsedMs,
          llmLatencyMs: totals.llmLatencyMs,
          embeddingLatencyMs: totals.embeddingLatencyMs,
          chunkCount: totals.chunkCount,
          chunkFailedCount: totals.chunkFailedCount,
          llmCalls: totals.llmCalls,
          llmRetries: totals.llmRetries,
          embeddingCalls: totals.embeddingCalls,
          paragraphEmbeddingCount,
          sceneCount,
          artifactCount,
          qualityFlagsJson: { backfilledFromLegacy: true },
          startedAt: book.analysisStartedAt || book.analysisRequestedAt,
          completedAt: runState === "queued" || runState === "running" ? null : book.analysisCompletedAt || book.analysisFinishedAt,
        },
      });

      const runEmbeddingSplit = allocateByCounts(
        totals.embeddingInputTokens,
        paragraphEmbeddingCount,
        sceneEmbeddingCount
      );
      const runEmbeddingTotalSplit = allocateByCounts(
        totals.embeddingTotalTokens,
        paragraphEmbeddingCount,
        sceneEmbeddingCount
      );
      const runEmbeddingLatencySplit = allocateByCounts(
        totals.embeddingLatencyMs,
        paragraphEmbeddingCount,
        sceneEmbeddingCount
      );
      const runEmbeddingCallsSplit = allocateByCounts(
        totals.embeddingCalls,
        paragraphEmbeddingCount,
        sceneEmbeddingCount
      );

      const paragraphStageCost = computeAnalysisCostBreakdown({
        chatModel: fallbackChatModel,
        embeddingModel: fallbackEmbeddingModel,
        llmPromptTokens: 0,
        llmCompletionTokens: 0,
        embeddingInputTokens: runEmbeddingSplit.first,
      });
      const sceneEmbeddingStageCost = computeAnalysisCostBreakdown({
        chatModel: fallbackChatModel,
        embeddingModel: fallbackEmbeddingModel,
        llmPromptTokens: 0,
        llmCompletionTokens: 0,
        embeddingInputTokens: runEmbeddingSplit.second,
      });
      const sceneChunkStageCost = computeAnalysisCostBreakdown({
        chatModel: fallbackChatModel,
        embeddingModel: fallbackEmbeddingModel,
        llmPromptTokens: totals.llmPromptTokens || book.analysisPromptTokens,
        llmCompletionTokens: totals.llmCompletionTokens || book.analysisCompletionTokens,
        embeddingInputTokens: 0,
      });

      await upsertBookStageExecution({
        client: tx,
        bookId: book.id,
        contentVersionId: contentVersion.id,
        runId,
        stageKey: ANALYSIS_PARAGRAPH_STAGE,
        state: mapStageState({ runState, hasOutput: paragraphEmbeddingCount > 0 }),
        embeddingInputTokens: runEmbeddingSplit.first,
        embeddingTotalTokens: runEmbeddingTotalSplit.first,
        embeddingCostUsd: paragraphStageCost.embeddingCostUsd,
        totalCostUsd: paragraphStageCost.totalCostUsd,
        elapsedMs: runEmbeddingLatencySplit.first,
        embeddingCalls: runEmbeddingCallsSplit.first,
        outputRowCount: paragraphEmbeddingCount,
        startedAt: book.analysisStartedAt || book.analysisRequestedAt,
        completedAt: paragraphEmbeddingCount > 0 ? book.analysisCompletedAt || book.analysisFinishedAt : null,
      });
      await upsertBookStageExecution({
        client: tx,
        bookId: book.id,
        contentVersionId: contentVersion.id,
        runId,
        stageKey: ANALYSIS_SCENE_CHUNK_STAGE,
        state: mapStageState({ runState, hasOutput: artifactCount > 0 || totals.chunkCount > 0, isSceneChunk: true }),
        error: runState === "failed" ? book.analysisError : null,
        promptTokens: totals.llmPromptTokens || book.analysisPromptTokens,
        completionTokens: totals.llmCompletionTokens || book.analysisCompletionTokens,
        totalTokens: totals.llmTotalTokens || book.analysisTotalTokens,
        llmCostUsd: sceneChunkStageCost.llmCostUsd,
        totalCostUsd: sceneChunkStageCost.totalCostUsd,
        elapsedMs: totals.llmLatencyMs,
        retryCount: totals.llmRetries,
        llmCalls: totals.llmCalls,
        chunkCount: totals.chunkCount,
        chunkFailedCount: totals.chunkFailedCount,
        outputRowCount: artifactCount,
        startedAt: book.analysisStartedAt || book.analysisRequestedAt,
        completedAt: runState === "completed" || runState === "failed" ? book.analysisCompletedAt || book.analysisFinishedAt : null,
      });
      await upsertBookStageExecution({
        client: tx,
        bookId: book.id,
        contentVersionId: contentVersion.id,
        runId,
        stageKey: ANALYSIS_SCENE_EMBEDDING_STAGE,
        state: mapStageState({ runState, hasOutput: sceneEmbeddingCount > 0 }),
        embeddingInputTokens: runEmbeddingSplit.second,
        embeddingTotalTokens: runEmbeddingTotalSplit.second,
        embeddingCostUsd: sceneEmbeddingStageCost.embeddingCostUsd,
        totalCostUsd: sceneEmbeddingStageCost.totalCostUsd,
        elapsedMs: runEmbeddingLatencySplit.second,
        embeddingCalls: runEmbeddingCallsSplit.second,
        outputRowCount: sceneEmbeddingCount,
        startedAt: book.analysisStartedAt || book.analysisRequestedAt,
        completedAt: sceneEmbeddingCount > 0 ? book.analysisCompletedAt || book.analysisFinishedAt : null,
      });
      await upsertBookStageExecution({
        client: tx,
        bookId: book.id,
        contentVersionId: contentVersion.id,
        runId,
        stageKey: ANALYSIS_FINALIZE_STAGE,
        state: mapStageState({ runState, hasOutput: sceneCount > 0, isFinalize: true }),
        error: runState === "failed" ? book.analysisError : null,
        elapsedMs: totalElapsedMs,
        outputRowCount: sceneCount,
        startedAt: book.analysisStartedAt || book.analysisRequestedAt,
        completedAt: runState === "completed" || runState === "failed" ? book.analysisCompletedAt || book.analysisFinishedAt : null,
      });

      for (const chapter of chapterStats) {
        const chapterParagraphCount = paragraphCountByChapter.get(chapter.chapterId) || 0;
        const chapterSceneEmbeddingCount = sceneEmbeddingCountByChapter.get(chapter.chapterId) || 0;
        const chapterSceneCount = sceneCountByChapter.get(chapter.chapterId) || 0;
        const chapterArtifactCount = artifactCountByChapter.get(chapter.chapterId) || 0;
        const chapterEmbeddingSplit = allocateByCounts(
          chapter.embeddingInputTokens,
          chapterParagraphCount,
          chapterSceneEmbeddingCount
        );
        const chapterEmbeddingTotalSplit = allocateByCounts(
          chapter.embeddingTotalTokens,
          chapterParagraphCount,
          chapterSceneEmbeddingCount
        );
        const chapterEmbeddingLatencySplit = allocateByCounts(
          chapter.embeddingLatencyMs,
          chapterParagraphCount,
          chapterSceneEmbeddingCount
        );
        const chapterEmbeddingCallsSplit = allocateByCounts(
          chapter.embeddingCalls,
          chapterParagraphCount,
          chapterSceneEmbeddingCount
        );

        await upsertBookAnalysisChapterMetric({
          client: tx,
          bookId: book.id,
          contentVersionId: contentVersion.id,
          runId,
          chapterId: chapter.chapterId,
          chapterOrderIndex: chapter.chapterOrderIndex,
          chapterTitle: chapter.chapterTitle,
          stageKey: ANALYSIS_PARAGRAPH_STAGE,
          state: mapStageState({ runState, hasOutput: chapterParagraphCount > 0 }),
          embeddingInputTokens: chapterEmbeddingSplit.first,
          embeddingTotalTokens: chapterEmbeddingTotalSplit.first,
          elapsedMs: chapterEmbeddingLatencySplit.first,
          embeddingCalls: chapterEmbeddingCallsSplit.first,
          outputRowCount: chapterParagraphCount,
          startedAt: chapter.startedAt,
          completedAt: chapter.finishedAt,
          metadataJson: { backfilledFrom: "analysisChapterStatsJson" },
        });
        await upsertBookAnalysisChapterMetric({
          client: tx,
          bookId: book.id,
          contentVersionId: contentVersion.id,
          runId,
          chapterId: chapter.chapterId,
          chapterOrderIndex: chapter.chapterOrderIndex,
          chapterTitle: chapter.chapterTitle,
          stageKey: ANALYSIS_SCENE_CHUNK_STAGE,
          state: mapStageState({ runState, hasOutput: chapter.chunkCount > 0 || chapterArtifactCount > 0, isSceneChunk: true }),
          error: runState === "failed" && chapter.status === "failed" ? book.analysisError : null,
          promptTokens: chapter.llmPromptTokens || chapter.promptTokens,
          completionTokens: chapter.llmCompletionTokens || chapter.completionTokens,
          totalTokens: chapter.llmTotalTokens || chapter.totalTokens,
          elapsedMs: chapter.llmLatencyMs,
          retryCount: chapter.llmRetries,
          llmCalls: chapter.llmCalls,
          chunkCount: chapter.chunkCount,
          chunkFailedCount: chapter.chunkFailedCount,
          outputRowCount: chapterArtifactCount,
          startedAt: chapter.startedAt,
          completedAt: chapter.finishedAt,
          metadataJson: { backfilledFrom: "analysisChapterStatsJson" },
        });
        await upsertBookAnalysisChapterMetric({
          client: tx,
          bookId: book.id,
          contentVersionId: contentVersion.id,
          runId,
          chapterId: chapter.chapterId,
          chapterOrderIndex: chapter.chapterOrderIndex,
          chapterTitle: chapter.chapterTitle,
          stageKey: ANALYSIS_SCENE_EMBEDDING_STAGE,
          state: mapStageState({ runState, hasOutput: chapterSceneEmbeddingCount > 0 }),
          embeddingInputTokens: chapterEmbeddingSplit.second,
          embeddingTotalTokens: chapterEmbeddingTotalSplit.second,
          elapsedMs: chapterEmbeddingLatencySplit.second,
          embeddingCalls: chapterEmbeddingCallsSplit.second,
          outputRowCount: chapterSceneEmbeddingCount,
          startedAt: chapter.startedAt,
          completedAt: chapter.finishedAt,
          metadataJson: { backfilledFrom: "analysisChapterStatsJson" },
        });
        await upsertBookAnalysisChapterMetric({
          client: tx,
          bookId: book.id,
          contentVersionId: contentVersion.id,
          runId,
          chapterId: chapter.chapterId,
          chapterOrderIndex: chapter.chapterOrderIndex,
          chapterTitle: chapter.chapterTitle,
          stageKey: ANALYSIS_FINALIZE_STAGE,
          state: mapStageState({ runState, hasOutput: chapterSceneCount > 0, isFinalize: true }),
          error: runState === "failed" && chapter.status === "failed" ? book.analysisError : null,
          elapsedMs: chapter.elapsedMs,
          outputRowCount: chapterSceneCount,
          startedAt: chapter.startedAt,
          completedAt: chapter.finishedAt,
          metadataJson: { backfilledFrom: "analysisChapterStatsJson" },
        });
      }

      await tx.bookAnalysisArtifact.updateMany({
        where: {
          bookId: book.id,
          runId: null,
        },
        data: {
          runId,
          stageKey: ANALYSIS_SCENE_CHUNK_STAGE,
          schemaVersion: "analysis-artifact-inline-v0",
        },
      });

      await tx.book.update({
        where: { id: book.id },
        data: {
          currentAnalysisRunId: runState === "running" ? runId : null,
          latestAnalysisRunId: runId,
        },
      });
    });

    backfilled += 1;
  }

  return backfilled;
}

async function backfillChatTurnMetrics() {
  const messages = await prisma.bookChatThreadMessage.findMany({
    where: {
      role: "assistant",
      turnMetric: {
        is: null,
      },
    },
    select: {
      id: true,
      threadId: true,
      content: true,
      citationsJson: true,
      toolRunsJson: true,
      metricsJson: true,
      thread: {
        select: {
          bookId: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  let backfilled = 0;
  for (const message of messages) {
    const parsed = parseLegacyChatMetrics({
      content: message.content,
      citationsJson: message.citationsJson,
      metricsJson: message.metricsJson,
      toolRunsJson: message.toolRunsJson,
    });
    if (!parsed) continue;

    const turnMetric = await upsertBookChatTurnMetric({
      client: prisma,
      bookId: message.thread.bookId,
      threadId: message.threadId,
      messageId: message.id,
      chatModel: parsed.metrics.chatModel,
      embeddingModel: parsed.metrics.embeddingModel,
      selectedTools: parsed.metrics.selectedTools,
      toolConfigKey: parsed.metrics.toolConfigKey,
      promptVariant: parsed.metrics.promptVariant,
      systemPromptVersion: parsed.metrics.systemPromptVersion,
      pricingVersion: parsed.metrics.pricingVersion,
      modelInputTokens: parsed.metrics.modelInputTokens,
      modelOutputTokens: parsed.metrics.modelOutputTokens,
      modelTotalTokens: parsed.metrics.modelTotalTokens,
      embeddingInputTokens: parsed.metrics.embeddingInputTokens,
      chatCostUsd: parsed.metrics.chatCostUsd,
      embeddingCostUsd: parsed.metrics.embeddingCostUsd,
      totalCostUsd: parsed.metrics.totalCostUsd,
      totalLatencyMs: parsed.metrics.totalLatencyMs,
      answerLengthChars: parsed.metrics.answerLengthChars,
      citationCount: parsed.metrics.citationCount,
      fallbackUsed: parsed.metrics.fallbackUsed,
      fallbackKind: parsed.metrics.fallbackKind,
    });

    await replaceBookChatToolRuns({
      client: prisma,
      turnMetricId: turnMetric.id,
      runs: parsed.toolRuns.map((run, index) => ({
        toolName: run.toolName,
        orderIndex: index,
        latencyMs: run.latencyMs,
        argsSummaryJson: run.argsSummaryJson,
        resultSummaryJson: run.resultSummaryJson,
        errorCode: run.errorCode,
        errorMessage: run.errorMessage,
      })),
    });

    backfilled += 1;
  }

  return backfilled;
}

async function main() {
  const [analysisRuns, chatTurns] = await Promise.all([backfillAnalysisRuns(), backfillChatTurnMetrics()]);
  console.log(
    JSON.stringify({
      analysisRunsBackfilled: analysisRuns,
      chatTurnsBackfilled: chatTurns,
    })
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
