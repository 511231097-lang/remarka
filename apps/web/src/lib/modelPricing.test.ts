import test from "node:test";
import assert from "node:assert/strict";

import {
  computeEmbeddingCostUsd,
  computeLlmCostUsd,
  computeRerankCostUsd,
  DEFAULT_CACHE_DISCOUNT_FACTOR,
} from "@remarka/db";

// Cost-compute lock-in tests. These helpers drive every USD figure on the
// chat side AND the analysis pipeline — drifting them silently corrupts
// unit-economy reporting. Treat any change as a finance-review trigger.
//
// Pricing constants below match `gemini-3.1-flash-lite-preview` defaults
// in DEFAULT_MODEL_PRICING_CATALOG ($0.25/$1.5 per 1M).

const LITE_PRICING = {
  chatInputPer1MUsd: 0.25,
  chatOutputPer1MUsd: 1.5,
  cacheDiscountFactor: 0.1,
};

const EMBEDDING_PRICING = {
  embeddingInputPer1MUsd: 0.15,
};

test("computeLlmCostUsd: uncached input billed at full rate", () => {
  // 1M tokens × $0.25/M = $0.25
  const cost = computeLlmCostUsd({
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputBilledTokens: 0,
    pricing: LITE_PRICING,
  });
  assert.equal(cost, 0.25);
});

test("computeLlmCostUsd: fully cached input gets the 90% discount", () => {
  // 1M cached tokens × $0.25/M × 10% = $0.025
  const cost = computeLlmCostUsd({
    inputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    outputBilledTokens: 0,
    pricing: LITE_PRICING,
  });
  assert.equal(cost, 0.025);
});

test("computeLlmCostUsd: split input applies cache discount only to cached portion", () => {
  // 600k fresh × $0.25/M = $0.15
  // 400k cached × $0.025/M = $0.01
  // total = $0.16
  const cost = computeLlmCostUsd({
    inputTokens: 1_000_000,
    cachedInputTokens: 400_000,
    outputBilledTokens: 0,
    pricing: LITE_PRICING,
  });
  assert.equal(cost, 0.16);
});

test("computeLlmCostUsd: cached > input is clamped (no negative fresh)", () => {
  // Defensive: if upstream double-counts cache, we don't go negative.
  const cost = computeLlmCostUsd({
    inputTokens: 100_000,
    cachedInputTokens: 9_999_999,
    outputBilledTokens: 0,
    pricing: LITE_PRICING,
  });
  // All 100k treated as cached → 100k × $0.025/M = $0.0025
  // (rounded to handle JS float precision)
  assert.equal(Number(cost.toFixed(8)), 0.0025);
});

test("computeLlmCostUsd: output billed at chatOutputPer1MUsd", () => {
  // 1M output tokens × $1.5/M = $1.5
  const cost = computeLlmCostUsd({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputBilledTokens: 1_000_000,
    pricing: LITE_PRICING,
  });
  assert.equal(cost, 1.5);
});

test("computeLlmCostUsd: caller is responsible for adding thoughts to outputBilledTokens", () => {
  // Worker path: candidates=200k visible + thoughts=300k hidden = 500k billable.
  // Doc says caller sums them before passing.
  const candidatesTokens = 200_000;
  const thoughtsTokens = 300_000;
  const cost = computeLlmCostUsd({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputBilledTokens: candidatesTokens + thoughtsTokens,
    pricing: LITE_PRICING,
  });
  // 500k × $1.5/M = $0.75
  assert.equal(cost, 0.75);
});

test("computeLlmCostUsd: realistic mixed turn (cache hit + thoughts)", () => {
  // 800k input total, 200k of which cached
  // 50k visible output + 150k thoughts = 200k billable output
  const cost = computeLlmCostUsd({
    inputTokens: 800_000,
    cachedInputTokens: 200_000,
    outputBilledTokens: 50_000 + 150_000,
    pricing: LITE_PRICING,
  });
  // fresh: 600k × $0.25/M = 0.15
  // cached: 200k × $0.025/M = 0.005
  // output: 200k × $1.5/M = 0.30
  // total: 0.455
  assert.equal(Number(cost.toFixed(6)), 0.455);
});

test("computeEmbeddingCostUsd: simple linear billing", () => {
  // 500k tokens × $0.15/M = $0.075
  const cost = computeEmbeddingCostUsd({
    embeddingInputTokens: 500_000,
    pricing: EMBEDDING_PRICING,
  });
  assert.equal(cost, 0.075);
});

test("computeEmbeddingCostUsd: zero tokens → zero cost", () => {
  const cost = computeEmbeddingCostUsd({
    embeddingInputTokens: 0,
    pricing: EMBEDDING_PRICING,
  });
  assert.equal(cost, 0);
});

test("computeRerankCostUsd: 1 call billed at $0.001 (Vertex $1/1k default)", () => {
  const cost = computeRerankCostUsd({
    callCount: 1,
    rerankPer1KQueriesUsd: 1.0,
  });
  assert.equal(cost, 0.001);
});

test("computeRerankCostUsd: 1000 calls = $1", () => {
  const cost = computeRerankCostUsd({
    callCount: 1000,
    rerankPer1KQueriesUsd: 1.0,
  });
  assert.equal(cost, 1.0);
});

test("computeRerankCostUsd: zero calls → zero cost (no division-by-zero)", () => {
  const cost = computeRerankCostUsd({
    callCount: 0,
    rerankPer1KQueriesUsd: 1.0,
  });
  assert.equal(cost, 0);
});

test("computeRerankCostUsd: negative inputs floor to zero", () => {
  // Defensive — caller should never pass negatives, but we don't go negative.
  const cost = computeRerankCostUsd({
    callCount: -5,
    rerankPer1KQueriesUsd: -1,
  });
  assert.equal(cost, 0);
});

test("DEFAULT_CACHE_DISCOUNT_FACTOR matches Vertex documented 90% discount", () => {
  // If Google ever changes the cache discount, this assertion fires and we
  // can update the constant + re-price historical analyses.
  assert.equal(DEFAULT_CACHE_DISCOUNT_FACTOR, 0.1);
});
