import test from "node:test";
import assert from "node:assert/strict";
import { __processBookChatIndexTestUtils } from "./processBookChatIndex";

test("parseRetryAfterMs supports seconds and HTTP date values", () => {
  assert.equal(__processBookChatIndexTestUtils.parseRetryAfterMs("5"), 5_000);

  const nowMs = Date.parse("2026-04-15T10:00:00.000Z");
  const retryAt = new Date("2026-04-15T10:00:07.000Z").toUTCString();
  assert.equal(__processBookChatIndexTestUtils.parseRetryAfterMs(retryAt, nowMs), 7_000);
});

test("isRetryableEmbeddingStatus retries transient vertex statuses only", () => {
  assert.equal(__processBookChatIndexTestUtils.isRetryableEmbeddingStatus(429), true);
  assert.equal(__processBookChatIndexTestUtils.isRetryableEmbeddingStatus(500), true);
  assert.equal(__processBookChatIndexTestUtils.isRetryableEmbeddingStatus(502), true);
  assert.equal(__processBookChatIndexTestUtils.isRetryableEmbeddingStatus(503), true);
  assert.equal(__processBookChatIndexTestUtils.isRetryableEmbeddingStatus(504), true);
  assert.equal(__processBookChatIndexTestUtils.isRetryableEmbeddingStatus(400), false);
  assert.equal(__processBookChatIndexTestUtils.isRetryableEmbeddingStatus(404), false);
});

test("computeEmbeddingBackoffDelayMs uses exponential backoff with jitter when Retry-After is absent", () => {
  const delayMs = __processBookChatIndexTestUtils.computeEmbeddingBackoffDelayMs({
    attempt: 2,
    randomFraction: 0.25,
  });

  assert.equal(delayMs, 4_250);
});

test("computeEmbeddingBackoffDelayMs respects Retry-After floor and max cap", () => {
  const retryAfterDelay = __processBookChatIndexTestUtils.computeEmbeddingBackoffDelayMs({
    attempt: 0,
    retryAfterMs: 5_000,
    randomFraction: 0,
  });
  assert.equal(retryAfterDelay, 5_000);

  const cappedDelay = __processBookChatIndexTestUtils.computeEmbeddingBackoffDelayMs({
    attempt: 5,
    retryAfterMs: 60_000,
    randomFraction: 0.9,
  });
  assert.equal(cappedDelay, 32_000);
});
