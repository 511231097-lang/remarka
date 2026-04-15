import type { BookAnalysisState, BookAnalyzerType } from "@prisma/client";
import { prisma } from "@remarka/db";
import { BOOK_CHAT_GRAPH_STAGE_KEYS, BOOK_EXPERT_CORE_STAGE_KEYS } from "@remarka/contracts";

type RequiredTaskState = {
  analyzerType: string;
  state: string;
  error?: string | null;
};

export const REQUIRED_BOOK_ANALYZER_TYPES = [
  ...BOOK_EXPERT_CORE_STAGE_KEYS,
  ...BOOK_CHAT_GRAPH_STAGE_KEYS,
] as const satisfies readonly BookAnalyzerType[];

export type BookAnalysisLifecycleState = Extract<BookAnalysisState, "running" | "completed" | "failed">;

export function resolveBookAnalysisLifecycleState(
  tasks: RequiredTaskState[],
  requiredAnalyzerTypes: readonly string[] = REQUIRED_BOOK_ANALYZER_TYPES
): {
  state: BookAnalysisLifecycleState;
  error: string | null;
} {
  const byType = new Map(tasks.map((task) => [task.analyzerType, task] as const));

  if (requiredAnalyzerTypes.every((analyzerType) => byType.get(analyzerType)?.state === "completed")) {
    return {
      state: "completed",
      error: null,
    };
  }

  const failedTask = requiredAnalyzerTypes
    .map((analyzerType) => byType.get(analyzerType))
    .find((task) => task?.state === "failed");
  if (failedTask) {
    return {
      state: "failed",
      error: failedTask.error ? String(failedTask.error) : `Book analyzer stage ${failedTask.analyzerType} failed`,
    };
  }

  return {
    state: "running",
    error: null,
  };
}

export async function markBookAnalysisRunning(bookId: string, startedAt: Date): Promise<void> {
  await prisma.book.updateMany({
    where: {
      id: bookId,
      analysisState: {
        not: "failed",
      },
    },
    data: {
      analysisState: "running",
      analysisError: null,
      analysisStartedAt: startedAt,
      analysisCompletedAt: null,
    },
  });
}

export async function refreshBookAnalysisLifecycle(bookId: string): Promise<void> {
  const tasks = await prisma.bookAnalyzerTask.findMany({
    where: {
      bookId,
      analyzerType: {
        in: [...REQUIRED_BOOK_ANALYZER_TYPES],
      },
    },
    select: {
      analyzerType: true,
      state: true,
      error: true,
    },
  });

  const lifecycle = resolveBookAnalysisLifecycleState(tasks);
  const completedAt = lifecycle.state === "completed" || lifecycle.state === "failed" ? new Date() : null;

  await prisma.book.updateMany({
    where: { id: bookId },
    data: {
      analysisState: lifecycle.state,
      analysisError: lifecycle.error,
      analysisCompletedAt: completedAt,
    },
  });
}

export async function claimQueuedAnalyzerTaskExecution(params: {
  bookId: string;
  analyzerType: string;
  startedAt: Date;
}): Promise<"claimed" | "completed" | "running"> {
  const claimed = await prisma.bookAnalyzerTask.updateMany({
    where: {
      bookId: params.bookId,
      analyzerType: params.analyzerType as BookAnalyzerType,
      state: "queued",
    },
    data: {
      state: "running",
      error: null,
      startedAt: params.startedAt,
      completedAt: null,
    },
  });

  if (claimed.count > 0) {
    return "claimed";
  }

  let existing = await prisma.bookAnalyzerTask.findUnique({
    where: {
      bookId_analyzerType: {
        bookId: params.bookId,
        analyzerType: params.analyzerType as BookAnalyzerType,
      },
    },
    select: {
      state: true,
    },
  });

  if (!existing) {
    try {
      await prisma.bookAnalyzerTask.create({
        data: {
          bookId: params.bookId,
          analyzerType: params.analyzerType as BookAnalyzerType,
          state: "running",
          error: null,
          startedAt: params.startedAt,
          completedAt: null,
        },
      });
      return "claimed";
    } catch {
      existing = await prisma.bookAnalyzerTask.findUnique({
        where: {
          bookId_analyzerType: {
            bookId: params.bookId,
            analyzerType: params.analyzerType as BookAnalyzerType,
          },
        },
        select: {
          state: true,
        },
      });
    }
  }

  if (existing?.state === "completed") {
    return "completed";
  }

  return "running";
}

export const __bookAnalysisLifecycleTestUtils = {
  resolveBookAnalysisLifecycleState,
};
