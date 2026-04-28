import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";
import {
  computeTokensPerSecond,
  parseAdminMetricsWindow,
  parsePositiveInt,
  resolveAdminMetricsWindowStart,
  roundMetric,
} from "@/lib/adminMetrics";

export async function GET(request: Request) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const q = String(searchParams.get("q") || "").trim();
  const page = parsePositiveInt(searchParams.get("page"), 1, { min: 1, max: 10_000 });
  const pageSize = parsePositiveInt(searchParams.get("pageSize"), 20, { min: 1, max: 100 });
  const skip = (page - 1) * pageSize;
  const window = parseAdminMetricsWindow(searchParams.get("window"));
  const windowStart = resolveAdminMetricsWindowStart(window);

  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { email: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ email: "asc" }, { id: "asc" }],
      skip,
      take: pageSize,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        _count: {
          select: {
            books: true,
            chatThreads: true,
          },
        },
      },
    }),
  ]);

  if (users.length === 0) {
    return NextResponse.json({
      window,
      page,
      pageSize,
      total,
      items: [],
    });
  }

  const userIds = users.map((user) => user.id);
  const [books, threads] = await Promise.all([
    prisma.book.findMany({
      where: {
        ownerUserId: {
          in: userIds,
        },
      },
      select: {
        id: true,
        ownerUserId: true,
      },
    }),
    prisma.bookChatThread.findMany({
      where: {
        ownerUserId: {
          in: userIds,
        },
      },
      select: {
        id: true,
        ownerUserId: true,
      },
    }),
  ]);

  const ownerByBookId = new Map(books.map((book) => [book.id, book.ownerUserId]));
  const ownerByThreadId = new Map(threads.map((thread) => [thread.id, thread.ownerUserId]));

  const bookIds = books.map((book) => book.id);
  const threadIds = threads.map((thread) => thread.id);

  const [analysisRows, chatRows] = await Promise.all([
    bookIds.length
      ? prisma.bookAnalysisRun.groupBy({
          by: ["bookId"],
          where: {
            bookId: { in: bookIds },
            ...(windowStart ? { createdAt: { gte: windowStart } } : {}),
          },
          _count: { _all: true },
          _sum: {
            llmTotalTokens: true,
            embeddingTotalTokens: true,
            totalCostUsd: true,
            totalElapsedMs: true,
          },
        })
      : Promise.resolve([]),
    threadIds.length
      ? prisma.bookChatTurnMetric.groupBy({
          by: ["threadId"],
          where: {
            threadId: { in: threadIds },
            ...(windowStart ? { createdAt: { gte: windowStart } } : {}),
          },
          _count: { _all: true },
          _sum: {
            modelTotalTokens: true,
            embeddingInputTokens: true,
            totalCostUsd: true,
            totalLatencyMs: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const aggregated = new Map<
    string,
    {
      analysisRuns: number;
      analysisLlmTokens: number;
      analysisEmbeddingTokens: number;
      analysisCostUsd: number;
      analysisElapsedMs: number;
      chatTurns: number;
      chatModelTokens: number;
      chatEmbeddingTokens: number;
      chatCostUsd: number;
      chatLatencyMs: number;
    }
  >();

  for (const userId of userIds) {
    aggregated.set(userId, {
      analysisRuns: 0,
      analysisLlmTokens: 0,
      analysisEmbeddingTokens: 0,
      analysisCostUsd: 0,
      analysisElapsedMs: 0,
      chatTurns: 0,
      chatModelTokens: 0,
      chatEmbeddingTokens: 0,
      chatCostUsd: 0,
      chatLatencyMs: 0,
    });
  }

  for (const row of analysisRows) {
    const ownerUserId = ownerByBookId.get(row.bookId);
    if (!ownerUserId) continue;
    const bucket = aggregated.get(ownerUserId);
    if (!bucket) continue;
    bucket.analysisRuns += Number(row._count._all || 0);
    bucket.analysisLlmTokens += Math.max(0, Number(row._sum.llmTotalTokens || 0));
    bucket.analysisEmbeddingTokens += Math.max(0, Number(row._sum.embeddingTotalTokens || 0));
    bucket.analysisCostUsd += Math.max(0, Number(row._sum.totalCostUsd || 0));
    bucket.analysisElapsedMs += Math.max(0, Number(row._sum.totalElapsedMs || 0));
  }

  for (const row of chatRows) {
    const ownerUserId = ownerByThreadId.get(row.threadId);
    if (!ownerUserId) continue;
    const bucket = aggregated.get(ownerUserId);
    if (!bucket) continue;
    bucket.chatTurns += Number(row._count._all || 0);
    bucket.chatModelTokens += Math.max(0, Number(row._sum.modelTotalTokens || 0));
    bucket.chatEmbeddingTokens += Math.max(0, Number(row._sum.embeddingInputTokens || 0));
    bucket.chatCostUsd += Math.max(0, Number(row._sum.totalCostUsd || 0));
    bucket.chatLatencyMs += Math.max(0, Number(row._sum.totalLatencyMs || 0));
  }

  const items = users.map((user) => {
    const metric = aggregated.get(user.id)!;
    const analysisTotalTokens = metric.analysisLlmTokens + metric.analysisEmbeddingTokens;
    const chatTotalTokens = metric.chatModelTokens + metric.chatEmbeddingTokens;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role,
      counts: {
        books: Number(user._count.books || 0),
        chatThreads: Number(user._count.chatThreads || 0),
      },
      analysis: {
        runs: metric.analysisRuns,
        tokens: {
          llm: metric.analysisLlmTokens,
          embedding: metric.analysisEmbeddingTokens,
          total: analysisTotalTokens,
        },
        costUsd: roundMetric(metric.analysisCostUsd),
        speed: {
          avgMs: metric.analysisRuns > 0 ? Math.round(metric.analysisElapsedMs / metric.analysisRuns) : 0,
          tokensPerSec: computeTokensPerSecond(analysisTotalTokens, metric.analysisElapsedMs),
        },
      },
      chat: {
        turns: metric.chatTurns,
        tokens: {
          model: metric.chatModelTokens,
          embedding: metric.chatEmbeddingTokens,
          total: chatTotalTokens,
        },
        costUsd: roundMetric(metric.chatCostUsd),
        speed: {
          avgMs: metric.chatTurns > 0 ? Math.round(metric.chatLatencyMs / metric.chatTurns) : 0,
          tokensPerSec: computeTokensPerSecond(chatTotalTokens, metric.chatLatencyMs),
        },
      },
    };
  });

  return NextResponse.json({
    window,
    windowStart: windowStart ? windowStart.toISOString() : null,
    page,
    pageSize,
    total,
    items,
  });
}
