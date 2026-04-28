import { Prisma } from "@prisma/client";
import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";
import type { AdminMetricsWindow } from "@/lib/adminMetrics";
import {
  computeP95,
  computeTokensPerSecond,
  parseAdminMetricsWindow,
  resolveAdminMetricsWindowStart,
  roundMetric,
} from "@/lib/adminMetrics";

type SeriesBucket = "hour" | "day" | "week" | "month";

interface TimeSeriesRow {
  bucket: Date;
  count: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  totalLatencyMs: number;
}

interface QueueHealthRow {
  pending: number;
  active: number;
  retrying: number;
  deadLetterInQueue: number;
  oldestPendingAt: Date | null;
}

const ANALYSIS_QUEUE_NAME = "book.analysis.run";
const ANALYSIS_DEAD_LETTER_QUEUE_NAME = "book.analysis.run.dead";
const ANALYSIS_OUTBOX_EVENTS = ["book.npz-analysis.requested", "book.analysis.requested"] as const;

function normalizeModelName(value: string | null | undefined): string {
  const normalized = String(value || "").trim();
  return normalized || "unknown";
}

function resolveSeriesBucket(window: AdminMetricsWindow): { key: SeriesBucket; expr: Prisma.Sql } {
  if (window === "24h") {
    return { key: "hour", expr: Prisma.sql`date_trunc('hour', "createdAt")` };
  }
  if (window === "90d") {
    return { key: "week", expr: Prisma.sql`date_trunc('week', "createdAt")` };
  }
  if (window === "all") {
    return { key: "month", expr: Prisma.sql`date_trunc('month', "createdAt")` };
  }
  return { key: "day", expr: Prisma.sql`date_trunc('day', "createdAt")` };
}

function toIsoBucket(value: Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function createSeriesItem(row: TimeSeriesRow) {
  const count = Math.max(0, Number(row.count || 0));
  const totalLatencyMs = Math.max(0, Number(row.totalLatencyMs || 0));
  return {
    bucketStart: toIsoBucket(row.bucket),
    count,
    inputTokens: Math.max(0, Number(row.inputTokens || 0)),
    outputTokens: Math.max(0, Number(row.outputTokens || 0)),
    totalTokens: Math.max(0, Number(row.totalTokens || 0)),
    costUsd: roundMetric(Math.max(0, Number(row.costUsd || 0))),
    avgMs: count > 0 ? Math.round(totalLatencyMs / count) : 0,
  };
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readQueueHealth(): Promise<{
  pending: number;
  active: number;
  retrying: number;
  deadLetter: number;
  oldestPendingAgeMs: number;
  dispatchLagMs: number;
}> {
  const now = Date.now();

  try {
    const [jobRows, archiveRows, outboxLagRows] = await Promise.all([
      prisma.$queryRaw<QueueHealthRow[]>(Prisma.sql`
        SELECT
          COALESCE(SUM(CASE WHEN name = ${ANALYSIS_QUEUE_NAME} AND state = 'created' THEN 1 ELSE 0 END), 0)::integer AS pending,
          COALESCE(SUM(CASE WHEN name = ${ANALYSIS_QUEUE_NAME} AND state = 'active' THEN 1 ELSE 0 END), 0)::integer AS active,
          COALESCE(SUM(CASE WHEN name = ${ANALYSIS_QUEUE_NAME} AND state = 'retry' THEN 1 ELSE 0 END), 0)::integer AS retrying,
          COALESCE(SUM(CASE WHEN name = ${ANALYSIS_DEAD_LETTER_QUEUE_NAME} THEN 1 ELSE 0 END), 0)::integer AS "deadLetterInQueue",
          MIN(CASE WHEN name = ${ANALYSIS_QUEUE_NAME} AND state IN ('created', 'retry') THEN created_on ELSE NULL END) AS "oldestPendingAt"
        FROM pgboss.job
      `),
      prisma.$queryRaw<Array<{ archivedDeadLetter: number }>>(Prisma.sql`
        SELECT COALESCE(COUNT(*), 0)::integer AS "archivedDeadLetter"
        FROM pgboss.archive
        WHERE name = ${ANALYSIS_DEAD_LETTER_QUEUE_NAME}
      `),
      prisma.$queryRaw<Array<{ oldestDispatchableAt: Date | null }>>(Prisma.sql`
        SELECT MIN("createdAt") AS "oldestDispatchableAt"
        FROM "Outbox"
        WHERE "processedAt" IS NULL
          AND "eventType" IN (${Prisma.join(ANALYSIS_OUTBOX_EVENTS.map((eventType) => Prisma.sql`${eventType}`))})
      `),
    ]);

    const queue = jobRows[0];
    const archivedDeadLetter = Math.max(0, asNumber(archiveRows[0]?.archivedDeadLetter));
    const oldestPendingAt = queue?.oldestPendingAt ? new Date(queue.oldestPendingAt) : null;
    const oldestDispatchableAt = outboxLagRows[0]?.oldestDispatchableAt
      ? new Date(outboxLagRows[0].oldestDispatchableAt)
      : null;

    return {
      pending: Math.max(0, asNumber(queue?.pending)),
      active: Math.max(0, asNumber(queue?.active)),
      retrying: Math.max(0, asNumber(queue?.retrying)),
      deadLetter: Math.max(0, asNumber(queue?.deadLetterInQueue) + archivedDeadLetter),
      oldestPendingAgeMs: oldestPendingAt ? Math.max(0, now - oldestPendingAt.getTime()) : 0,
      dispatchLagMs: oldestDispatchableAt ? Math.max(0, now - oldestDispatchableAt.getTime()) : 0,
    };
  } catch {
    return {
      pending: 0,
      active: 0,
      retrying: 0,
      deadLetter: 0,
      oldestPendingAgeMs: 0,
      dispatchLagMs: 0,
    };
  }
}

export async function GET(request: Request) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const window = parseAdminMetricsWindow(searchParams.get("window"));
  const windowStart = resolveAdminMetricsWindowStart(window);
  const bucket = resolveSeriesBucket(window);
  const queueHealth = await readQueueHealth();

  const analysisWhere = windowStart ? { createdAt: { gte: windowStart } } : {};
  const chatWhere = windowStart ? { createdAt: { gte: windowStart } } : {};

  const [
    usersCount,
    booksCount,
    chatThreadsCount,
    chatMessagesCount,
    analysisAggregate,
    chatAggregate,
    analysisLatencyRows,
    chatLatencyRows,
    analysisLlmModels,
    analysisEmbeddingModels,
    chatModels,
    chatEmbeddingModels,
    analysisSeriesRows,
    chatSeriesRows,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.book.count(),
    prisma.bookChatThread.count(),
    prisma.bookChatThreadMessage.count(),
    prisma.bookAnalysisRun.aggregate({
      where: analysisWhere,
      _count: { _all: true },
      _sum: {
        llmPromptTokens: true,
        llmCompletionTokens: true,
        llmTotalTokens: true,
        embeddingInputTokens: true,
        embeddingTotalTokens: true,
        llmCostUsd: true,
        embeddingCostUsd: true,
        totalCostUsd: true,
        totalElapsedMs: true,
      },
      _avg: {
        totalElapsedMs: true,
      },
    }),
    prisma.bookChatTurnMetric.aggregate({
      where: chatWhere,
      _count: { _all: true },
      _sum: {
        modelInputTokens: true,
        modelOutputTokens: true,
        modelTotalTokens: true,
        embeddingInputTokens: true,
        chatCostUsd: true,
        embeddingCostUsd: true,
        totalCostUsd: true,
        totalLatencyMs: true,
      },
      _avg: {
        totalLatencyMs: true,
      },
    }),
    prisma.bookAnalysisRun.findMany({
      where: analysisWhere,
      select: {
        totalElapsedMs: true,
      },
    }),
    prisma.bookChatTurnMetric.findMany({
      where: chatWhere,
      select: {
        totalLatencyMs: true,
      },
    }),
    prisma.bookAnalysisRun.groupBy({
      by: ["chatModel"],
      where: analysisWhere,
      _count: { _all: true },
      _sum: {
        llmPromptTokens: true,
        llmCompletionTokens: true,
        llmTotalTokens: true,
        llmCostUsd: true,
        llmLatencyMs: true,
      },
    }),
    prisma.bookAnalysisRun.groupBy({
      by: ["embeddingModel"],
      where: analysisWhere,
      _count: { _all: true },
      _sum: {
        embeddingInputTokens: true,
        embeddingTotalTokens: true,
        embeddingCostUsd: true,
        embeddingLatencyMs: true,
      },
    }),
    prisma.bookChatTurnMetric.groupBy({
      by: ["chatModel"],
      where: chatWhere,
      _count: { _all: true },
      _sum: {
        modelInputTokens: true,
        modelOutputTokens: true,
        modelTotalTokens: true,
        chatCostUsd: true,
        totalLatencyMs: true,
      },
    }),
    prisma.bookChatTurnMetric.groupBy({
      by: ["embeddingModel"],
      where: chatWhere,
      _count: { _all: true },
      _sum: {
        embeddingInputTokens: true,
        embeddingCostUsd: true,
        totalLatencyMs: true,
      },
    }),
    prisma.$queryRaw<TimeSeriesRow[]>(Prisma.sql`
      SELECT
        ${bucket.expr} AS bucket,
        COUNT(*)::double precision AS count,
        COALESCE(SUM("llmPromptTokens"), 0)::double precision AS "inputTokens",
        COALESCE(SUM("llmCompletionTokens"), 0)::double precision AS "outputTokens",
        COALESCE(SUM("llmTotalTokens"), 0)::double precision + COALESCE(SUM("embeddingTotalTokens"), 0)::double precision AS "totalTokens",
        COALESCE(SUM("totalCostUsd"), 0)::double precision AS "costUsd",
        COALESCE(SUM("totalElapsedMs"), 0)::double precision AS "totalLatencyMs"
      FROM "BookAnalysisRun"
      ${windowStart ? Prisma.sql`WHERE "createdAt" >= ${windowStart}` : Prisma.empty}
      GROUP BY 1
      ORDER BY 1 ASC
    `),
    prisma.$queryRaw<TimeSeriesRow[]>(Prisma.sql`
      SELECT
        ${bucket.expr} AS bucket,
        COUNT(*)::double precision AS count,
        COALESCE(SUM("modelInputTokens"), 0)::double precision + COALESCE(SUM("embeddingInputTokens"), 0)::double precision AS "inputTokens",
        COALESCE(SUM("modelOutputTokens"), 0)::double precision AS "outputTokens",
        COALESCE(SUM("modelTotalTokens"), 0)::double precision + COALESCE(SUM("embeddingInputTokens"), 0)::double precision AS "totalTokens",
        COALESCE(SUM("totalCostUsd"), 0)::double precision AS "costUsd",
        COALESCE(SUM("totalLatencyMs"), 0)::double precision AS "totalLatencyMs"
      FROM "BookChatTurnMetric"
      ${windowStart ? Prisma.sql`WHERE "createdAt" >= ${windowStart}` : Prisma.empty}
      GROUP BY 1
      ORDER BY 1 ASC
    `),
  ]);

  const analysisLlmTokens = Math.max(0, Number(analysisAggregate._sum.llmTotalTokens || 0));
  const analysisEmbeddingTokens = Math.max(0, Number(analysisAggregate._sum.embeddingTotalTokens || 0));
  const analysisTokens = analysisLlmTokens + analysisEmbeddingTokens;
  const analysisElapsedMs = Math.max(0, Number(analysisAggregate._sum.totalElapsedMs || 0));

  const chatModelTokens = Math.max(0, Number(chatAggregate._sum.modelTotalTokens || 0));
  const chatEmbeddingTokens = Math.max(0, Number(chatAggregate._sum.embeddingInputTokens || 0));
  const chatTokens = chatModelTokens + chatEmbeddingTokens;
  const chatElapsedMs = Math.max(0, Number(chatAggregate._sum.totalLatencyMs || 0));

  const analysisLlmModelItems = analysisLlmModels
    .map((row) => {
      const runs = Number(row._count._all || 0);
      const totalLatencyMs = Math.max(0, Number(row._sum.llmLatencyMs || 0));
      return {
        model: normalizeModelName(row.chatModel),
        runs,
        inputTokens: Math.max(0, Number(row._sum.llmPromptTokens || 0)),
        outputTokens: Math.max(0, Number(row._sum.llmCompletionTokens || 0)),
        totalTokens: Math.max(0, Number(row._sum.llmTotalTokens || 0)),
        costUsd: roundMetric(Math.max(0, Number(row._sum.llmCostUsd || 0))),
        avgMs: runs > 0 ? Math.round(totalLatencyMs / runs) : 0,
      };
    })
    .sort((left, right) => right.costUsd - left.costUsd);

  const analysisEmbeddingModelItems = analysisEmbeddingModels
    .map((row) => {
      const runs = Number(row._count._all || 0);
      const totalLatencyMs = Math.max(0, Number(row._sum.embeddingLatencyMs || 0));
      return {
        model: normalizeModelName(row.embeddingModel),
        runs,
        inputTokens: Math.max(0, Number(row._sum.embeddingInputTokens || 0)),
        outputTokens: 0,
        totalTokens: Math.max(0, Number(row._sum.embeddingTotalTokens || 0)),
        costUsd: roundMetric(Math.max(0, Number(row._sum.embeddingCostUsd || 0))),
        avgMs: runs > 0 ? Math.round(totalLatencyMs / runs) : 0,
      };
    })
    .sort((left, right) => right.costUsd - left.costUsd);

  const chatModelItems = chatModels
    .map((row) => {
      const turns = Number(row._count._all || 0);
      const totalLatencyMs = Math.max(0, Number(row._sum.totalLatencyMs || 0));
      return {
        model: normalizeModelName(row.chatModel),
        turns,
        inputTokens: Math.max(0, Number(row._sum.modelInputTokens || 0)),
        outputTokens: Math.max(0, Number(row._sum.modelOutputTokens || 0)),
        totalTokens: Math.max(0, Number(row._sum.modelTotalTokens || 0)),
        costUsd: roundMetric(Math.max(0, Number(row._sum.chatCostUsd || 0))),
        avgMs: turns > 0 ? Math.round(totalLatencyMs / turns) : 0,
      };
    })
    .sort((left, right) => right.costUsd - left.costUsd);

  const chatEmbeddingModelItems = chatEmbeddingModels
    .map((row) => {
      const turns = Number(row._count._all || 0);
      const totalLatencyMs = Math.max(0, Number(row._sum.totalLatencyMs || 0));
      const input = Math.max(0, Number(row._sum.embeddingInputTokens || 0));
      return {
        model: normalizeModelName(row.embeddingModel),
        turns,
        inputTokens: input,
        outputTokens: 0,
        totalTokens: input,
        costUsd: roundMetric(Math.max(0, Number(row._sum.embeddingCostUsd || 0))),
        avgMs: turns > 0 ? Math.round(totalLatencyMs / turns) : 0,
      };
    })
    .sort((left, right) => right.costUsd - left.costUsd);

  return NextResponse.json({
    window,
    windowStart: windowStart ? windowStart.toISOString() : null,
    seriesBucket: bucket.key,
    totals: {
      users: usersCount,
      books: booksCount,
      chatThreads: chatThreadsCount,
      chatMessages: chatMessagesCount,
    },
    analysis: {
      runs: Number(analysisAggregate._count._all || 0),
      tokens: {
        llm: analysisLlmTokens,
        embedding: analysisEmbeddingTokens,
        total: analysisTokens,
        input: Math.max(0, Number(analysisAggregate._sum.llmPromptTokens || 0)) +
          Math.max(0, Number(analysisAggregate._sum.embeddingInputTokens || 0)),
        output: Math.max(0, Number(analysisAggregate._sum.llmCompletionTokens || 0)),
      },
      costUsd: roundMetric(Math.max(0, Number(analysisAggregate._sum.totalCostUsd || 0))),
      speed: {
        avgMs: Math.round(Number(analysisAggregate._avg.totalElapsedMs || 0)),
        p95Ms: computeP95(analysisLatencyRows.map((row) => Number(row.totalElapsedMs || 0))),
        tokensPerSec: computeTokensPerSecond(analysisTokens, analysisElapsedMs),
      },
    },
    chat: {
      turns: Number(chatAggregate._count._all || 0),
      tokens: {
        model: chatModelTokens,
        embedding: chatEmbeddingTokens,
        total: chatTokens,
        input: Math.max(0, Number(chatAggregate._sum.modelInputTokens || 0)) +
          Math.max(0, Number(chatAggregate._sum.embeddingInputTokens || 0)),
        output: Math.max(0, Number(chatAggregate._sum.modelOutputTokens || 0)),
      },
      costUsd: roundMetric(Math.max(0, Number(chatAggregate._sum.totalCostUsd || 0))),
      speed: {
        avgMs: Math.round(Number(chatAggregate._avg.totalLatencyMs || 0)),
        p95Ms: computeP95(chatLatencyRows.map((row) => Number(row.totalLatencyMs || 0))),
        tokensPerSec: computeTokensPerSecond(chatTokens, chatElapsedMs),
      },
    },
    queue: queueHealth,
    models: {
      analysisLlm: analysisLlmModelItems,
      analysisEmbedding: analysisEmbeddingModelItems,
      chatModel: chatModelItems,
      chatEmbedding: chatEmbeddingModelItems,
    },
    series: {
      analysis: analysisSeriesRows.map(createSeriesItem),
      chat: chatSeriesRows.map(createSeriesItem),
    },
  });
}
