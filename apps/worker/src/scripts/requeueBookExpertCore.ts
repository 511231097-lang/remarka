import { enqueueBookAnalyzerStage, prisma } from "@remarka/db";
import { BOOK_EXPERT_CORE_STAGE_KEYS } from "@remarka/contracts";

async function main() {
  const bookId = String(process.argv[2] || "").trim();
  if (!bookId) {
    throw new Error("Usage: tsx apps/worker/src/scripts/requeueBookExpertCore.ts <bookId>");
  }

  const tasks = await prisma.bookAnalyzerTask.findMany({
    where: {
      bookId,
      analyzerType: {
        in: [...BOOK_EXPERT_CORE_STAGE_KEYS],
      },
    },
    select: {
      analyzerType: true,
      state: true,
    },
  });

  const taskState = new Map(tasks.map((task) => [task.analyzerType, task.state] as const));
  const requeued: string[] = [];

  for (const analyzerType of BOOK_EXPERT_CORE_STAGE_KEYS) {
    if (taskState.get(analyzerType) === "completed") {
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
        requeued,
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
