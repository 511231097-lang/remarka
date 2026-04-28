import test from "node:test";
import assert from "node:assert/strict";
import {
  applyStrictJsonAttemptToTaskMetadata,
  mergeBookAnalyzerTaskMetadata,
  parseBookAnalyzerTaskMetadata,
} from "./bookAnalyzerTaskMetadata";

test("applyStrictJsonAttemptToTaskMetadata accumulates attempts, models, and usage", () => {
  const once = applyStrictJsonAttemptToTaskMetadata({}, {
    model: "gemini-lite",
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    },
    success: true,
  });
  const twice = applyStrictJsonAttemptToTaskMetadata(once, {
    model: "gemini-flash",
    usage: {
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
    },
    error: "schema mismatch",
    success: false,
  });

  assert.equal(twice.attempts, 2);
  assert.deepEqual(twice.models, ["gemini-lite", "gemini-flash"]);
  assert.equal(twice.promptTokens, 220);
  assert.equal(twice.completionTokens, 130);
  assert.equal(twice.totalTokens, 350);
  assert.equal(twice.lastReason, "schema mismatch");
  assert.equal(twice.lastValidationError, "schema mismatch");
});

test("mergeBookAnalyzerTaskMetadata normalizes and clears nullable fields", () => {
  const merged = mergeBookAnalyzerTaskMetadata(
    {
      attempts: 1,
      deferredReason: "waiting",
      selectedModel: "gemini-lite",
      models: ["gemini-lite"],
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      degraded: true,
      fallbackKind: "deterministic_sections",
      lastValidationError: "broken",
      lastReason: "broken",
    },
    {
      deferredReason: null,
      lastReason: null,
      selectedModel: "gemini-flash",
      models: ["gemini-lite", "gemini-flash"],
      degraded: false,
    }
  );

  const parsed = parseBookAnalyzerTaskMetadata(merged);
  assert.equal(parsed.deferredReason, null);
  assert.equal(parsed.lastReason, null);
  assert.equal(parsed.selectedModel, "gemini-flash");
  assert.deepEqual(parsed.models, ["gemini-lite", "gemini-flash"]);
  assert.equal(parsed.degraded, false);
});
