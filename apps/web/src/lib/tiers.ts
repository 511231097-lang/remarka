import type { UserTier } from "@prisma/client";

/**
 * Subscription tier configuration.
 *
 * Limits are intentionally code-side (not DB) so we can iterate quickly
 * without migrations. Once the model stabilizes we'll either freeze these
 * or move to a `TierConfig` table that an admin can edit at runtime.
 *
 * Bucket model (Copilot-style):
 * - `analyses` — book uploads triggering full analysis pipeline.
 *   Free: locked. Plus: 5/period.
 * - `pro` — chat answers routed to Pro tier (gemini-3.1-pro-preview).
 *   Free: locked. Plus: 75/period.
 * - `lite` — chat answers on the Lite tier. Free: 40/period (also serves
 *   as soft fallback when a Plus user exhausts pro budget).
 *
 * Period anchor:
 * - Free → `User.createdAt` (registration date).
 * - Plus → `User.tierActivatedAt` (subscription start). Falls back to
 *   `createdAt` if for any reason `tierActivatedAt` is null.
 *
 * Period rolls in 30-day cycles from the anchor (day-of-month aware via
 * `computePeriodWindow`). Reset point depends on the anchor's day-of-month.
 */

export interface TierLimits {
  analyses: number;
  pro: number;
  lite: number;
  /** Max books in personal "Library" (saved/owned). null = unlimited. */
  librarySlots: number | null;
  /** Max upload file size in MiB. */
  uploadMaxMiB: number;
}

// History retention is intentionally NOT capped per tier: storage cost is
// negligible (a year of 40 free turns/mo ≈ 600 KB/user) and silently
// deleting user data is anti-pattern UX that hurts trust without driving
// upgrades. Free users keep their threads forever like Plus does — only
// the answer-volume buckets gate the experience.

export const TIER_LIMITS: Record<UserTier, TierLimits> = {
  free: {
    analyses: 0,
    pro: 0,
    lite: 40,
    librarySlots: 5,
    uploadMaxMiB: 0, // upload itself locked
  },
  plus: {
    analyses: 5,
    pro: 75,
    lite: 300,
    librarySlots: null,
    uploadMaxMiB: 30,
  },
};

export function getTierLimits(tier: UserTier): TierLimits {
  return TIER_LIMITS[tier];
}

/**
 * Given an anchor date and `now`, return the start and end of the current
 * 30-day rolling period. The period starts on the same calendar day-of-month
 * as the anchor, falling back to the last day of a shorter month (so an
 * anchor on the 31st rolls correctly through February).
 *
 * Examples:
 * - anchor=Jan 15 12:00, now=Feb 20 → period Feb 15 → Mar 15
 * - anchor=Jan 31 12:00, now=Feb 28 → period Feb 28 → Mar 31
 * - anchor=Mar 31 12:00, now=Apr 30 → period Mar 31 → Apr 30 (Apr=30)
 *
 * The "anchor day" is preserved in subsequent months by clamping to the
 * last day of the target month — this is the same rule ЮKassa, Stripe and
 * most billing platforms use, so the behaviour matches future integration.
 */
export interface PeriodWindow {
  start: Date;
  end: Date;
}

export function computePeriodWindow(anchor: Date, now: Date = new Date()): PeriodWindow {
  const anchorDay = anchor.getUTCDate();
  const anchorTimeMs =
    anchor.getUTCHours() * 3_600_000 +
    anchor.getUTCMinutes() * 60_000 +
    anchor.getUTCSeconds() * 1_000 +
    anchor.getUTCMilliseconds();

  // Helper: produce a UTC date with the anchor's day-of-month and hh:mm:ss
  // for the given (year, month) — clamping the day if the month is shorter.
  const dateForMonth = (year: number, monthZeroBased: number) => {
    const lastDayOfMonth = new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
    const day = Math.min(anchorDay, lastDayOfMonth);
    const ts = Date.UTC(year, monthZeroBased, day) + anchorTimeMs;
    return new Date(ts);
  };

  // Walk back from `now` to find the most recent occurrence of the anchor
  // day. We start with the current month and step back if `candidate > now`.
  const currentMonthCandidate = dateForMonth(now.getUTCFullYear(), now.getUTCMonth());
  let start: Date;
  if (currentMonthCandidate.getTime() <= now.getTime()) {
    start = currentMonthCandidate;
  } else {
    // Roll back one month.
    const prevMonth = now.getUTCMonth() - 1;
    if (prevMonth < 0) {
      start = dateForMonth(now.getUTCFullYear() - 1, 11);
    } else {
      start = dateForMonth(now.getUTCFullYear(), prevMonth);
    }
  }

  // End = next month-anchor occurrence.
  const startMonth = start.getUTCMonth();
  const startYear = start.getUTCFullYear();
  const end =
    startMonth === 11
      ? dateForMonth(startYear + 1, 0)
      : dateForMonth(startYear, startMonth + 1);

  return { start, end };
}

/**
 * Resolve the period anchor for a user. Plus users use `tierActivatedAt`,
 * Free (or Plus with missing activation date) fall back to `createdAt`.
 */
export function resolvePeriodAnchor(user: {
  tier: UserTier;
  createdAt: Date;
  tierActivatedAt: Date | null;
}): Date {
  if (user.tier === "plus" && user.tierActivatedAt) return user.tierActivatedAt;
  return user.createdAt;
}
