import test from "node:test";
import assert from "node:assert/strict";

import {
  TIER_LIMITS,
  computePeriodWindow,
  getTierLimits,
  resolvePeriodAnchor,
} from "./tiers";

// Tariff configuration lock-in tests. Limits drive both unit economy
// projections and user-facing UI counters — drift here silently breaks
// billing math. Changing any constant should be a deliberate review.

test("Free tier limits match the published 0/0/40/5/14d/0MiB shape", () => {
  const free = getTierLimits("free");
  assert.equal(free.analyses, 0, "free has 0 analyses");
  assert.equal(free.pro, 0, "free has 0 pro");
  assert.equal(free.lite, 40, "free has 40 lite");
  assert.equal(free.librarySlots, 5, "free has 5 library slots");
  assert.equal(free.historyRetentionDays, 14, "free has 14-day history");
  assert.equal(free.uploadMaxMiB, 0, "free has uploads locked");
});

test("Plus tier limits match the published 5/75/300/∞/∞/30MiB shape", () => {
  const plus = getTierLimits("plus");
  assert.equal(plus.analyses, 5);
  assert.equal(plus.pro, 75);
  assert.equal(plus.lite, 300);
  assert.equal(plus.librarySlots, null, "plus is unlimited library");
  assert.equal(plus.historyRetentionDays, null, "plus is unlimited history");
  assert.equal(plus.uploadMaxMiB, 30);
});

test("TIER_LIMITS is exhaustive for every UserTier enum member", () => {
  // If a new tier enum value is added, this test forces us to populate
  // limits before the build can pass.
  const tiers = Object.keys(TIER_LIMITS).sort();
  assert.deepEqual(tiers, ["free", "plus"]);
});

// ────────────────────────────────────────────────────────────────────────
// resolvePeriodAnchor
// ────────────────────────────────────────────────────────────────────────

test("resolvePeriodAnchor: free → createdAt", () => {
  const created = new Date("2026-01-15T10:00:00Z");
  const anchor = resolvePeriodAnchor({
    tier: "free",
    createdAt: created,
    tierActivatedAt: new Date("2026-03-01T00:00:00Z"), // ignored for free
  });
  assert.equal(anchor.toISOString(), created.toISOString());
});

test("resolvePeriodAnchor: plus with tierActivatedAt → tierActivatedAt", () => {
  const created = new Date("2026-01-15T10:00:00Z");
  const activated = new Date("2026-03-01T12:30:00Z");
  const anchor = resolvePeriodAnchor({
    tier: "plus",
    createdAt: created,
    tierActivatedAt: activated,
  });
  assert.equal(anchor.toISOString(), activated.toISOString());
});

test("resolvePeriodAnchor: plus with null tierActivatedAt falls back to createdAt", () => {
  // Defensive: an inconsistent DB row (tier=plus but tierActivatedAt=null)
  // should not crash. We treat it as if the plus had been active since
  // registration.
  const created = new Date("2026-01-15T10:00:00Z");
  const anchor = resolvePeriodAnchor({
    tier: "plus",
    createdAt: created,
    tierActivatedAt: null,
  });
  assert.equal(anchor.toISOString(), created.toISOString());
});

// ────────────────────────────────────────────────────────────────────────
// computePeriodWindow
// ────────────────────────────────────────────────────────────────────────
//
// These tests pin down the day-of-month-aware monthly rolling logic that
// powers both Free and Plus reset cycles. Lock-in for math edge cases.

test("computePeriodWindow: anchor 15th, now mid-cycle → period 15→15 of next month", () => {
  // Anchor: Jan 15. Now: Feb 20. Current period started Feb 15 and ends Mar 15.
  const anchor = new Date("2026-01-15T12:00:00Z");
  const now = new Date("2026-02-20T08:00:00Z");
  const period = computePeriodWindow(anchor, now);
  assert.equal(period.start.toISOString(), "2026-02-15T12:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-03-15T12:00:00.000Z");
});

test("computePeriodWindow: anchor 5th, now is exactly anchor day", () => {
  // Anchor: Jan 5. Now: Mar 5. The period that just rolled over is
  // Mar 5 → Apr 5 (now is the boundary itself, included via gte).
  const anchor = new Date("2026-01-05T09:00:00Z");
  const now = new Date("2026-03-05T09:00:00Z");
  const period = computePeriodWindow(anchor, now);
  assert.equal(period.start.toISOString(), "2026-03-05T09:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-04-05T09:00:00.000Z");
});

test("computePeriodWindow: anchor 31st, now is in February (clamps to Feb 28)", () => {
  // Anchor day 31 has no equivalent in February — should clamp to last day.
  const anchor = new Date("2026-01-31T12:00:00Z");
  const now = new Date("2026-02-15T00:00:00Z"); // mid-Feb
  const period = computePeriodWindow(anchor, now);
  // Feb 2026 has 28 days. Period should be Jan 31 → Feb 28.
  assert.equal(period.start.toISOString(), "2026-01-31T12:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-02-28T12:00:00.000Z");
});

test("computePeriodWindow: anchor 31st, now in April (clamps to Apr 30)", () => {
  const anchor = new Date("2026-03-31T12:00:00Z");
  const now = new Date("2026-04-10T00:00:00Z");
  const period = computePeriodWindow(anchor, now);
  assert.equal(period.start.toISOString(), "2026-03-31T12:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-04-30T12:00:00.000Z");
});

test("computePeriodWindow: anchor 31st, now in May → period Apr 30 → May 31", () => {
  // After clamping to Apr 30, the next period jumps back to the canonical
  // 31st in May. Lock this so the clamping doesn't propagate.
  const anchor = new Date("2026-03-31T12:00:00Z");
  const now = new Date("2026-05-15T00:00:00Z");
  const period = computePeriodWindow(anchor, now);
  // Anchor day 31 → April clamps to 30. May has 31 days — anchor day is
  // restored. Period Apr 30 → May 31.
  assert.equal(period.start.toISOString(), "2026-04-30T12:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-05-31T12:00:00.000Z");
});

test("computePeriodWindow: anchor in past month, now just before anchor day → previous period", () => {
  // Anchor: Jan 20. Now: Feb 15 (5 days BEFORE Feb 20). Period that's
  // currently active started Jan 20 and ends Feb 20.
  const anchor = new Date("2026-01-20T10:00:00Z");
  const now = new Date("2026-02-15T10:00:00Z");
  const period = computePeriodWindow(anchor, now);
  assert.equal(period.start.toISOString(), "2026-01-20T10:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-02-20T10:00:00.000Z");
});

test("computePeriodWindow: year boundary — anchor Dec, now Jan", () => {
  // Anchor: Dec 10. Now: Jan 5 of next year. Period started Dec 10, ends
  // Jan 10 of new year.
  const anchor = new Date("2025-12-10T08:00:00Z");
  const now = new Date("2026-01-05T08:00:00Z");
  const period = computePeriodWindow(anchor, now);
  assert.equal(period.start.toISOString(), "2025-12-10T08:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-01-10T08:00:00.000Z");
});

test("computePeriodWindow: year boundary — anchor Dec 31, now Feb (clamping + year roll)", () => {
  // Anchor: Dec 31, 2025. Now: Feb 5, 2026. Period: Jan 31 → Feb 28
  // (clamped because February has no 31st).
  const anchor = new Date("2025-12-31T15:00:00Z");
  const now = new Date("2026-02-05T15:00:00Z");
  const period = computePeriodWindow(anchor, now);
  assert.equal(period.start.toISOString(), "2026-01-31T15:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-02-28T15:00:00.000Z");
});

test("computePeriodWindow: now exactly at anchor → start at now, end +1 month", () => {
  // Edge: `now` lands exactly on the anchor day at the same time. The
  // anchor day occurrence in current month qualifies as start (gte check).
  const anchor = new Date("2026-01-15T12:00:00Z");
  const now = new Date("2026-04-15T12:00:00Z");
  const period = computePeriodWindow(anchor, now);
  assert.equal(period.start.toISOString(), "2026-04-15T12:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-05-15T12:00:00.000Z");
});
