import test from "node:test";
import assert from "node:assert/strict";
import { __bookAnalysisLifecycleTestUtils, REQUIRED_BOOK_ANALYZER_TYPES } from "./bookAnalysisLifecycle";

test("resolveBookAnalysisLifecycleState stays running until every required stage is completed", () => {
  const tasks = REQUIRED_BOOK_ANALYZER_TYPES.slice(0, -1).map((analyzerType) => ({
    analyzerType,
    state: "completed",
    error: null,
  }));

  assert.deepEqual(__bookAnalysisLifecycleTestUtils.resolveBookAnalysisLifecycleState(tasks), {
    state: "running",
    error: null,
  });
});

test("resolveBookAnalysisLifecycleState marks completed only when every required stage is completed", () => {
  const tasks = REQUIRED_BOOK_ANALYZER_TYPES.map((analyzerType) => ({
    analyzerType,
    state: "completed",
    error: null,
  }));

  assert.deepEqual(__bookAnalysisLifecycleTestUtils.resolveBookAnalysisLifecycleState(tasks), {
    state: "completed",
    error: null,
  });
});

test("resolveBookAnalysisLifecycleState surfaces failed analyzer stages", () => {
  const tasks = REQUIRED_BOOK_ANALYZER_TYPES.map((analyzerType) => ({
    analyzerType,
    state: analyzerType === "entity_graph" ? "failed" : "completed",
    error: analyzerType === "entity_graph" ? "entity graph failed" : null,
  }));

  assert.deepEqual(__bookAnalysisLifecycleTestUtils.resolveBookAnalysisLifecycleState(tasks), {
    state: "failed",
    error: "entity graph failed",
  });
});
