import type { BookAnalysisRunState, Prisma } from "@prisma/client";
import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";
import {
  parseAdminMetricsWindow,
  parsePositiveInt,
  resolveAdminMetricsWindowStart,
  roundMetric,
} from "@/lib/adminMetrics";

const RUN_STATE_VALUES = new Set<BookAnalysisRunState>([
  "queued",
  "running",
  "completed",
  "failed",
  "superseded",
]);

function parseRunState(value: string | null): BookAnalysisRunState | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "all") return null;
  if (RUN_STATE_VALUES.has(normalized as BookAnalysisRunState)) {
    return normalized as BookAnalysisRunState;
  }
  return null;
}

export async function GET(request: Request) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const q = String(searchParams.get("q") || "").trim();
  const userId = String(searchParams.get("userId") || "").trim();
  const page = parsePositiveInt(searchParams.get("page"), 1, { min: 1, max: 10_000 });
  const pageSize = parsePositiveInt(searchParams.get("pageSize"), 20, { min: 1, max: 100 });
  const skip = (page - 1) * pageSize;

  const window = parseAdminMetricsWindow(searchParams.get("window"));
  const windowStart = resolveAdminMetricsWindowStart(window);
  const state = parseRunState(searchParams.get("state"));

  const filters: Prisma.BookAnalysisRunWhereInput[] = [];
  if (windowStart) {
    filters.push({ createdAt: { gte: windowStart } });
  }
  if (state) {
    filters.push({ state });
  }
  if (userId) {
    filters.push({ book: { ownerUserId: userId } });
  }
  if (q) {
    filters.push({
      OR: [
        { id: { contains: q, mode: "insensitive" } },
        { chatModel: { contains: q, mode: "insensitive" } },
        { extractModel: { contains: q, mode: "insensitive" } },
        { embeddingModel: { contains: q, mode: "insensitive" } },
        { book: { id: { contains: q, mode: "insensitive" } } },
        { book: { title: { contains: q, mode: "insensitive" } } },
        { book: { author: { contains: q, mode: "insensitive" } } },
        { book: { owner: { id: { contains: q, mode: "insensitive" } } } },
        { book: { owner: { name: { contains: q, mode: "insensitive" } } } },
        { book: { owner: { email: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }

  const where: Prisma.BookAnalysisRunWhereInput =
    filters.length > 1 ? { AND: filters } : filters[0] || {};

  const [total, statusRows, rows] = await Promise.all([
    prisma.bookAnalysisRun.count({ where }),
    prisma.bookAnalysisRun.groupBy({
      by: ["state"],
      where,
      _count: { _all: true },
    }),
    prisma.bookAnalysisRun.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip,
      take: pageSize,
      select: {
        id: true,
        bookId: true,
        contentVersionId: true,
        attempt: true,
        state: true,
        currentStageKey: true,
        error: true,
        extractModel: true,
        chatModel: true,
        embeddingModel: true,
        llmPromptTokens: true,
        llmCompletionTokens: true,
        llmTotalTokens: true,
        embeddingInputTokens: true,
        embeddingTotalTokens: true,
        llmCostUsd: true,
        embeddingCostUsd: true,
        totalCostUsd: true,
        totalElapsedMs: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        book: {
          select: {
            id: true,
            title: true,
            author: true,
            analysisStatus: true,
            owner: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
              },
            },
          },
        },
      },
    }),
  ]);

  const statusCounts = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    superseded: 0,
  };

  for (const row of statusRows) {
    const key = row.state;
    statusCounts[key] = Number(row._count._all || 0);
  }

  return NextResponse.json({
    window,
    windowStart: windowStart ? windowStart.toISOString() : null,
    page,
    pageSize,
    total,
    state: state || "all",
    userId: userId || null,
    q,
    statusCounts,
    items: rows.map((row) => ({
      id: row.id,
      bookId: row.bookId,
      contentVersionId: row.contentVersionId,
      attempt: row.attempt,
      state: row.state,
      currentStageKey: row.currentStageKey,
      error: row.error,
      extractModel: row.extractModel,
      chatModel: row.chatModel,
      embeddingModel: row.embeddingModel,
      tokens: {
        llmPrompt: Math.max(0, Number(row.llmPromptTokens || 0)),
        llmCompletion: Math.max(0, Number(row.llmCompletionTokens || 0)),
        llmTotal: Math.max(0, Number(row.llmTotalTokens || 0)),
        embeddingInput: Math.max(0, Number(row.embeddingInputTokens || 0)),
        embeddingTotal: Math.max(0, Number(row.embeddingTotalTokens || 0)),
        total:
          Math.max(0, Number(row.llmTotalTokens || 0)) +
          Math.max(0, Number(row.embeddingTotalTokens || 0)),
      },
      costUsd: {
        llm: roundMetric(Math.max(0, Number(row.llmCostUsd || 0))),
        embedding: roundMetric(Math.max(0, Number(row.embeddingCostUsd || 0))),
        total: roundMetric(Math.max(0, Number(row.totalCostUsd || 0))),
      },
      totalElapsedMs: Math.max(0, Number(row.totalElapsedMs || 0)),
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      book: {
        id: row.book.id,
        title: row.book.title,
        author: row.book.author,
        analysisStatus: row.book.analysisStatus,
      },
      owner: {
        id: row.book.owner.id,
        name: row.book.owner.name,
        email: row.book.owner.email,
        role: row.book.owner.role,
      },
    })),
  });
}
