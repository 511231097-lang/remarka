import test from "node:test";
import assert from "node:assert/strict";
import {
  completedExecution,
  deferredDependenciesExecution,
  deferredLockExecution,
  hardFailureExecution,
  resolveOutboxTransition,
  retryableFailureExecution,
} from "./analyzerExecution";

test("resolveOutboxTransition marks completed events as processed", () => {
  const now = new Date("2026-04-14T10:00:00.000Z");
  const transition = resolveOutboxTransition({
    result: completedExecution(),
    now,
    currentAttemptCount: 2,
    maxAttempts: 8,
  });

  assert.equal(transition.processedAt?.toISOString(), now.toISOString());
  assert.equal(transition.error, null);
  assert.equal(transition.attemptCount, undefined);
});

test("resolveOutboxTransition keeps deferred events pending without incrementing attempts", () => {
  const now = new Date("2026-04-14T10:00:00.000Z");
  const deferredAt = new Date("2026-04-14T10:00:15.000Z");

  const dependencyTransition = resolveOutboxTransition({
    result: {
      status: "deferred_dependencies",
      reason: "deps",
      availableAt: deferredAt,
    },
    now,
    currentAttemptCount: 3,
    maxAttempts: 8,
  });
  assert.equal(dependencyTransition.processedAt, null);
  assert.equal(dependencyTransition.attemptCount, undefined);
  assert.equal(dependencyTransition.availableAt?.toISOString(), deferredAt.toISOString());

  const lockTransition = resolveOutboxTransition({
    result: deferredLockExecution("lock", 2_000),
    now,
    currentAttemptCount: 1,
    maxAttempts: 8,
  });
  assert.equal(lockTransition.processedAt, null);
  assert.equal(lockTransition.attemptCount, undefined);
  assert.equal(lockTransition.error, "lock");
});

test("resolveOutboxTransition increments attempts for retryable and hard failures", () => {
  const now = new Date("2026-04-14T10:00:00.000Z");

  const retryableTransition = resolveOutboxTransition({
    result: retryableFailureExecution("retry later", 15_000),
    now,
    currentAttemptCount: 2,
    maxAttempts: 8,
  });
  assert.equal(retryableTransition.processedAt, null);
  assert.equal(retryableTransition.attemptCount, 3);
  assert.equal(retryableTransition.error, "retry later");

  const hardTransition = resolveOutboxTransition({
    result: hardFailureExecution("boom"),
    now,
    currentAttemptCount: 2,
    maxAttempts: 8,
  });
  assert.equal(hardTransition.processedAt?.toISOString(), now.toISOString());
  assert.equal(hardTransition.attemptCount, 3);
  assert.equal(hardTransition.error, "boom");
});
