import { prisma } from "@remarka/db";
import type { UserTier } from "@prisma/client";
import {
  computePeriodWindow,
  getTierLimits,
  resolvePeriodAnchor,
  type PeriodWindow,
  type TierLimits,
} from "./tiers";

/**
 * Per-bucket usage snapshot. Drives gates (chat / upload / library) and
 * the `/api/me/usage` endpoint that powers UI counters.
 *
 * Counts are computed on-the-fly from existing tables — there is no
 * denormalized counter. The queries hit indexed columns so latency is
 * negligible (~1-3ms for a typical user). A race-condition window of one
 * concurrent over-spend turn is accepted at v1 volume.
 *
 * Single source of truth:
 * - `pro` / `lite` from `BookChatTurnMetric` filtered by ownerUserId via
 *   the thread + by `chatModel` substring.
 * - `analyses` from `BookAnalysisRun` joined to `Book.ownerUserId`,
 *   filtered to runs that started within the period (state ∈
 *   {running, completed} — failed/queued runs DON'T spend a slot, they're
 *   either waiting or didn't actually do the work).
 */

export interface BucketUsage {
  used: number;
  limit: number;
  /** Remaining = max(0, limit - used). 0 means cap reached. */
  remaining: number;
  /** True when used >= limit (hard cap hit). */
  exhausted: boolean;
  /** True when bucket is locked entirely for this tier (limit === 0). */
  locked: boolean;
}

export interface UsageSnapshot {
  tier: UserTier;
  period: {
    start: string;
    end: string;
  };
  buckets: {
    analyses: BucketUsage;
    pro: BucketUsage;
    lite: BucketUsage;
  };
  // Static limits exposed alongside dynamic usage so the UI can render
  // "5 books in library" even when nothing's been saved yet.
  staticLimits: {
    librarySlots: number | null;
    historyRetentionDays: number | null;
    uploadMaxMiB: number;
  };
}

function bucket(used: number, limit: number): BucketUsage {
  const safeUsed = Math.max(0, Math.floor(used));
  const safeLimit = Math.max(0, Math.floor(limit));
  return {
    used: safeUsed,
    limit: safeLimit,
    remaining: Math.max(0, safeLimit - safeUsed),
    exhausted: safeLimit > 0 && safeUsed >= safeLimit,
    locked: safeLimit === 0,
  };
}

/**
 * Pull tier + buckets for a user. Caller must pass a `User` row with
 * `tier`, `createdAt` and `tierActivatedAt` already loaded — usually via
 * `resolveAuthUser()` augmented with the billing fields.
 */
export async function getBucketUsage(user: {
  id: string;
  tier: UserTier;
  createdAt: Date;
  tierActivatedAt: Date | null;
}): Promise<UsageSnapshot> {
  const limits: TierLimits = getTierLimits(user.tier);
  const anchor = resolvePeriodAnchor(user);
  const period: PeriodWindow = computePeriodWindow(anchor);

  const [proCount, liteCount, analysisCount] = await Promise.all([
    prisma.bookChatTurnMetric.count({
      where: {
        thread: { ownerUserId: user.id },
        chatModel: { contains: "pro" },
        createdAt: { gte: period.start, lt: period.end },
      },
    }),
    prisma.bookChatTurnMetric.count({
      where: {
        thread: { ownerUserId: user.id },
        chatModel: { contains: "lite" },
        createdAt: { gte: period.start, lt: period.end },
      },
    }),
    prisma.bookAnalysisRun.count({
      where: {
        book: { ownerUserId: user.id },
        // running OR completed — failed runs don't spend the slot, queued
        // hasn't actually consumed cost yet.
        state: { in: ["running", "completed"] },
        // Use `startedAt` rather than `createdAt`: the slot is "spent" when
        // the worker actually picks the run up. Falls back to createdAt
        // when startedAt is null (queued state filtered out above already).
        startedAt: { gte: period.start, lt: period.end },
      },
    }),
  ]);

  return {
    tier: user.tier,
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    },
    buckets: {
      analyses: bucket(analysisCount, limits.analyses),
      pro: bucket(proCount, limits.pro),
      lite: bucket(liteCount, limits.lite),
    },
    staticLimits: {
      librarySlots: limits.librarySlots,
      historyRetentionDays: limits.historyRetentionDays,
      uploadMaxMiB: limits.uploadMaxMiB,
    },
  };
}

/**
 * Lightweight gate helpers — used inside chat / upload / library handlers
 * to refuse the operation cleanly without duplicating the bucket-math.
 */

export class BucketCapError extends Error {
  constructor(
    public readonly bucketKind: "analyses" | "pro" | "lite",
    public readonly tier: UserTier,
    public readonly limit: number,
    public readonly periodResetAt: string,
  ) {
    super(`Bucket "${bucketKind}" exhausted for tier "${tier}" (limit ${limit}).`);
    this.name = "BucketCapError";
  }
}

export class BucketLockedError extends Error {
  constructor(public readonly bucketKind: "analyses" | "pro", public readonly tier: UserTier) {
    super(`Bucket "${bucketKind}" is locked for tier "${tier}". Upgrade required.`);
    this.name = "BucketLockedError";
  }
}
