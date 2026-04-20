import type { AnalysisStatus, Prisma } from "@prisma/client";
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

const ANALYSIS_STATUS_VALUES = new Set<AnalysisStatus>([
  "not_started",
  "queued",
  "running",
  "completed",
  "failed",
]);

function parseStatus(value: string | null): AnalysisStatus | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "all") return null;
  if (ANALYSIS_STATUS_VALUES.has(normalized as AnalysisStatus)) {
    return normalized as AnalysisStatus;
  }
  return null;
}

export async function GET(request: Request) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const q = String(searchParams.get("q") || "").trim();
  const ownerId = String(searchParams.get("ownerId") || "").trim();
  const page = parsePositiveInt(searchParams.get("page"), 1, { min: 1, max: 10_000 });
  const pageSize = parsePositiveInt(searchParams.get("pageSize"), 20, { min: 1, max: 100 });
  const skip = (page - 1) * pageSize;
  const status = parseStatus(searchParams.get("status"));
  const window = parseAdminMetricsWindow(searchParams.get("window"));
  const windowStart = resolveAdminMetricsWindowStart(window);

  const filters: Prisma.BookWhereInput[] = [];
  if (ownerId) {
    filters.push({ ownerUserId: ownerId });
  }
  if (status) {
    filters.push({ analysisStatus: status });
  }
  if (q) {
    filters.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { author: { contains: q, mode: "insensitive" } },
        { owner: { name: { contains: q, mode: "insensitive" } } },
        { owner: { email: { contains: q, mode: "insensitive" } } },
      ],
    });
  }

  const where: Prisma.BookWhereInput =
    filters.length > 1 ? { AND: filters } : filters[0] || {};

  const [total, books] = await Promise.all([
    prisma.book.count({ where }),
    prisma.book.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip,
      take: pageSize,
      select: {
        id: true,
        title: true,
        author: true,
        isPublic: true,
        analysisStatus: true,
        createdAt: true,
        ownerUserId: true,
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    }),
  ]);

  const bookIds = books.map((book) => book.id);
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
    bookIds.length
      ? prisma.bookChatTurnMetric.groupBy({
          by: ["bookId"],
          where: {
            bookId: { in: bookIds },
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
    analysisRows.map((row) => [
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
    chatRows.map((row) => [
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

  const items = books.map((book) => {
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
      isPublic: book.isPublic,
      analysisStatus: book.analysisStatus,
      createdAt: book.createdAt.toISOString(),
      owner: {
        id: book.owner.id,
        name: book.owner.name,
        email: book.owner.email,
        image: book.owner.image,
      },
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
  });

  return NextResponse.json({
    window,
    windowStart: windowStart ? windowStart.toISOString() : null,
    page,
    pageSize,
    total,
    status: status || "all",
    ownerId: ownerId || null,
    q,
    items,
  });
}
