import { prisma } from "@remarka/db";
import { workerConfig } from "./config";
import {
  completedExecution,
  hardFailureExecution,
  resolveOutboxTransition,
  retryableFailureExecution,
  RetryableAnalyzerError,
  type AnalyzerExecutionResult,
} from "./analyzerExecution";
import { markBookAnalysisFailed, runBookAnalysis } from "./analysisPipeline.npz";
import { logger } from "./logger";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error || "Outbox event failed").slice(0, 2000);
}

function createBookScopedLogger(bookId: string) {
  return {
    info(message: string, data?: Record<string, unknown>) {
      logger.info({ ...(data || {}), bookId }, message);
    },
    warn(message: string, data?: Record<string, unknown>) {
      logger.warn({ ...(data || {}), bookId }, message);
    },
    error(message: string, data?: Record<string, unknown>) {
      logger.error({ ...(data || {}), bookId }, message);
    },
  };
}

async function handleOutboxEvent(entry: any): Promise<AnalyzerExecutionResult> {
  const eventType = String(entry.eventType || "").trim();
  const payload = entry.payloadJson || {};

  if (eventType === "book.npz-analysis.requested" || eventType === "book.analysis.requested") {
    const bookId = String(payload?.bookId || entry.aggregateId || "").trim();
    if (!bookId) {
      throw new Error(`Invalid ${eventType} payload`);
    }

    const scopedLogger = createBookScopedLogger(bookId);

    try {
      await runBookAnalysis({
        bookId,
        logger: scopedLogger,
      });
      return completedExecution();
    } catch (error) {
      const message = safeErrorMessage(error);
      await markBookAnalysisFailed({
        bookId,
        error: message,
        logger: scopedLogger,
      });

      logger.error(
        {
          outboxId: entry.id,
          bookId,
          error: message,
        },
        "NPZ book analysis failed"
      );
      return completedExecution("npz analysis failed and marked");
    }
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
    (normalized.includes("invalid ") && normalized.includes("payload")) ||
    normalized.includes("unsupported stored book format") ||
    normalized.endsWith(" not found")
  ) {
    return hardFailureExecution(message);
  }

  return retryableFailureExecution(message, workerConfig.outbox.retryableFailureDelayMs);
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
