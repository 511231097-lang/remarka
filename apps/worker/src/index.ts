import PgBoss from "pg-boss";
import { prisma } from "@remarka/db";
import { workerConfig } from "./config";
import { logger } from "./logger";
import { processDocumentExtract } from "./jobs/processDocumentExtract";

const DOCUMENT_EXTRACT_QUEUE = "document.extract";

async function enqueuePendingAnalysisJobs(boss: PgBoss) {
  const pendingJobs = await prisma.analysisJob.findMany({
    where: {
      status: {
        in: ["queued", "running"],
      },
    },
    select: {
      id: true,
      projectId: true,
      documentId: true,
      contentVersion: true,
    },
  });

  for (const job of pendingJobs) {
    await boss.send(DOCUMENT_EXTRACT_QUEUE, {
      jobId: job.id,
      projectId: job.projectId,
      documentId: job.documentId,
      contentVersion: job.contentVersion,
    });
  }

  if (pendingJobs.length) {
    logger.info({ count: pendingJobs.length }, "Enqueued pending analysis jobs");
  }
}

async function main() {
  const boss = new PgBoss({
    connectionString: workerConfig.databaseUrl,
    application_name: "remarka-worker",
  });

  await boss.start();
  await boss.createQueue(DOCUMENT_EXTRACT_QUEUE);
  await enqueuePendingAnalysisJobs(boss);

  await boss.work(
    DOCUMENT_EXTRACT_QUEUE,
    {
      pollingIntervalSeconds: workerConfig.queuePollIntervalSeconds,
    },
    async (jobs) => {
      const entries = Array.isArray(jobs) ? jobs : [jobs];

      for (const job of entries) {
        const payload = job.data as {
          jobId: string;
          projectId: string;
          documentId: string;
          contentVersion: number;
        };

        await processDocumentExtract(payload);
      }
    }
  );

  logger.info(
    {
      queue: DOCUMENT_EXTRACT_QUEUE,
      pollIntervalSeconds: workerConfig.queuePollIntervalSeconds,
    },
    "Worker started"
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down worker");
    await boss.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  logger.error({ err: error }, "Worker fatal error");
  process.exit(1);
});
