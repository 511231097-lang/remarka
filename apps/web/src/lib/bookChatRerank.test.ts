import test from "node:test";
import assert from "node:assert/strict";

import { extractChatRerankCalls, type ChatToolRun } from "./bookChatService";

// Lock-in tests for rerank invocation extraction. This helper drives both
// the per-turn aggregate columns on BookChatTurnMetric and the granular
// rows in BookRerankCall — drift here corrupts cost reporting AND the
// audit trail. Match the shape of `VertexRerankMeta` exactly.

const PRICING = { rerankPer1KQueriesUsd: 1.0 };

function toolRunWithRerank(rerank: Record<string, unknown> | undefined): ChatToolRun {
  return {
    tool: "search_scenes",
    args: {},
    resultMeta: rerank ? { rerank } : {},
  };
}

test("emits one row per successful rerank invocation", () => {
  const calls = extractChatRerankCalls(
    [
      toolRunWithRerank({
        enabled: true,
        used: true,
        candidateCount: 30,
        returned: 10,
        model: "semantic-ranker-default@latest",
        latencyMs: 245,
      }),
    ],
    PRICING,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    source: "chat",
    model: "semantic-ranker-default@latest",
    recordCount: 30,
    returnedCount: 10,
    latencyMs: 245,
    costUsd: 0.001,
    errorCode: null,
  });
});

test("emits a row for failed invocations with errorCode + zero cost", () => {
  const calls = extractChatRerankCalls(
    [
      toolRunWithRerank({
        enabled: true,
        used: false,
        candidateCount: 30,
        returned: 0,
        model: "semantic-ranker-default@latest",
        latencyMs: 5000,
        error: "Vertex 429 quota exhausted",
      }),
    ],
    PRICING,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.errorCode, "Vertex 429 quota exhausted");
  // Failed call did hit Vertex (latency > 0) but Google still bills nothing
  // for the failure response — verify cost stays 0.
  assert.equal(calls[0]!.costUsd, 0);
});

test("skips invocations that were disabled by config (no API call fired)", () => {
  const calls = extractChatRerankCalls(
    [
      toolRunWithRerank({
        enabled: false,
        used: false,
        candidateCount: 30,
        returned: 0,
        model: "semantic-ranker-default@latest",
        latencyMs: 0,
      }),
    ],
    PRICING,
  );
  assert.equal(calls.length, 0);
});

test("skips invocations with empty candidate list (early-return path)", () => {
  // rerankSearchCandidates short-circuits when no records are available.
  // Those should NOT be billed and should NOT appear in the audit trail.
  const calls = extractChatRerankCalls(
    [
      toolRunWithRerank({
        enabled: true,
        used: false,
        candidateCount: 0,
        returned: 0,
        model: "semantic-ranker-default@latest",
        latencyMs: 0,
      }),
    ],
    PRICING,
  );
  assert.equal(calls.length, 0);
});

test("skips toolRuns that do not include a rerank meta block", () => {
  // search tools that didn't run rerank (e.g., lexical-only path) have no
  // `rerank` field on resultMeta — must be ignored cleanly.
  const calls = extractChatRerankCalls([toolRunWithRerank(undefined)], PRICING);
  assert.equal(calls.length, 0);
});

test("aggregates multiple rerank calls (one per search tool) in turn order", () => {
  // A complex turn can fire scene + paragraph rerank in sequence — both
  // should produce billable rows.
  const calls = extractChatRerankCalls(
    [
      toolRunWithRerank({
        enabled: true,
        used: true,
        candidateCount: 30,
        returned: 10,
        model: "semantic-ranker-default@latest",
        latencyMs: 200,
      }),
      toolRunWithRerank({
        enabled: true,
        used: true,
        candidateCount: 60,
        returned: 20,
        model: "semantic-ranker-default@latest",
        latencyMs: 350,
      }),
    ],
    PRICING,
  );
  assert.equal(calls.length, 2);
  const totalCost = calls.reduce((sum, call) => sum + call.costUsd, 0);
  // 2 calls × $0.001 = $0.002
  assert.equal(Number(totalCost.toFixed(6)), 0.002);
  const totalRecords = calls.reduce((sum, call) => sum + call.recordCount, 0);
  assert.equal(totalRecords, 90);
});

test("respects custom rerankPer1KQueriesUsd override", () => {
  // Operator may have BOOK_COST_RERANK_PER_1K_QUERIES_USD set to a custom rate;
  // helper should use whatever pricing it receives.
  const calls = extractChatRerankCalls(
    [
      toolRunWithRerank({
        enabled: true,
        used: true,
        candidateCount: 30,
        returned: 10,
        model: "semantic-ranker-default@latest",
        latencyMs: 200,
      }),
    ],
    { rerankPer1KQueriesUsd: 5.0 },
  );
  assert.equal(calls[0]!.costUsd, 0.005);
});
