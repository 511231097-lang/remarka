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

interface RouteContext {
  params: Promise<{ userId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const params = await context.params;
  const userId = String(params.userId || "").trim();
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const window = parseAdminMetricsWindow(searchParams.get("window"));
  const windowStart = resolveAdminMetricsWindowStart(window);
  const bookLimit = parsePositiveInt(searchParams.get("bookLimit"), 20, { min: 1, max: 200 });
  const chatLimit = parsePositiveInt(searchParams.get("chatLimit"), 20, { min: 1, max: 200 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      tier: true,
      tierActivatedAt: true,
      createdAt: true,
      _count: {
        select: {
          books: true,
          chatThreads: true,
        },
      },
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const [allBooks, allThreads, books, threads] = await Promise.all([
    prisma.book.findMany({
      where: { ownerUserId: userId },
      select: { id: true },
    }),
    prisma.bookChatThread.findMany({
      where: { ownerUserId: userId },
      select: { id: true },
    }),
    prisma.book.findMany({
      where: { ownerUserId: userId },
      orderBy: { createdAt: "desc" },
      take: bookLimit,
      select: {
        id: true,
        title: true,
        author: true,
        analysisStatus: true,
        isPublic: true,
        createdAt: true,
      },
    }),
    prisma.bookChatThread.findMany({
      where: { ownerUserId: userId },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: chatLimit,
      select: {
        id: true,
        title: true,
        bookId: true,
        createdAt: true,
        updatedAt: true,
        book: {
          select: {
            title: true,
          },
        },
        _count: {
          select: {
            messages: true,
          },
        },
      },
    }),
  ]);

  const allBookIds = allBooks.map((book) => book.id);
  const allThreadIds = allThreads.map((thread) => thread.id);

  const [analysisByBookRows, chatByBookRows, chatByThreadRows] = await Promise.all([
    allBookIds.length
      ? prisma.bookAnalysisRun.groupBy({
          by: ["bookId"],
          where: {
            bookId: { in: allBookIds },
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
    allBookIds.length && allThreadIds.length
      ? prisma.bookChatTurnMetric.groupBy({
          by: ["bookId"],
          where: {
            bookId: { in: allBookIds },
            threadId: { in: allThreadIds },
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
    allThreadIds.length
      ? prisma.bookChatTurnMetric.groupBy({
          by: ["threadId"],
          where: {
            threadId: { in: allThreadIds },
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

  const analysisByBook = new Map(
    analysisByBookRows.map((row) => [
      row.bookId,
      {
        runs: Number(row._count._all || 0),
        llmTokens: Math.max(0, Number(row._sum.llmTotalTokens || 0)),
        embeddingTokens: Math.max(0, Number(row._sum.embeddingTotalTokens || 0)),
        costUsd: Math.max(0, Number(row._sum.totalCostUsd || 0)),
        elapsedMs: Math.max(0, Number(row._sum.totalElapsedMs || 0)),
      },
    ])
  );
  const chatByBook = new Map(
    chatByBookRows.map((row) => [
      row.bookId,
      {
        turns: Number(row._count._all || 0),
        modelTokens: Math.max(0, Number(row._sum.modelTotalTokens || 0)),
        embeddingTokens: Math.max(0, Number(row._sum.embeddingInputTokens || 0)),
        costUsd: Math.max(0, Number(row._sum.totalCostUsd || 0)),
        latencyMs: Math.max(0, Number(row._sum.totalLatencyMs || 0)),
      },
    ])
  );
  const chatByThread = new Map(
    chatByThreadRows.map((row) => [
      row.threadId,
      {
        turns: Number(row._count._all || 0),
        modelTokens: Math.max(0, Number(row._sum.modelTotalTokens || 0)),
        embeddingTokens: Math.max(0, Number(row._sum.embeddingInputTokens || 0)),
        costUsd: Math.max(0, Number(row._sum.totalCostUsd || 0)),
        latencyMs: Math.max(0, Number(row._sum.totalLatencyMs || 0)),
      },
    ])
  );

  let totalAnalysisRuns = 0;
  let totalAnalysisLlmTokens = 0;
  let totalAnalysisEmbeddingTokens = 0;
  let totalAnalysisCostUsd = 0;
  let totalAnalysisElapsedMs = 0;

  for (const row of analysisByBook.values()) {
    totalAnalysisRuns += row.runs;
    totalAnalysisLlmTokens += row.llmTokens;
    totalAnalysisEmbeddingTokens += row.embeddingTokens;
    totalAnalysisCostUsd += row.costUsd;
    totalAnalysisElapsedMs += row.elapsedMs;
  }

  let totalChatTurns = 0;
  let totalChatModelTokens = 0;
  let totalChatEmbeddingTokens = 0;
  let totalChatCostUsd = 0;
  let totalChatLatencyMs = 0;

  for (const row of chatByThread.values()) {
    totalChatTurns += row.turns;
    totalChatModelTokens += row.modelTokens;
    totalChatEmbeddingTokens += row.embeddingTokens;
    totalChatCostUsd += row.costUsd;
    totalChatLatencyMs += row.latencyMs;
  }

  return NextResponse.json({
    window,
    windowStart: windowStart ? windowStart.toISOString() : null,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role,
      tier: user.tier,
      tierActivatedAt: user.tierActivatedAt ? user.tierActivatedAt.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
      counts: {
        books: Number(user._count.books || 0),
        chatThreads: Number(user._count.chatThreads || 0),
      },
      analysis: {
        runs: totalAnalysisRuns,
        tokens: {
          llm: totalAnalysisLlmTokens,
          embedding: totalAnalysisEmbeddingTokens,
          total: totalAnalysisLlmTokens + totalAnalysisEmbeddingTokens,
        },
        costUsd: roundMetric(totalAnalysisCostUsd),
        speed: {
          avgMs: totalAnalysisRuns > 0 ? Math.round(totalAnalysisElapsedMs / totalAnalysisRuns) : 0,
          tokensPerSec: computeTokensPerSecond(
            totalAnalysisLlmTokens + totalAnalysisEmbeddingTokens,
            totalAnalysisElapsedMs
          ),
        },
      },
      chat: {
        turns: totalChatTurns,
        tokens: {
          model: totalChatModelTokens,
          embedding: totalChatEmbeddingTokens,
          total: totalChatModelTokens + totalChatEmbeddingTokens,
        },
        costUsd: roundMetric(totalChatCostUsd),
        speed: {
          avgMs: totalChatTurns > 0 ? Math.round(totalChatLatencyMs / totalChatTurns) : 0,
          tokensPerSec: computeTokensPerSecond(totalChatModelTokens + totalChatEmbeddingTokens, totalChatLatencyMs),
        },
      },
    },
    books: books.map((book) => {
      const analysis = analysisByBook.get(book.id) || {
        runs: 0,
        llmTokens: 0,
        embeddingTokens: 0,
        costUsd: 0,
        elapsedMs: 0,
      };
      const chat = chatByBook.get(book.id) || {
        turns: 0,
        modelTokens: 0,
        embeddingTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      };

      return {
        id: book.id,
        title: book.title,
        author: book.author,
        analysisStatus: book.analysisStatus,
        isPublic: book.isPublic,
        createdAt: book.createdAt.toISOString(),
        analysis: {
          runs: analysis.runs,
          tokens: {
            llm: analysis.llmTokens,
            embedding: analysis.embeddingTokens,
            total: analysis.llmTokens + analysis.embeddingTokens,
          },
          costUsd: roundMetric(analysis.costUsd),
          speed: {
            avgMs: analysis.runs > 0 ? Math.round(analysis.elapsedMs / analysis.runs) : 0,
            tokensPerSec: computeTokensPerSecond(
              analysis.llmTokens + analysis.embeddingTokens,
              analysis.elapsedMs
            ),
          },
        },
        chat: {
          turns: chat.turns,
          tokens: {
            model: chat.modelTokens,
            embedding: chat.embeddingTokens,
            total: chat.modelTokens + chat.embeddingTokens,
          },
          costUsd: roundMetric(chat.costUsd),
          speed: {
            avgMs: chat.turns > 0 ? Math.round(chat.latencyMs / chat.turns) : 0,
            tokensPerSec: computeTokensPerSecond(chat.modelTokens + chat.embeddingTokens, chat.latencyMs),
          },
        },
      };
    }),
    chats: threads.map((thread) => {
      const chat = chatByThread.get(thread.id) || {
        turns: 0,
        modelTokens: 0,
        embeddingTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      };

      return {
        id: thread.id,
        title: thread.title,
        bookId: thread.bookId,
        bookTitle: thread.book.title,
        messageCount: Number(thread._count.messages || 0),
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
        chat: {
          turns: chat.turns,
          tokens: {
            model: chat.modelTokens,
            embedding: chat.embeddingTokens,
            total: chat.modelTokens + chat.embeddingTokens,
          },
          costUsd: roundMetric(chat.costUsd),
          speed: {
            avgMs: chat.turns > 0 ? Math.round(chat.latencyMs / chat.turns) : 0,
            tokensPerSec: computeTokensPerSecond(chat.modelTokens + chat.embeddingTokens, chat.latencyMs),
          },
        },
      };
    }),
  });
}
