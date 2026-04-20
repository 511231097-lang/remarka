import { prisma } from "@remarka/db";
import { startAnalysisQueueRuntime } from "./analysisQueue";
import { workerConfig } from "./config";
import { logger } from "./logger";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const runtime = await startAnalysisQueueRuntime();

  logger.info(
    {
      queueMode: workerConfig.analysisQueue.mode,
      dispatcherEnabled: workerConfig.analysisQueue.dispatcherEnabled,
      executorConcurrency: workerConfig.analysisQueue.executorConcurrency,
      outboxPollIntervalMs: workerConfig.outbox.pollIntervalMs,
      watchdogIntervalMs: workerConfig.analysisQueue.watchdogIntervalMs,
      runningStaleTtlMs: workerConfig.analysisQueue.runningStaleTtlMs,
      queuedStaleTtlMs: workerConfig.analysisQueue.queuedStaleTtlMs,
      jobRetryLimit: workerConfig.analysisQueue.jobRetryLimit,
      jobRetryBaseMs: workerConfig.analysisQueue.jobRetryBaseMs,
    },
    "Worker started"
  );

  let shuttingDown = false;
  let lastWatchdogSweepAt = 0;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down worker");
    try {
      await runtime.stop();
    } catch (error) {
      logger.error({ err: error }, "Failed to stop analysis queue runtime");
    }

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
    try {
      const processed = await runtime.pollDispatcherOnce();
      const now = Date.now();
      const shouldSweepWatchdog = now - lastWatchdogSweepAt >= Math.max(15_000, workerConfig.analysisQueue.watchdogIntervalMs);

      if (shouldSweepWatchdog) {
        lastWatchdogSweepAt = now;
        await runtime.runWatchdogSweep();
      }

      if (processed === 0) {
        await sleep(workerConfig.outbox.pollIntervalMs);
      }
    } catch (error) {
      logger.error({ err: error }, "Worker loop iteration failed");
      await sleep(Math.max(1_000, workerConfig.outbox.pollIntervalMs));
    }
  }
}

main().catch((error) => {
  logger.error({ err: error }, "Worker fatal error");
  process.exit(1);
});
