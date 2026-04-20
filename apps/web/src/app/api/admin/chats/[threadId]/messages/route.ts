import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";
import { parsePositiveInt } from "@/lib/adminMetrics";

interface RouteContext {
  params: Promise<{ threadId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const params = await context.params;
  const threadId = String(params.threadId || "").trim();
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const limit = parsePositiveInt(searchParams.get("limit"), 200, { min: 1, max: 500 });

  const thread = await prisma.bookChatThread.findUnique({
    where: { id: threadId },
    select: {
      id: true,
      title: true,
      bookId: true,
      ownerUserId: true,
      createdAt: true,
      updatedAt: true,
      book: {
        select: {
          title: true,
        },
      },
      owner: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
        },
      },
      _count: {
        select: {
          messages: true,
        },
      },
    },
  });

  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const messagesDesc = await prisma.bookChatThreadMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      role: true,
      content: true,
      citationsJson: true,
      toolRunsJson: true,
      metricsJson: true,
      createdAt: true,
      updatedAt: true,
      turnMetric: {
        select: {
          modelInputTokens: true,
          modelOutputTokens: true,
          modelTotalTokens: true,
          embeddingInputTokens: true,
          totalCostUsd: true,
          totalLatencyMs: true,
        },
      },
    },
  });

  const messages = [...messagesDesc].reverse();

  return NextResponse.json({
    thread: {
      id: thread.id,
      title: thread.title,
      bookId: thread.bookId,
      bookTitle: thread.book.title,
      owner: thread.owner,
      messageCount: Number(thread._count.messages || 0),
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    },
    limit,
    items: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      citationsJson: message.citationsJson,
      toolRunsJson: message.toolRunsJson,
      metricsJson: message.metricsJson,
      turnMetric: message.turnMetric
        ? {
            modelInputTokens: message.turnMetric.modelInputTokens,
            modelOutputTokens: message.turnMetric.modelOutputTokens,
            modelTotalTokens: message.turnMetric.modelTotalTokens,
            embeddingInputTokens: message.turnMetric.embeddingInputTokens,
            totalCostUsd: message.turnMetric.totalCostUsd,
            totalLatencyMs: message.turnMetric.totalLatencyMs,
          }
        : null,
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
    })),
  });
}
