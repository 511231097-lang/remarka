import type { BookAnalyzerType } from "@prisma/client";
import { enqueueBookAnalyzerStage, prisma } from "@remarka/db";
import { BOOK_CHAT_GRAPH_STAGE_KEYS, BOOK_EXPERT_CORE_STAGE_KEYS } from "@remarka/contracts";

const KNOWN_ANALYZER_TYPES = [
  ...BOOK_EXPERT_CORE_STAGE_KEYS,
  ...BOOK_CHAT_GRAPH_STAGE_KEYS,
] as const satisfies readonly BookAnalyzerType[];

async function main() {
  const bookId = String(process.argv[2] || "").trim();
  const requestedStageRaw = String(process.argv[3] || "all").trim().toLowerCase();
  if (!bookId) {
    throw new Error("Usage: tsx apps/worker/src/scripts/requeueBookAnalyzer.ts <bookId> [stage|all]");
  }

  const requestedStages =
    !requestedStageRaw || requestedStageRaw === "all"
      ? [...KNOWN_ANALYZER_TYPES]
      : KNOWN_ANALYZER_TYPES.includes(requestedStageRaw as (typeof KNOWN_ANALYZER_TYPES)[number])
        ? [requestedStageRaw as (typeof KNOWN_ANALYZER_TYPES)[number]]
        : null;

  if (!requestedStages) {
    throw new Error(`Unknown analyzer stage: ${requestedStageRaw}`);
  }

  const tasks = await prisma.bookAnalyzerTask.findMany({
    where: {
      bookId,
      analyzerType: {
        in: requestedStages,
      },
    },
    select: {
      analyzerType: true,
      state: true,
    },
  });

  const taskState = new Map(tasks.map((task) => [task.analyzerType, task.state] as const));
  const requeued: string[] = [];
  const skippedCompleted: string[] = [];

  for (const analyzerType of requestedStages) {
    if (requestedStageRaw === "all" && taskState.get(analyzerType) === "completed") {
      skippedCompleted.push(analyzerType);
      continue;
    }

    await enqueueBookAnalyzerStage({
      bookId,
      analyzerType,
      publishEvent: true,
      force: true,
    });
    requeued.push(analyzerType);
  }

  console.info(
    JSON.stringify(
      {
        bookId,
        requested: requestedStageRaw,
        requeued,
        skippedCompleted,
      },
      null,
      2
    )
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
