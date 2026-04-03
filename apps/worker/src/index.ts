import { prisma } from "@remarka/db";
import { workerConfig } from "./config";
import { processDocumentExtract } from "./jobs/processDocumentExtract";
import { logger } from "./logger";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleReindexEvent(payload: any) {
  const documentId = String(payload?.documentId || "").trim();
  const projectId = String(payload?.projectId || "").trim();
  const chapterId = String(payload?.chapterId || "").trim();
  const contentVersion = Number(payload?.contentVersion);

  if (!documentId || !projectId || !chapterId || !Number.isInteger(contentVersion)) {
    throw new Error("Invalid document.reindex.requested payload");
  }

  const runId = await prisma.$transaction(async (tx: any) => {
    const document = await tx.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        contentVersion: true,
        currentRunId: true,
      },
    });

    if (!document) {
      throw new Error("Document not found");
    }

    if (document.contentVersion !== contentVersion) {
      return null;
    }

    const run = await tx.analysisRun.create({
      data: {
        projectId,
        documentId,
        chapterId,
        contentVersion,
        state: "queued",
        phase: "queued",
      },
      select: {
        id: true,
      },
    });

    await tx.analysisRun.updateMany({
      where: {
        documentId,
        id: { not: run.id },
        state: {
          in: ["queued", "running"],
        },
      },
      data: {
        state: "superseded",
        phase: "superseded",
        supersededByRunId: run.id,
        completedAt: new Date(),
      },
    });

    await tx.document.update({
      where: { id: documentId },
      data: {
        currentRunId: run.id,
      },
    });

    return run.id;
  });

  if (runId) {
    await processDocumentExtract({ runId });
  }
}

async function handleOutboxEvent(entry: any) {
  const eventType = String(entry.eventType || "").trim();
  const payload = entry.payloadJson || {};

  if (eventType === "analysis.run.requested") {
    const runId = String(payload?.runId || "").trim();
    if (!runId) {
      throw new Error("Invalid analysis.run.requested payload");
    }
    await processDocumentExtract({ runId });
    return;
  }

  if (eventType === "document.reindex.requested") {
    await handleReindexEvent(payload);
    return;
  }

  logger.warn({ eventType, outboxId: entry.id }, "Skipping unknown outbox event type");
}

async function pollOutboxOnce() {
  const entries = await prisma.outbox.findMany({
    where: {
      processedAt: null,
    },
    orderBy: [{ createdAt: "asc" }],
    take: workerConfig.outbox.batchSize,
  });

  for (const entry of entries) {
    try {
      await handleOutboxEvent(entry);
      await prisma.outbox.update({
        where: { id: entry.id },
        data: {
          processedAt: new Date(),
          error: null,
        },
      });
    } catch (error) {
      const nextAttempt = Number(entry.attemptCount || 0) + 1;
      const message = error instanceof Error ? error.message : String(error);

      await prisma.outbox.update({
        where: { id: entry.id },
        data: {
          attemptCount: nextAttempt,
          error: message.slice(0, 2000),
          processedAt: nextAttempt >= workerConfig.outbox.maxAttempts ? new Date() : null,
        },
      });

      logger.error(
        {
          err: error,
          outboxId: entry.id,
          eventType: entry.eventType,
          attempt: nextAttempt,
        },
        "Failed to process outbox event"
      );
    }
  }

  return entries.length;
}

async function main() {
  logger.info(
    {
      pollIntervalMs: workerConfig.outbox.pollIntervalMs,
      batchSize: workerConfig.outbox.batchSize,
      maxAttempts: workerConfig.outbox.maxAttempts,
      preprocessorUrl: workerConfig.preprocessor.url,
    },
    "Worker started"
  );

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down worker");
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  while (!shuttingDown) {
    const processed = await pollOutboxOnce();
    if (processed === 0) {
      await sleep(workerConfig.outbox.pollIntervalMs);
    }
  }
}

main().catch((error) => {
  logger.error({ err: error }, "Worker fatal error");
  process.exit(1);
});
