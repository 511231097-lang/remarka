import { Prisma } from "@prisma/client";
import { enqueueBookAnalyzerStage, prisma } from "@remarka/db";
import { workerConfig } from "./config";
import {
  completedExecution,
  hardFailureExecution,
  resolveOutboxTransition,
  retryableFailureExecution,
  RetryableAnalyzerError,
  type AnalyzerExecutionResult,
} from "./analyzerExecution";
import { mergeBookAnalyzerTaskMetadata } from "./bookAnalyzerTaskMetadata";
import { processBookChatIndex } from "./jobs/processBookChatIndex";
import {
  processBookCoreEntityMentions,
  processBookCoreLiterary,
  processBookCoreMerge,
  processBookCoreProfiles,
  processBookCoreQuotesFinalize,
  processBookCoreResolve,
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
import { processDocumentExtract } from "./jobs/processDocumentExtract";
import { processProjectImport } from "./jobs/processProjectImport";
import { logger } from "./logger";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error || "Outbox event failed").slice(0, 2000);
}

const DISABLED_LEGACY_BOOK_ANALYZERS = new Set([
  "summary",
  "characters",
  "themes",
  "locations",
  "quotes",
  "literary",
  "events",
]);

async function markSkippedAnalyzerCompleted(bookId: string, analyzerType: string): Promise<void> {
  const now = new Date();
  await prisma.bookAnalyzerTask.upsert({
    where: {
      bookId_analyzerType: {
        bookId,
        analyzerType: analyzerType as any,
      },
    },
    create: {
      bookId,
      analyzerType: analyzerType as any,
      state: "completed",
      error: null,
      startedAt: now,
      completedAt: now,
      metadataJson: mergeBookAnalyzerTaskMetadata(null, {
        degraded: true,
        fallbackKind: "disabled_stage",
        lastReason: `${analyzerType} skipped by worker configuration`,
      }) ?? Prisma.JsonNull,
    },
    update: {
      state: "completed",
      error: null,
      startedAt: now,
      completedAt: now,
      metadataJson: mergeBookAnalyzerTaskMetadata(undefined, {
        degraded: true,
        fallbackKind: "disabled_stage",
        lastReason: `${analyzerType} skipped by worker configuration`,
      }) ?? Prisma.JsonNull,
    },
  });
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

async function handleOutboxEvent(entry: any): Promise<AnalyzerExecutionResult> {
  const eventType = String(entry.eventType || "").trim();
  const payload = entry.payloadJson || {};

  const processBookAnalyzer = async (): Promise<AnalyzerExecutionResult> => {
    const bookId = String(payload?.bookId || "").trim();
    const analyzerType = String(payload?.analyzerType || "").trim().toLowerCase();
    if (!bookId) {
      throw new Error("Invalid book.analyzer.requested payload");
    }
    if (!analyzerType) {
      throw new Error("Invalid book.analyzer.requested payload: analyzerType is required");
    }

    if (DISABLED_LEGACY_BOOK_ANALYZERS.has(analyzerType)) {
      await markSkippedAnalyzerCompleted(bookId, analyzerType);

      logger.info(
        {
          bookId,
          analyzerType,
          outboxId: entry.id,
        },
        "Skipping disabled legacy book analyzer stage"
      );
      return completedExecution(`${analyzerType} analyzer disabled in current chat pipeline`);
    }

    if (analyzerType === "chat_index") {
      return processBookChatIndex({ bookId });
    }

    if (analyzerType === "core_window_scan") {
      return processBookCoreWindowScan({ bookId });
    }

    if (analyzerType === "core_merge") {
      return processBookCoreMerge({ bookId });
    }

    if (analyzerType === "core_resolve") {
      return processBookCoreResolve({ bookId });
    }

    if (analyzerType === "core_entity_mentions") {
      return processBookCoreEntityMentions({ bookId });
    }

    if (analyzerType === "core_profiles") {
      return processBookCoreProfiles({ bookId });
    }

    if (analyzerType === "core_quotes_finalize") {
      return processBookCoreQuotesFinalize({ bookId });
    }

    if (analyzerType === "core_literary") {
      return processBookCoreLiterary({ bookId });
    }

    if (analyzerType === "canonical_text") {
      return processBookCanonicalText({ bookId });
    }

    if (analyzerType === "scene_build") {
      return processBookSceneBuild({ bookId });
    }

    if (analyzerType === "entity_graph") {
      return processBookEntityGraph({ bookId });
    }

    if (analyzerType === "event_relation_graph") {
      return processBookEventRelationGraph({ bookId });
    }

    if (analyzerType === "summary_store") {
      return processBookSummaryStore({ bookId });
    }

    if (analyzerType === "evidence_store") {
      return processBookEvidenceStore({ bookId });
    }

    if (analyzerType === "text_index") {
      return processBookTextIndex({ bookId });
    }

    if (analyzerType === "quote_store") {
      return processBookQuoteStore({ bookId });
    }

    logger.info(
      {
        bookId,
        analyzerType,
        outboxId: entry.id,
      },
      "Skipping unsupported book analyzer type"
    );
    return completedExecution(`unsupported analyzer type skipped: ${analyzerType}`);
  };

  if (eventType === "analysis.run.requested") {
    const runId = String(payload?.runId || "").trim();
    if (!runId) {
      throw new Error("Invalid analysis.run.requested payload");
    }
    await processDocumentExtract({ runId });
    return completedExecution();
  }

  if (eventType === "project.import.requested") {
    const importId = String(payload?.importId || "").trim();
    if (!importId) {
      throw new Error("Invalid project.import.requested payload");
    }
    await processProjectImport({ importId });
    return completedExecution();
  }

  if (eventType === "document.reindex.requested") {
    await handleReindexEvent(payload);
    return completedExecution();
  }

  if (eventType === "book.analysis.requested") {
    logger.info(
      {
        outboxId: entry.id,
      },
      "Skipping deprecated book.analysis.requested event"
    );
    return completedExecution("deprecated book.analysis.requested event skipped");
  }

  if (eventType === "book.analyzer.requested") {
    return processBookAnalyzer();
  }

  logger.warn({ eventType, outboxId: entry.id }, "Skipping unknown outbox event type");
  return completedExecution(`unknown event skipped: ${eventType}`);
}

function classifyOutboxError(error: unknown): AnalyzerExecutionResult {
  const message = safeErrorMessage(error);
  const normalized = message.toLowerCase();

  if (error instanceof RetryableAnalyzerError) {
    const delayMs =
      error.availableAt instanceof Date
        ? Math.max(1_000, error.availableAt.getTime() - Date.now())
        : workerConfig.outbox.retryableFailureDelayMs;
    return retryableFailureExecution(message, delayMs);
  }

  if (
    normalized.includes("invalid ") && normalized.includes("payload") ||
    normalized.includes("unsupported stored book format") ||
    normalized.endsWith(" not found")
  ) {
    return hardFailureExecution(message);
  }

  return retryableFailureExecution(message, workerConfig.outbox.retryableFailureDelayMs);
}

async function requeueStaleBookAnalyzerTasks(): Promise<number> {
  const cutoff = new Date(Date.now() - workerConfig.outbox.staleTaskTtlMs);
  const staleTasks = await prisma.bookAnalyzerTask.findMany({
    where: {
      state: "running",
      updatedAt: {
        lt: cutoff,
      },
    },
    select: {
      bookId: true,
      analyzerType: true,
      updatedAt: true,
      metadataJson: true,
    },
    take: workerConfig.outbox.batchSize,
    orderBy: [{ updatedAt: "asc" }],
  });

  for (const task of staleTasks) {
    const reason = `Stale running task requeued by watchdog (${task.updatedAt.toISOString()})`;
    await prisma.$transaction(async (tx: any) => {
      await tx.bookAnalyzerTask.update({
        where: {
          bookId_analyzerType: {
            bookId: task.bookId,
            analyzerType: task.analyzerType,
          },
        },
        data: {
          state: "queued",
          error: null,
          startedAt: null,
          completedAt: null,
          metadataJson: mergeBookAnalyzerTaskMetadata(task.metadataJson, {
            deferredReason: reason,
            lastReason: reason,
          }) ?? Prisma.JsonNull,
        },
      });

      await tx.book.updateMany({
        where: { id: task.bookId },
        data: {
          analysisState: "running",
          analysisError: null,
          analysisCompletedAt: null,
        },
      });
    });

    await enqueueBookAnalyzerStage({
      bookId: task.bookId,
      analyzerType: task.analyzerType as any,
      publishEvent: true,
      force: true,
    });
  }

  if (staleTasks.length > 0) {
    logger.warn(
      {
        staleTasks: staleTasks.map((task) => ({
          bookId: task.bookId,
          analyzerType: task.analyzerType,
          updatedAt: task.updatedAt.toISOString(),
        })),
      },
      "Requeued stale running book analyzer tasks"
    );
  }

  return staleTasks.length;
}

async function processOutboxEntry(entry: any) {
  const now = new Date();
  const claimedUntil = new Date(now.getTime() + workerConfig.outbox.claimLeaseMs);
  const claimed = await prisma.outbox.updateMany({
    where: {
      id: entry.id,
      processedAt: null,
      availableAt: {
        lte: now,
      },
    },
    data: {
      availableAt: claimedUntil,
    },
  });
  if (claimed.count === 0) {
    return;
  }

  try {
    const result = await handleOutboxEvent(entry);
    const transition = resolveOutboxTransition({
      result,
      now,
      currentAttemptCount: Number(entry.attemptCount || 0),
      maxAttempts: workerConfig.outbox.maxAttempts,
    });
    await prisma.outbox.update({
      where: { id: entry.id },
      data: {
        processedAt: transition.processedAt,
        availableAt: transition.availableAt,
        attemptCount: transition.attemptCount,
        error: transition.error,
      },
    });
  } catch (error) {
    const result = classifyOutboxError(error);
    const transition = resolveOutboxTransition({
      result,
      now,
      currentAttemptCount: Number(entry.attemptCount || 0),
      maxAttempts: workerConfig.outbox.maxAttempts,
    });

    await prisma.outbox.update({
      where: { id: entry.id },
      data: {
        attemptCount: transition.attemptCount,
        error: transition.error,
        processedAt: transition.processedAt,
        availableAt: transition.availableAt,
      },
    });

    logger[result.status === "hard_failure" ? "error" : "warn"](
      {
        err: error,
        outboxId: entry.id,
        eventType: entry.eventType,
        attempt: transition.attemptCount ?? Number(entry.attemptCount || 0),
        status: result.status,
        availableAt: transition.availableAt?.toISOString() || null,
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
  const now = new Date();
  const entries = await prisma.outbox.findMany({
    where: {
      processedAt: null,
      availableAt: {
        lte: now,
      },
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
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
      claimLeaseMs: workerConfig.outbox.claimLeaseMs,
      maxAttempts: workerConfig.outbox.maxAttempts,
      eventConcurrency: workerConfig.outbox.eventConcurrency,
      preprocessorUrl: workerConfig.preprocessor.url,
    },
    "Worker started"
  );

  let shuttingDown = false;
  let nextStaleSweepAt = 0;

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
    const nowMs = Date.now();
    if (nowMs >= nextStaleSweepAt) {
      await requeueStaleBookAnalyzerTasks();
      nextStaleSweepAt = nowMs + workerConfig.outbox.staleTaskSweepIntervalMs;
    }
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
