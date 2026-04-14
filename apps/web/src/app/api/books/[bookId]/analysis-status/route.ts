import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import {
  buildAnalysisViews,
  buildBookChatReadiness,
  createEmptyAnalyzerStatus,
  isAnalyzerPending,
  normalizePipelineAnalyzers,
} from "@/lib/bookChatReadiness";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

const PIPELINE_TASK_TYPES = [
  "canonical_text",
  "scene_build",
  "entity_graph",
  "event_relation_graph",
  "summary_store",
  "evidence_store",
  "text_index",
  "quote_store",
] as const;

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
  }

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      isPublic: true,
      ownerUserId: true,
      _count: {
        select: {
          paragraphs: true,
          sentences: true,
          scenes: true,
          entities: true,
          eventsGraph: true,
          summaryArtifacts: true,
          evidenceLinks: true,
          bookQuotes: true,
        },
      },
    },
  });

  if (!book) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  if (!book.isPublic && book.ownerUserId !== authUser.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const tasks = await prisma.bookAnalyzerTask.findMany({
    where: {
      bookId: book.id,
      analyzerType: { in: [...PIPELINE_TASK_TYPES] },
    },
    select: {
      analyzerType: true,
      state: true,
      error: true,
      startedAt: true,
      completedAt: true,
    },
  });

  const taskByType = new Map<string, (typeof tasks)[number]>(tasks.map((task) => [task.analyzerType, task] as const));
  const serializeTask = (type: string) => {
    const task = taskByType.get(type);
    if (!task) return createEmptyAnalyzerStatus();
    return {
      state: task.state,
      error: task.error || null,
      startedAt: task.startedAt ? task.startedAt.toISOString() : null,
      completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    };
  };

  const analyzers = normalizePipelineAnalyzers({
    analyzers: {
      canonical_text: serializeTask("canonical_text"),
      scene_build: serializeTask("scene_build"),
      entity_graph: serializeTask("entity_graph"),
      event_relation_graph: serializeTask("event_relation_graph"),
      summary_store: serializeTask("summary_store"),
      evidence_store: serializeTask("evidence_store"),
      text_index: serializeTask("text_index"),
      quote_store: serializeTask("quote_store"),
    },
    presence: {
      paragraphs: book._count.paragraphs > 0,
      sentences: book._count.sentences > 0,
      scenes: book._count.scenes > 0,
      entities: book._count.entities > 0,
      events: book._count.eventsGraph > 0,
      summaries: book._count.summaryArtifacts > 0,
      evidence: book._count.evidenceLinks > 0,
      quotes: book._count.bookQuotes > 0,
    },
  });

  const views = buildAnalysisViews({
    analyzers,
    presence: {
      paragraphs: book._count.paragraphs > 0,
      sentences: book._count.sentences > 0,
      scenes: book._count.scenes > 0,
      entities: book._count.entities > 0,
      events: book._count.eventsGraph > 0,
      summaries: book._count.summaryArtifacts > 0,
      evidence: book._count.evidenceLinks > 0,
      quotes: book._count.bookQuotes > 0,
    },
  });

  const chatReadiness = buildBookChatReadiness(analyzers);
  const shouldPoll = Object.values(analyzers).some((analyzer) => isAnalyzerPending(analyzer.state));
  const pollIntervalMs = shouldPoll ? (chatReadiness.canChat ? 4000 : 2500) : 0;

  return NextResponse.json({
    bookId: book.id,
    analyzers,
    views,
    chatReadiness,
    shouldPoll,
    pollIntervalMs,
  });
}
