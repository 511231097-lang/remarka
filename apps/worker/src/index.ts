import { prisma } from "@remarka/db";
import { workerConfig } from "./config";
import { processBookCharacters } from "./jobs/processBookCharacters";
import { processBookChatIndex } from "./jobs/processBookChatIndex";
import {
  processBookCoreLiterary,
  processBookCoreMerge,
  processBookCoreProfiles,
  processBookCoreQuotesFinalize,
  processBookCoreWindowScan,
} from "./jobs/processBookExpertCore";
import {
  processBookCanonicalText,
  processBookEntityGraph,
  processBookEventRelationGraph,
  processBookEvidenceStore,
  processBookQuoteStore,
  processBookSceneBuild,
  processBookSummaryStore,
  processBookTextIndex,
} from "./jobs/processBookGraph";
import { processBookLiterary } from "./jobs/processBookLiterary";
import { processBookLocations } from "./jobs/processBookLocations";
import { processBookQuotes } from "./jobs/processBookQuotes";
import { processBookSummary } from "./jobs/processBookSummary";
import { processBookThemes } from "./jobs/processBookThemes";
import { processDocumentExtract } from "./jobs/processDocumentExtract";
import { processProjectImport } from "./jobs/processProjectImport";
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

  const processBookAnalyzer = async () => {
    const bookId = String(payload?.bookId || "").trim();
    const analyzerType = String(payload?.analyzerType || "").trim().toLowerCase();
    if (!bookId) {
      throw new Error("Invalid book.analyzer.requested payload");
    }
    if (!analyzerType) {
      throw new Error("Invalid book.analyzer.requested payload: analyzerType is required");
    }

    if (analyzerType === "quotes") {
      if (!workerConfig.pipeline.enableBookQuotesAnalyzer) {
        const now = new Date();
        await prisma.bookAnalyzerTask.upsert({
          where: {
            bookId_analyzerType: {
              bookId,
              analyzerType: "quotes",
            },
          },
          create: {
            bookId,
            analyzerType: "quotes",
            state: "completed",
            error: null,
            startedAt: now,
            completedAt: now,
          },
          update: {
            state: "completed",
            error: null,
            startedAt: now,
            completedAt: now,
          },
        });

        logger.info(
          {
            bookId,
            outboxId: entry.id,
          },
          "Skipping quotes analyzer because BOOK_QUOTES_ANALYZER_ENABLED is false"
        );
        return;
      }

      await processBookQuotes({ bookId });
      return;
    }

    if (analyzerType === "literary") {
      if (!workerConfig.pipeline.enableBookLiteraryAnalyzer) {
        const now = new Date();
        await prisma.bookAnalyzerTask.upsert({
          where: {
            bookId_analyzerType: {
              bookId,
              analyzerType: "literary",
            },
          },
          create: {
            bookId,
            analyzerType: "literary",
            state: "completed",
            error: null,
            startedAt: now,
            completedAt: now,
          },
          update: {
            state: "completed",
            error: null,
            startedAt: now,
            completedAt: now,
          },
        });

        logger.info(
          {
            bookId,
            outboxId: entry.id,
          },
          "Skipping literary analyzer because BOOK_LITERARY_ANALYZER_ENABLED is false"
        );
        return;
      }

      await processBookLiterary({ bookId });
      return;
    }

    if (analyzerType === "chat_index") {
      await processBookChatIndex({ bookId });
      return;
    }

    if (analyzerType === "core_window_scan") {
      await processBookCoreWindowScan({ bookId });
      return;
    }

    if (analyzerType === "core_merge") {
      await processBookCoreMerge({ bookId });
      return;
    }

    if (analyzerType === "core_profiles") {
      await processBookCoreProfiles({ bookId });
      return;
    }

    if (analyzerType === "core_quotes_finalize") {
      await processBookCoreQuotesFinalize({ bookId });
      return;
    }

    if (analyzerType === "core_literary") {
      await processBookCoreLiterary({ bookId });
      return;
    }

    if (analyzerType === "canonical_text") {
      await processBookCanonicalText({ bookId });
      return;
    }

    if (analyzerType === "scene_build") {
      await processBookSceneBuild({ bookId });
      return;
    }

    if (analyzerType === "entity_graph") {
      await processBookEntityGraph({ bookId });
      return;
    }

    if (analyzerType === "event_relation_graph") {
      await processBookEventRelationGraph({ bookId });
      return;
    }

    if (analyzerType === "summary_store") {
      await processBookSummaryStore({ bookId });
      return;
    }

    if (analyzerType === "evidence_store") {
      await processBookEvidenceStore({ bookId });
      return;
    }

    if (analyzerType === "text_index") {
      await processBookTextIndex({ bookId });
      return;
    }

    if (analyzerType === "quote_store") {
      await processBookQuoteStore({ bookId });
      return;
    }

    if (analyzerType === "summary") {
      await processBookSummary({ bookId });
      return;
    }

    if (analyzerType === "characters") {
      await processBookCharacters({ bookId });
      return;
    }

    if (analyzerType === "themes") {
      await processBookThemes({ bookId });
      return;
    }

    if (analyzerType === "locations") {
      await processBookLocations({ bookId });
      return;
    }

    logger.info(
      {
        bookId,
        analyzerType,
        outboxId: entry.id,
      },
      "Skipping unsupported book analyzer type"
    );
  };

  if (eventType === "analysis.run.requested") {
    const runId = String(payload?.runId || "").trim();
    if (!runId) {
      throw new Error("Invalid analysis.run.requested payload");
    }
    await processDocumentExtract({ runId });
    return;
  }

  if (eventType === "project.import.requested") {
    const importId = String(payload?.importId || "").trim();
    if (!importId) {
      throw new Error("Invalid project.import.requested payload");
    }
    await processProjectImport({ importId });
    return;
  }

  if (eventType === "document.reindex.requested") {
    await handleReindexEvent(payload);
    return;
  }

  if (eventType === "book.analysis.requested") {
    logger.info(
      {
        outboxId: entry.id,
      },
      "Skipping deprecated book.analysis.requested event"
    );
    return;
  }

  if (eventType === "book.analyzer.requested") {
    await processBookAnalyzer();
    return;
  }

  logger.warn({ eventType, outboxId: entry.id }, "Skipping unknown outbox event type");
}

async function processOutboxEntry(entry: any) {
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

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  if (items.length === 0) return;
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  const runners = Array.from({ length: safeConcurrency }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) break;
      await worker(items[index]);
    }
  });

  await Promise.all(runners);
}

async function pollOutboxOnce() {
  const entries = await prisma.outbox.findMany({
    where: {
      processedAt: null,
    },
    orderBy: [{ createdAt: "asc" }],
    take: workerConfig.outbox.batchSize,
  });

  await runWithConcurrency(entries, workerConfig.outbox.eventConcurrency, processOutboxEntry);

  return entries.length;
}

async function main() {
  logger.info(
    {
      pollIntervalMs: workerConfig.outbox.pollIntervalMs,
      batchSize: workerConfig.outbox.batchSize,
      maxAttempts: workerConfig.outbox.maxAttempts,
      eventConcurrency: workerConfig.outbox.eventConcurrency,
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
