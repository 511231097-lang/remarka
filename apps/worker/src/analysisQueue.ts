import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@remarka/db";
import PgBoss from "pg-boss";
import { Pool, type PoolClient } from "pg";
import { markBookAnalysisFailed, runBookAnalysis, type AnalysisLogger } from "./analysisPipeline.npz";
import { workerConfig } from "./config";
import { logger } from "./logger";
import { runBookShowcaseBuild } from "./showcaseBuilder";

export const ANALYSIS_QUEUE_NAME = "book.analysis.run";
export const ANALYSIS_DEAD_LETTER_QUEUE_NAME = "book.analysis.run.dead";
export const SHOWCASE_QUEUE_NAME = "book.showcase.build";
export const SHOWCASE_DEAD_LETTER_QUEUE_NAME = "book.showcase.build.dead";

const ANALYSIS_OUTBOX_EVENT_TYPES = ["book.npz-analysis.requested", "book.analysis.requested"] as const;
const SHOWCASE_OUTBOX_EVENT_TYPES = ["book.showcase.requested"] as const;
const DISPATCHABLE_OUTBOX_EVENT_TYPES = [...ANALYSIS_OUTBOX_EVENT_TYPES, ...SHOWCASE_OUTBOX_EVENT_TYPES] as const;
const DISPATCHER_LEADER_LOCK_NAME = "analysis-dispatcher";
const WATCHDOG_LEADER_LOCK_NAME = "analysis-watchdog";
const BOOK_LOCK_PREFIX = "analysis-book";
const SHOWCASE_BOOK_LOCK_PREFIX = "showcase-book";
const WATCHDOG_REASON_STALE_RUNNING = "stale_running_requeued";
const WATCHDOG_REASON_RETRY_EXHAUSTED = "watchdog_retry_exhausted";

interface AnalysisJobPayload {
  bookId: string;
  ownerUserId: string;
  triggerSource: string;
  requestedAt: string;
  requestId: string;
}

interface ShowcaseJobPayload {
  bookId: string;
  ownerUserId: string;
  triggerSource: string;
  requestedAt: string;
  requestId: string;
  sourceRunId: string | null;
}

interface OutboxDispatchRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payloadJson: Prisma.JsonValue;
  attemptCount: number;
  createdAt: Date;
}

interface AdvisoryLease {
  client: PoolClient;
  key: number;
  label: string;
}

interface WatchdogRunningCandidate {
  id: string;
  ownerUserId: string;
  currentAnalysisRunId: string | null;
  latestAnalysisRunId: string | null;
}

interface WatchdogQueuedCandidate {
  id: string;
  ownerUserId: string;
}

export interface AnalysisQueueRuntime {
  pollDispatcherOnce: () => Promise<number>;
  runWatchdogSweep: () => Promise<void>;
  stop: () => Promise<void>;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return String(value || "").trim();
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error || "Unknown error").slice(0, 2000);
}

function toIso(value: unknown, fallback: Date): string {
  const raw = asString(value);
  if (!raw) return fallback.toISOString();
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return fallback.toISOString();
  return new Date(ts).toISOString();
}

function parseInteger(value: unknown, fallback = 0): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function advisoryKey(value: string): number {
  let hash = 0x811c9dc5;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

function computeBackoffMs(attempt: number, baseMs: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const safeBaseMs = Math.max(250, Math.floor(baseMs));
  const capped = Math.min(15 * 60_000, safeBaseMs * Math.pow(2, Math.max(0, safeAttempt - 1)));
  const jitter = 0.5 + Math.random();
  return Math.max(250, Math.round(capped * jitter));
}

function buildQueueSendOptions(payload: AnalysisJobPayload) {
  return {
    retryLimit: Math.max(1, workerConfig.analysisQueue.jobRetryLimit),
    retryDelay: Math.max(1, Math.round(workerConfig.analysisQueue.jobRetryBaseMs / 1000)),
    retryBackoff: true,
    deadLetter: ANALYSIS_DEAD_LETTER_QUEUE_NAME,
    singletonKey: payload.requestId,
    expireInSeconds: Math.max(60, Math.round(workerConfig.analysisQueue.runningStaleTtlMs / 1000)),
  };
}

function buildShowcaseQueueSendOptions(payload: ShowcaseJobPayload) {
  return {
    retryLimit: Math.max(1, workerConfig.analysisQueue.jobRetryLimit),
    retryDelay: Math.max(1, Math.round(workerConfig.analysisQueue.jobRetryBaseMs / 1000)),
    retryBackoff: true,
    deadLetter: SHOWCASE_DEAD_LETTER_QUEUE_NAME,
    singletonKey: payload.requestId,
    expireInSeconds: Math.max(60, Math.round(workerConfig.analysisQueue.runningStaleTtlMs / 1000)),
  };
}

function isAnalysisOutboxEventType(value: string): value is (typeof ANALYSIS_OUTBOX_EVENT_TYPES)[number] {
  return ANALYSIS_OUTBOX_EVENT_TYPES.includes(value as (typeof ANALYSIS_OUTBOX_EVENT_TYPES)[number]);
}

function isShowcaseOutboxEventType(value: string): value is (typeof SHOWCASE_OUTBOX_EVENT_TYPES)[number] {
  return SHOWCASE_OUTBOX_EVENT_TYPES.includes(value as (typeof SHOWCASE_OUTBOX_EVENT_TYPES)[number]);
}

class NonRetryableDispatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableDispatcherError";
  }
}

class NonRetryableExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableExecutorError";
  }
}

function createBookScopedLogger(bookId: string): AnalysisLogger {
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

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  if (!items.length) return;
  const safeConcurrency = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: safeConcurrency }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) break;
        await worker(items[index]!);
      }
    })
  );
}

async function acquireAdvisoryLease(pool: Pool, label: string): Promise<AdvisoryLease | null> {
  const key = advisoryKey(label);
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [key]);
    if (result.rows[0]?.locked) {
      return { client, key, label };
    }
    client.release();
    return null;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseAdvisoryLease(lease: AdvisoryLease) {
  try {
    await lease.client.query("SELECT pg_advisory_unlock($1)", [lease.key]);
  } catch (error) {
    logger.warn({ err: error, lock: lease.label }, "Failed to unlock advisory lease");
  } finally {
    lease.client.release();
  }
}

async function ensureBookOwner(bookId: string): Promise<string> {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      ownerUserId: true,
    },
  });
  if (!book) {
    throw new NonRetryableDispatcherError("Book not found");
  }
  return book.ownerUserId;
}

async function normalizeOutboxPayload(entry: OutboxDispatchRow): Promise<AnalysisJobPayload> {
  const payload = toRecord(entry.payloadJson);
  const bookId = asString(payload.bookId) || asString(entry.aggregateId);
  if (!bookId) {
    throw new NonRetryableDispatcherError(`Invalid ${entry.eventType} payload: missing bookId`);
  }

  const ownerUserId = asString(payload.ownerUserId) || (await ensureBookOwner(bookId));
  if (!ownerUserId) {
    throw new NonRetryableDispatcherError("Invalid payload: ownerUserId is required");
  }

  const requestedAt = toIso(payload.requestedAt, entry.createdAt || new Date());
  const triggerSource = asString(payload.triggerSource) || asString(payload.source) || "manual";
  const requestId = asString(payload.requestId) || `outbox:${entry.id}`;

  return {
    bookId,
    ownerUserId,
    requestedAt,
    triggerSource,
    requestId,
  };
}

async function normalizeShowcaseOutboxPayload(entry: OutboxDispatchRow): Promise<ShowcaseJobPayload> {
  const payload = toRecord(entry.payloadJson);
  const bookId = asString(payload.bookId) || asString(entry.aggregateId);
  if (!bookId) {
    throw new NonRetryableDispatcherError(`Invalid ${entry.eventType} payload: missing bookId`);
  }

  const ownerUserId = asString(payload.ownerUserId) || (await ensureBookOwner(bookId));
  if (!ownerUserId) {
    throw new NonRetryableDispatcherError("Invalid payload: ownerUserId is required");
  }

  const requestedAt = toIso(payload.requestedAt, entry.createdAt || new Date());
  const triggerSource = asString(payload.triggerSource) || asString(payload.source) || "analysis_completed";
  const requestId = asString(payload.requestId) || `outbox:${entry.id}`;
  const sourceRunId = asString(payload.sourceRunId) || null;

  return {
    bookId,
    ownerUserId,
    requestedAt,
    triggerSource,
    requestId,
    sourceRunId,
  };
}

async function countQueueJobsByOwner(ownerUserId: string): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS count
      FROM pgboss.job
      WHERE name = ${ANALYSIS_QUEUE_NAME}
        AND state IN ('created', 'retry', 'active')
        AND COALESCE(data->>'ownerUserId', '') = ${ownerUserId}
    `);

    return Math.max(0, Number(rows[0]?.count || 0));
  } catch {
    return 0;
  }
}

async function countQueueJobsByBook(bookId: string): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS count
      FROM pgboss.job
      WHERE name = ${ANALYSIS_QUEUE_NAME}
        AND state IN ('created', 'retry', 'active')
        AND COALESCE(data->>'bookId', '') = ${bookId}
    `);

    return Math.max(0, Number(rows[0]?.count || 0));
  } catch {
    return 0;
  }
}

async function claimDispatchBatch(): Promise<OutboxDispatchRow[]> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + workerConfig.outbox.claimLeaseMs);
  const entries = await prisma.outbox.findMany({
    where: {
      processedAt: null,
      availableAt: {
        lte: now,
      },
      eventType: {
        in: [...DISPATCHABLE_OUTBOX_EVENT_TYPES],
      },
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    take: Math.max(1, workerConfig.outbox.batchSize),
    select: {
      id: true,
      aggregateId: true,
      eventType: true,
      payloadJson: true,
      attemptCount: true,
      createdAt: true,
    },
  });

  const claimed: OutboxDispatchRow[] = [];
  for (const entry of entries) {
    const updated = await prisma.outbox.updateMany({
      where: {
        id: entry.id,
        processedAt: null,
        availableAt: {
          lte: now,
        },
      },
      data: {
        availableAt: leaseUntil,
      },
    });

    if (updated.count > 0) {
      claimed.push({
        id: entry.id,
        aggregateId: entry.aggregateId,
        eventType: entry.eventType,
        payloadJson: entry.payloadJson as Prisma.JsonValue,
        attemptCount: Math.max(0, Number(entry.attemptCount || 0)),
        createdAt: entry.createdAt,
      });
    }
  }

  return claimed;
}

function isNonRetryableDispatchError(error: unknown): boolean {
  if (error instanceof NonRetryableDispatcherError) return true;
  const message = safeErrorMessage(error).toLowerCase();
  return (
    (message.includes("invalid") && message.includes("payload")) ||
    message.includes("book not found") ||
    message.includes("unsupported stored book format")
  );
}

async function completeOutboxDispatch(entryId: string) {
  const now = new Date();
  await prisma.outbox.update({
    where: { id: entryId },
    data: {
      processedAt: now,
      availableAt: now,
      error: null,
    },
  });
}

async function deferOutboxDispatch(params: {
  entryId: string;
  reason: string;
  delayMs: number;
  incrementAttempt: boolean;
  currentAttemptCount: number;
  forceProcessed?: boolean;
}) {
  const nextAttemptCount = params.incrementAttempt
    ? Math.max(0, params.currentAttemptCount) + 1
    : Math.max(0, params.currentAttemptCount);
  const processedAt = params.forceProcessed ? new Date() : null;

  await prisma.outbox.update({
    where: { id: params.entryId },
    data: {
      processedAt,
      availableAt: processedAt ? undefined : new Date(Date.now() + Math.max(1_000, params.delayMs)),
      attemptCount: nextAttemptCount,
      error: params.reason.slice(0, 2000),
    },
  });
}

async function dispatchOutboxEntry(boss: PgBoss, entry: OutboxDispatchRow) {
  try {
    if (isAnalysisOutboxEventType(entry.eventType)) {
      const payload = await normalizeOutboxPayload(entry);

      const queueForOwner = await countQueueJobsByOwner(payload.ownerUserId);
      if (queueForOwner >= Math.max(1, workerConfig.analysisQueue.fairSharePerUserInFlight)) {
        await deferOutboxDispatch({
          entryId: entry.id,
          reason: "fair_share_deferred",
          delayMs: workerConfig.analysisQueue.fairShareDeferMs,
          incrementAttempt: false,
          currentAttemptCount: entry.attemptCount,
        });
        return;
      }

      const jobId = await boss.send(ANALYSIS_QUEUE_NAME, payload, buildQueueSendOptions(payload));
      if (!jobId) {
        throw new Error("pg-boss returned empty job id");
      }

      await completeOutboxDispatch(entry.id);

      logger.info(
        {
          outboxId: entry.id,
          bookId: payload.bookId,
          requestId: payload.requestId,
          ownerUserId: payload.ownerUserId,
          jobId,
        },
        "Dispatched analysis outbox event to pg-boss"
      );
      return;
    }

    if (isShowcaseOutboxEventType(entry.eventType)) {
      const payload = await normalizeShowcaseOutboxPayload(entry);
      const jobId = await boss.send(SHOWCASE_QUEUE_NAME, payload, buildShowcaseQueueSendOptions(payload));
      if (!jobId) {
        throw new Error("pg-boss returned empty showcase job id");
      }

      await completeOutboxDispatch(entry.id);

      logger.info(
        {
          outboxId: entry.id,
          bookId: payload.bookId,
          requestId: payload.requestId,
          ownerUserId: payload.ownerUserId,
          sourceRunId: payload.sourceRunId,
          jobId,
        },
        "Dispatched showcase outbox event to pg-boss"
      );
      return;
    }

    throw new NonRetryableDispatcherError(`Unsupported outbox event type: ${entry.eventType}`);
  } catch (error) {
    const reason = safeErrorMessage(error);
    const hardFailure = isNonRetryableDispatchError(error);
    const nextAttempt = Math.max(0, Number(entry.attemptCount || 0)) + 1;
    const exhausted = nextAttempt >= Math.max(1, workerConfig.outbox.maxAttempts);
    const forceProcessed = hardFailure || exhausted;

    await deferOutboxDispatch({
      entryId: entry.id,
      reason,
      delayMs: computeBackoffMs(nextAttempt, workerConfig.analysisQueue.jobRetryBaseMs),
      incrementAttempt: true,
      currentAttemptCount: entry.attemptCount,
      forceProcessed,
    });

    logger[forceProcessed ? "error" : "warn"](
      {
        err: error,
        outboxId: entry.id,
        hardFailure,
        exhausted,
        attempt: nextAttempt,
      },
      "Failed to dispatch analysis outbox event"
    );
  }
}

function isRetryableExecutionError(error: unknown): boolean {
  if (error instanceof NonRetryableExecutorError) return false;

  const anyError = error as {
    status?: unknown;
    code?: unknown;
    cause?: { status?: unknown; code?: unknown };
    name?: unknown;
  };

  const status = Number(anyError?.status || anyError?.cause?.status || Number.NaN);
  if (Number.isFinite(status)) {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
  }

  const code = asString(anyError?.code || anyError?.cause?.code).toUpperCase();
  if (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }

  const message = safeErrorMessage(error).toLowerCase();
  const transientFragments = [
    "timeout",
    "timed out",
    "resource exhausted",
    "rate limit",
    "too many requests",
    "status 429",
    "status 408",
    "fetch failed",
    "network",
    "aborted",
    "aborterror",
    "connection reset",
    "socket hang up",
    "temporary",
    "temporarily unavailable",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
  ];

  return transientFragments.some((fragment) => message.includes(fragment));
}

async function normalizeAnalysisJobPayload(raw: unknown, fallbackRequestId: string): Promise<AnalysisJobPayload> {
  const record = toRecord(raw);
  const bookId = asString(record.bookId);
  if (!bookId) {
    throw new NonRetryableExecutorError("Job payload missing bookId");
  }

  const ownerUserId = asString(record.ownerUserId) || (await ensureBookOwner(bookId));
  if (!ownerUserId) {
    throw new NonRetryableExecutorError("Job payload missing ownerUserId");
  }

  return {
    bookId,
    ownerUserId,
    triggerSource: asString(record.triggerSource) || "manual",
    requestedAt: toIso(record.requestedAt, new Date()),
    requestId: asString(record.requestId) || fallbackRequestId,
  };
}

async function normalizeShowcaseJobPayload(raw: unknown, fallbackRequestId: string): Promise<ShowcaseJobPayload> {
  const record = toRecord(raw);
  const bookId = asString(record.bookId);
  if (!bookId) {
    throw new NonRetryableExecutorError("Job payload missing bookId");
  }

  const ownerUserId = asString(record.ownerUserId) || (await ensureBookOwner(bookId));
  if (!ownerUserId) {
    throw new NonRetryableExecutorError("Job payload missing ownerUserId");
  }

  return {
    bookId,
    ownerUserId,
    triggerSource: asString(record.triggerSource) || "analysis_completed",
    requestedAt: toIso(record.requestedAt, new Date()),
    requestId: asString(record.requestId) || fallbackRequestId,
    sourceRunId: asString(record.sourceRunId) || null,
  };
}

async function shouldSkipCompletedRequest(payload: AnalysisJobPayload): Promise<boolean> {
  const book = await prisma.book.findUnique({
    where: { id: payload.bookId },
    select: {
      analysisStatus: true,
      analysisFinishedAt: true,
    },
  });

  if (!book) {
    throw new NonRetryableExecutorError("Book not found");
  }

  if (book.analysisStatus !== "completed" && book.analysisStatus !== "failed") {
    return false;
  }

  const requestedTs = Date.parse(payload.requestedAt);
  if (!Number.isFinite(requestedTs)) return false;

  const finishedAt = book.analysisFinishedAt;
  if (!finishedAt) return false;
  return finishedAt.getTime() >= requestedTs;
}

async function enqueueShowcaseRequestToOutbox(params: {
  bookId: string;
  ownerUserId: string;
  requestedAt: Date;
  triggerSource: string;
  requestId: string;
  sourceRunId: string | null;
}) {
  await prisma.outbox.create({
    data: {
      aggregateType: "book",
      aggregateId: params.bookId,
      eventType: "book.showcase.requested",
      payloadJson: {
        bookId: params.bookId,
        ownerUserId: params.ownerUserId,
        triggerSource: params.triggerSource,
        requestedAt: params.requestedAt.toISOString(),
        requestId: params.requestId,
        sourceRunId: params.sourceRunId,
      } as Prisma.InputJsonValue,
      availableAt: params.requestedAt,
    },
  });
}

async function shouldSkipCompletedShowcaseRequest(payload: ShowcaseJobPayload): Promise<boolean> {
  const requestedTs = Date.parse(payload.requestedAt);
  if (!Number.isFinite(requestedTs)) return false;

  const artifact = await prisma.bookSummaryArtifact.findUnique({
    where: {
      bookId_kind_key: {
        bookId: payload.bookId,
        kind: "book_brief",
        key: "showcase_v2",
      },
    },
    select: {
      updatedAt: true,
    },
  });

  if (!artifact?.updatedAt) return false;
  return artifact.updatedAt.getTime() >= requestedTs;
}

async function deferLockedJob(params: {
  boss: PgBoss;
  payload: AnalysisJobPayload;
  retryCount: number;
}) {
  const delayMs = computeBackoffMs(params.retryCount + 1, workerConfig.analysisQueue.jobRetryBaseMs);
  const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));
  const deferredJobId = await params.boss.sendAfter(
    ANALYSIS_QUEUE_NAME,
    params.payload,
    buildQueueSendOptions(params.payload),
    delaySeconds
  );

  if (!deferredJobId) {
    throw new Error("Failed to defer locked analysis job");
  }

  logger.info(
    {
      bookId: params.payload.bookId,
      requestId: params.payload.requestId,
      delaySeconds,
      deferredJobId,
    },
    "Deferred analysis job due to busy book lock"
  );
}

async function deferLockedShowcaseJob(params: {
  boss: PgBoss;
  payload: ShowcaseJobPayload;
  retryCount: number;
}) {
  const delayMs = computeBackoffMs(params.retryCount + 1, workerConfig.analysisQueue.jobRetryBaseMs);
  const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));
  const deferredJobId = await params.boss.sendAfter(
    SHOWCASE_QUEUE_NAME,
    params.payload,
    buildShowcaseQueueSendOptions(params.payload),
    delaySeconds
  );

  if (!deferredJobId) {
    throw new Error("Failed to defer locked showcase job");
  }

  logger.info(
    {
      bookId: params.payload.bookId,
      requestId: params.payload.requestId,
      delaySeconds,
      deferredJobId,
    },
    "Deferred showcase job due to busy book lock"
  );
}

async function executeQueueJob(params: {
  boss: PgBoss;
  lockPool: Pool;
  job: any;
}) {
  const payload = await normalizeAnalysisJobPayload(params.job?.data, `job:${asString(params.job?.id) || randomUUID()}`);
  const scopedLogger = createBookScopedLogger(payload.bookId);

  const bookLease = await acquireAdvisoryLease(params.lockPool, `${BOOK_LOCK_PREFIX}:${payload.bookId}`);
  if (!bookLease) {
    await deferLockedJob({
      boss: params.boss,
      payload,
      retryCount: Math.max(0, parseInteger(params.job?.retryCount)),
    });
    return;
  }

  try {
    const shouldSkip = await shouldSkipCompletedRequest(payload);
    if (shouldSkip) {
      scopedLogger.info("Skipping duplicate completed analysis request", {
        requestId: payload.requestId,
      });
      return;
    }

    await runBookAnalysis({
      bookId: payload.bookId,
      logger: scopedLogger,
    });

    const showcaseRequestedAt = new Date();
    const showcaseRequestId = `showcase:${payload.requestId}`;
    try {
      await enqueueShowcaseRequestToOutbox({
        bookId: payload.bookId,
        ownerUserId: payload.ownerUserId,
        triggerSource: "analysis_completed",
        requestedAt: showcaseRequestedAt,
        requestId: showcaseRequestId,
        sourceRunId: null,
      });
      scopedLogger.info("Enqueued showcase build request", {
        requestId: showcaseRequestId,
        triggerSource: "analysis_completed",
      });
    } catch (enqueueError) {
      scopedLogger.error("Failed to enqueue showcase build request", {
        requestId: showcaseRequestId,
        error: safeErrorMessage(enqueueError),
      });
    }

    scopedLogger.info("Analysis queue job completed", {
      requestId: payload.requestId,
      triggerSource: payload.triggerSource,
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    const retryable = isRetryableExecutionError(error);
    const retryCount = Math.max(0, parseInteger(params.job?.retryCount));
    const retryLimit = Math.max(1, parseInteger(params.job?.retryLimit, workerConfig.analysisQueue.jobRetryLimit));
    const retryExhausted = retryable && retryCount >= retryLimit;

    if (retryable && !retryExhausted) {
      scopedLogger.warn("Analysis queue job failed with retryable error", {
        requestId: payload.requestId,
        retryCount,
        retryLimit,
        error: message,
      });
      throw error;
    }

    await markBookAnalysisFailed({
      bookId: payload.bookId,
      error: message,
      logger: scopedLogger,
      qualityFlags: {
        degraded: false,
        degradationReasons: [retryExhausted ? "retry_exhausted" : "hard_failure"],
        failedChapterIds: [],
        retryExhausted,
      },
    });

    if (retryExhausted) {
      scopedLogger.error("Analysis queue job exhausted retry budget", {
        requestId: payload.requestId,
        retryCount,
        retryLimit,
        error: message,
      });
      throw error;
    }

    scopedLogger.error("Analysis queue job failed without retry", {
      requestId: payload.requestId,
      error: message,
    });
  } finally {
    await releaseAdvisoryLease(bookLease);
  }
}

async function executeShowcaseQueueJob(params: {
  boss: PgBoss;
  lockPool: Pool;
  job: any;
}) {
  const payload = await normalizeShowcaseJobPayload(params.job?.data, `job:${asString(params.job?.id) || randomUUID()}`);
  const scopedLogger = createBookScopedLogger(payload.bookId);

  const bookLease = await acquireAdvisoryLease(params.lockPool, `${SHOWCASE_BOOK_LOCK_PREFIX}:${payload.bookId}`);
  if (!bookLease) {
    await deferLockedShowcaseJob({
      boss: params.boss,
      payload,
      retryCount: Math.max(0, parseInteger(params.job?.retryCount)),
    });
    return;
  }

  try {
    const shouldSkip = await shouldSkipCompletedShowcaseRequest(payload);
    if (shouldSkip) {
      scopedLogger.info("Skipping duplicate completed showcase request", {
        requestId: payload.requestId,
      });
      return;
    }

    await runBookShowcaseBuild({
      bookId: payload.bookId,
      logger: scopedLogger,
    });

    scopedLogger.info("Showcase queue job completed", {
      requestId: payload.requestId,
      triggerSource: payload.triggerSource,
      sourceRunId: payload.sourceRunId,
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    const retryable = isRetryableExecutionError(error);
    const retryCount = Math.max(0, parseInteger(params.job?.retryCount));
    const retryLimit = Math.max(1, parseInteger(params.job?.retryLimit, workerConfig.analysisQueue.jobRetryLimit));
    const retryExhausted = retryable && retryCount >= retryLimit;

    if (retryable && !retryExhausted) {
      scopedLogger.warn("Showcase queue job failed with retryable error", {
        requestId: payload.requestId,
        retryCount,
        retryLimit,
        error: message,
      });
      throw error;
    }

    scopedLogger.error("Showcase queue job failed", {
      requestId: payload.requestId,
      retryable,
      retryExhausted,
      retryCount,
      retryLimit,
      error: message,
    });

    if (retryExhausted) {
      throw error;
    }
  } finally {
    await releaseAdvisoryLease(bookLease);
  }
}

async function ensureQueues(boss: PgBoss) {
  const retryDelaySeconds = Math.max(1, Math.ceil(workerConfig.analysisQueue.jobRetryBaseMs / 1000));
  const expireInSeconds = Math.max(60, Math.ceil(workerConfig.analysisQueue.runningStaleTtlMs / 1000));

  const deadLetterConfig = {
    name: ANALYSIS_DEAD_LETTER_QUEUE_NAME,
    policy: "standard" as const,
  };

  const showcaseDeadLetterConfig = {
    name: SHOWCASE_DEAD_LETTER_QUEUE_NAME,
    policy: "standard" as const,
  };

  const queueConfig = {
    name: ANALYSIS_QUEUE_NAME,
    policy: "standard" as const,
    retryLimit: Math.max(1, workerConfig.analysisQueue.jobRetryLimit),
    retryDelay: retryDelaySeconds,
    retryBackoff: true,
    expireInSeconds,
    deadLetter: ANALYSIS_DEAD_LETTER_QUEUE_NAME,
  };

  const showcaseQueueConfig = {
    name: SHOWCASE_QUEUE_NAME,
    policy: "standard" as const,
    retryLimit: Math.max(1, workerConfig.analysisQueue.jobRetryLimit),
    retryDelay: retryDelaySeconds,
    retryBackoff: true,
    expireInSeconds,
    deadLetter: SHOWCASE_DEAD_LETTER_QUEUE_NAME,
  };

  try {
    if (await boss.getQueue(ANALYSIS_DEAD_LETTER_QUEUE_NAME)) {
      await boss.updateQueue(ANALYSIS_DEAD_LETTER_QUEUE_NAME, deadLetterConfig as any);
    } else {
      await boss.createQueue(ANALYSIS_DEAD_LETTER_QUEUE_NAME, deadLetterConfig as any);
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to ensure analysis dead-letter queue; continuing");
  }

  try {
    if (await boss.getQueue(SHOWCASE_DEAD_LETTER_QUEUE_NAME)) {
      await boss.updateQueue(SHOWCASE_DEAD_LETTER_QUEUE_NAME, showcaseDeadLetterConfig as any);
    } else {
      await boss.createQueue(SHOWCASE_DEAD_LETTER_QUEUE_NAME, showcaseDeadLetterConfig as any);
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to ensure showcase dead-letter queue; continuing");
  }

  if (await boss.getQueue(ANALYSIS_QUEUE_NAME)) {
    await boss.updateQueue(ANALYSIS_QUEUE_NAME, queueConfig as any);
  } else {
    await boss.createQueue(ANALYSIS_QUEUE_NAME, queueConfig as any);
  }

  if (await boss.getQueue(SHOWCASE_QUEUE_NAME)) {
    await boss.updateQueue(SHOWCASE_QUEUE_NAME, showcaseQueueConfig as any);
  } else {
    await boss.createQueue(SHOWCASE_QUEUE_NAME, showcaseQueueConfig as any);
  }
}

function normalizeQualityFlags(value: unknown): Record<string, unknown> {
  const record = toRecord(value);
  const degradationReasons = Array.isArray(record.degradationReasons)
    ? record.degradationReasons.map((item) => asString(item)).filter(Boolean)
    : [];
  const failedChapterIds = Array.isArray(record.failedChapterIds)
    ? record.failedChapterIds.map((item) => asString(item)).filter(Boolean)
    : [];

  return {
    degraded: Boolean(record.degraded),
    degradationReasons,
    failedChapterIds,
    retryExhausted: Boolean(record.retryExhausted),
    watchdogRequeueCount: Math.max(0, parseInteger(record.watchdogRequeueCount)),
  };
}

async function enqueueWatchdogOutboxEvent(params: {
  bookId: string;
  ownerUserId: string;
  triggerSource: string;
  requestId: string;
  requestedAt: Date;
}) {
  await prisma.outbox.create({
    data: {
      aggregateType: "book",
      aggregateId: params.bookId,
      eventType: "book.npz-analysis.requested",
      payloadJson: {
        bookId: params.bookId,
        ownerUserId: params.ownerUserId,
        triggerSource: params.triggerSource,
        requestedAt: params.requestedAt.toISOString(),
        requestId: params.requestId,
      } as Prisma.InputJsonValue,
      availableAt: params.requestedAt,
    },
  });
}

async function recoverStaleQueuedBook(book: WatchdogQueuedCandidate) {
  const hasQueueJob = (await countQueueJobsByBook(book.id)) > 0;
  if (hasQueueJob) return;

  const now = new Date();
  const pendingOutbox = await prisma.outbox.findFirst({
    where: {
      aggregateType: "book",
      aggregateId: book.id,
      eventType: {
        in: [...ANALYSIS_OUTBOX_EVENT_TYPES],
      },
      processedAt: null,
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
    },
  });

  if (pendingOutbox) {
    await prisma.outbox.update({
      where: { id: pendingOutbox.id },
      data: {
        availableAt: now,
        error: "watchdog_queued_redispatch",
      },
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.book.updateMany({
      where: {
        id: book.id,
        analysisStatus: "queued",
      },
      data: {
        analysisRequestedAt: now,
      },
    });

    await tx.outbox.create({
      data: {
        aggregateType: "book",
        aggregateId: book.id,
        eventType: "book.npz-analysis.requested",
        payloadJson: {
          bookId: book.id,
          ownerUserId: book.ownerUserId,
          triggerSource: "watchdog_stale_queued",
          requestedAt: now.toISOString(),
          requestId: `watchdog-queued:${book.id}:${randomUUID()}`,
        } as Prisma.InputJsonValue,
        availableAt: now,
      },
    });
  });
}

async function recoverStaleRunningBook(book: WatchdogRunningCandidate) {
  const hasQueueJob = (await countQueueJobsByBook(book.id)) > 0;
  if (hasQueueJob) return;

  const runId = asString(book.currentAnalysisRunId) || asString(book.latestAnalysisRunId);
  const currentRun = runId
    ? await prisma.bookAnalysisRun.findUnique({
        where: { id: runId },
        select: {
          qualityFlagsJson: true,
        },
      })
    : null;
  const qualityFlags = normalizeQualityFlags(currentRun?.qualityFlagsJson);
  const watchdogRequeueCount = Math.max(0, parseInteger(qualityFlags.watchdogRequeueCount));

  if (watchdogRequeueCount >= Math.max(1, workerConfig.analysisQueue.jobRetryLimit)) {
    await markBookAnalysisFailed({
      bookId: book.id,
      error: `Watchdog retry budget exhausted after ${watchdogRequeueCount} stale running recoveries`,
      logger: createBookScopedLogger(book.id),
      qualityFlags: {
        degraded: false,
        degradationReasons: [WATCHDOG_REASON_RETRY_EXHAUSTED],
        failedChapterIds: [],
        retryExhausted: true,
      },
    });
    return;
  }

  const now = new Date();
  const nextRequestId = `watchdog-running:${book.id}:${randomUUID()}`;

  await prisma.$transaction(async (tx) => {
    await tx.book.update({
      where: { id: book.id },
      data: {
        analysisState: "queued",
        analysisStatus: "queued",
        analysisError: null,
        analysisRequestedAt: now,
        analysisStartedAt: null,
        analysisFinishedAt: null,
        analysisCompletedAt: null,
        currentAnalysisRunId: null,
      },
    });

    await tx.outbox.create({
      data: {
        aggregateType: "book",
        aggregateId: book.id,
        eventType: "book.npz-analysis.requested",
        payloadJson: {
          bookId: book.id,
          ownerUserId: book.ownerUserId,
          triggerSource: "watchdog_stale_running",
          requestedAt: now.toISOString(),
          requestId: nextRequestId,
        } as Prisma.InputJsonValue,
        availableAt: now,
      },
    });

    if (runId) {
      const mergedReasons = Array.from(
        new Set([
          ...((Array.isArray(qualityFlags.degradationReasons) ? qualityFlags.degradationReasons : []) as string[]),
          WATCHDOG_REASON_STALE_RUNNING,
        ])
      );

      await tx.bookAnalysisRun.updateMany({
        where: {
          id: runId,
        },
        data: {
          qualityFlagsJson: {
            ...qualityFlags,
            degraded: Boolean(qualityFlags.degraded),
            retryExhausted: Boolean(qualityFlags.retryExhausted),
            failedChapterIds: Array.isArray(qualityFlags.failedChapterIds) ? qualityFlags.failedChapterIds : [],
            degradationReasons: mergedReasons,
            watchdogRequeueCount: watchdogRequeueCount + 1,
          } as Prisma.InputJsonValue,
        },
      });
    }
  });

  logger.warn(
    {
      bookId: book.id,
      requestId: nextRequestId,
      watchdogRequeueCount: watchdogRequeueCount + 1,
    },
    "Watchdog requeued stale running analysis"
  );
}

async function runWatchdogSweepInternal() {
  const now = Date.now();
  const staleRunningBefore = new Date(now - Math.max(60_000, workerConfig.analysisQueue.runningStaleTtlMs));
  const staleQueuedBefore = new Date(now - Math.max(60_000, workerConfig.analysisQueue.queuedStaleTtlMs));

  const [runningCandidates, queuedCandidates] = await Promise.all([
    prisma.book.findMany({
      where: {
        analysisStatus: "running",
        analysisStartedAt: {
          lt: staleRunningBefore,
        },
      },
      orderBy: {
        analysisStartedAt: "asc",
      },
      take: 50,
      select: {
        id: true,
        ownerUserId: true,
        currentAnalysisRunId: true,
        latestAnalysisRunId: true,
      },
    }),
    prisma.book.findMany({
      where: {
        analysisStatus: "queued",
        OR: [
          {
            analysisRequestedAt: {
              lt: staleQueuedBefore,
            },
          },
          {
            analysisRequestedAt: null,
            updatedAt: {
              lt: staleQueuedBefore,
            },
          },
        ],
      },
      orderBy: {
        updatedAt: "asc",
      },
      take: 50,
      select: {
        id: true,
        ownerUserId: true,
      },
    }),
  ]);

  await runWithConcurrency(runningCandidates, 4, recoverStaleRunningBook);
  await runWithConcurrency(queuedCandidates, 4, recoverStaleQueuedBook);

  if (runningCandidates.length || queuedCandidates.length) {
    logger.info(
      {
        staleRunningRecovered: runningCandidates.length,
        staleQueuedRecovered: queuedCandidates.length,
      },
      "Analysis watchdog sweep completed"
    );
  }
}

export async function startAnalysisQueueRuntime(): Promise<AnalysisQueueRuntime> {
  const boss = new PgBoss({
    connectionString: workerConfig.databaseUrl,
    schema: "pgboss",
    application_name: "remarka-analysis-worker",
  });

  boss.on("error", (error) => {
    logger.error({ err: error }, "pg-boss error");
  });

  await boss.start();
  await ensureQueues(boss);

  const lockPool = new Pool({
    connectionString: workerConfig.databaseUrl,
    max: Math.max(6, workerConfig.analysisQueue.executorConcurrency + 4),
    idleTimeoutMillis: 30_000,
  });

  if (workerConfig.analysisQueue.mode === "pgboss-hybrid") {
    const executorConcurrency = Math.max(1, workerConfig.analysisQueue.executorConcurrency);
    for (let index = 0; index < executorConcurrency; index += 1) {
      const analysisWorkerId = await boss.work<AnalysisJobPayload>(
        ANALYSIS_QUEUE_NAME,
        {
          batchSize: 1,
          pollingIntervalSeconds: 1,
          includeMetadata: true,
        },
        async (jobs: any[]) => {
          for (const job of jobs) {
            await executeQueueJob({
              boss,
              lockPool,
              job,
            });
          }
        }
      );

      logger.info(
        {
          workerId: analysisWorkerId,
          index: index + 1,
          concurrency: executorConcurrency,
          queue: ANALYSIS_QUEUE_NAME,
        },
        "Analysis executor started"
      );

      const showcaseWorkerId = await boss.work<ShowcaseJobPayload>(
        SHOWCASE_QUEUE_NAME,
        {
          batchSize: 1,
          pollingIntervalSeconds: 1,
          includeMetadata: true,
        },
        async (jobs: any[]) => {
          for (const job of jobs) {
            await executeShowcaseQueueJob({
              boss,
              lockPool,
              job,
            });
          }
        }
      );

      logger.info(
        {
          workerId: showcaseWorkerId,
          index: index + 1,
          concurrency: executorConcurrency,
          queue: SHOWCASE_QUEUE_NAME,
        },
        "Showcase executor started"
      );
    }
  }

  return {
    pollDispatcherOnce: async () => {
      if (workerConfig.analysisQueue.mode !== "pgboss-hybrid") {
        return 0;
      }

      if (!workerConfig.analysisQueue.dispatcherEnabled) {
        return 0;
      }

      const lease = await acquireAdvisoryLease(lockPool, DISPATCHER_LEADER_LOCK_NAME);
      if (!lease) return 0;

      try {
        const entries = await claimDispatchBatch();
        if (!entries.length) return 0;

        await runWithConcurrency(entries, workerConfig.outbox.eventConcurrency, async (entry) => {
          await dispatchOutboxEntry(boss, entry);
        });

        return entries.length;
      } finally {
        await releaseAdvisoryLease(lease);
      }
    },
    runWatchdogSweep: async () => {
      if (workerConfig.analysisQueue.mode !== "pgboss-hybrid") return;
      const lease = await acquireAdvisoryLease(lockPool, WATCHDOG_LEADER_LOCK_NAME);
      if (!lease) return;

      try {
        await runWatchdogSweepInternal();
      } finally {
        await releaseAdvisoryLease(lease);
      }
    },
    stop: async () => {
      await boss.stop({
        graceful: true,
        wait: true,
        close: true,
      });
      await lockPool.end();
    },
  };
}

export async function dispatchAnalysisRequestToOutbox(params: {
  bookId: string;
  ownerUserId: string;
  triggerSource: string;
  requestedAt: Date;
  requestId?: string;
}) {
  await enqueueWatchdogOutboxEvent({
    bookId: params.bookId,
    ownerUserId: params.ownerUserId,
    triggerSource: params.triggerSource,
    requestedAt: params.requestedAt,
    requestId: params.requestId || randomUUID(),
  });
}
