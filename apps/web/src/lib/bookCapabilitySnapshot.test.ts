import test from "node:test";
import assert from "node:assert/strict";
import { buildBookCapabilitySnapshot, canUseMvpBookChat, canUseParagraphOnlyBookChat } from "./bookCapabilitySnapshot";
import { buildBookChatReadiness, createEmptyAnalyzerStatus } from "./bookChatReadiness";
import type { BookAnalysisStatusDTO } from "./books";

function completedStatus() {
  return {
    state: "completed",
    error: null,
    startedAt: "2026-04-15T00:00:00.000Z",
    completedAt: "2026-04-15T00:00:01.000Z",
  } as const;
}

test("buildBookCapabilitySnapshot marks MVP tools trusted when canonical/read layers are ready", () => {
  const analyzers = {
    ingest_normalize: completedStatus(),
    structural_pass: completedStatus(),
    local_extraction_mentions: completedStatus(),
    local_extraction_quotes: completedStatus(),
    local_extraction_events: completedStatus(),
    local_extraction_relations: completedStatus(),
    local_extraction_time_location: completedStatus(),
    validation_pass: completedStatus(),
    entity_resolution: completedStatus(),
    scene_assembly: completedStatus(),
    event_timeline: completedStatus(),
    relation_aggregation: completedStatus(),
    summary_synthesis: completedStatus(),
    index_build: completedStatus(),
    repair: completedStatus(),
  } satisfies BookAnalysisStatusDTO["analyzers"];

  const snapshot = buildBookCapabilitySnapshot({
    bookId: "book-1",
    contentVersion: 3,
    overallState: "completed",
    coverage: "partial",
    analyzers,
    counts: {
      source: { chapters: 7, paragraphs: 4426, windows: 1095 },
      observations: { total: 100, valid: 99, invalid: 1 },
      canonical: { entities: 200, scenes: 300, events: 2000, relations: 0, quotes: 3000, summaries: 800 },
      readLayer: {
        entityCards: 200,
        sceneCards: 300,
        relationCards: 0,
        timelineSlices: 2000,
        quoteSlices: 3000,
        searchDocuments: 1400,
        evidenceHits: 2500,
        presenceMaps: 900,
        processingReports: 1,
      },
    },
  });

  assert.equal(snapshot.capabilities.resolve_target, "high");
  assert.equal(snapshot.capabilities.get_presence, "high");
  assert.equal(snapshot.capabilities.get_evidence, "high");
  assert.equal(snapshot.trustedTools.read_passages, true);
  assert.equal(canUseMvpBookChat(snapshot), true);
});

test("buildBookChatReadiness opens MVP chat when capability snapshot is ready", () => {
  const analyzers = {
    ingest_normalize: completedStatus(),
    structural_pass: createEmptyAnalyzerStatus(),
    local_extraction_mentions: createEmptyAnalyzerStatus(),
    local_extraction_quotes: createEmptyAnalyzerStatus(),
    local_extraction_events: createEmptyAnalyzerStatus(),
    local_extraction_relations: createEmptyAnalyzerStatus(),
    local_extraction_time_location: createEmptyAnalyzerStatus(),
    validation_pass: createEmptyAnalyzerStatus(),
    entity_resolution: completedStatus(),
    scene_assembly: completedStatus(),
    event_timeline: createEmptyAnalyzerStatus(),
    relation_aggregation: createEmptyAnalyzerStatus(),
    summary_synthesis: createEmptyAnalyzerStatus(),
    index_build: completedStatus(),
    repair: createEmptyAnalyzerStatus(),
  } satisfies BookAnalysisStatusDTO["analyzers"];

  const snapshot = buildBookCapabilitySnapshot({
    bookId: "book-1",
    contentVersion: 2,
    overallState: "running",
    coverage: "partial",
    analyzers,
    counts: {
      source: { chapters: 7, paragraphs: 4426, windows: 1095 },
      observations: { total: 100, valid: 99, invalid: 1 },
      canonical: { entities: 200, scenes: 300, events: 2000, relations: 0, quotes: 3000, summaries: 800 },
      readLayer: {
        entityCards: 200,
        sceneCards: 300,
        relationCards: 0,
        timelineSlices: 2000,
        quoteSlices: 3000,
        searchDocuments: 1400,
        evidenceHits: 2500,
        presenceMaps: 900,
        processingReports: 1,
      },
    },
  });

  const readiness = buildBookChatReadiness(analyzers, snapshot);
  assert.equal(readiness.canChat, true);
  assert.match(readiness.summary, /MVP-чат/);
});

test("buildBookChatReadiness opens paragraph-only chat when scenes are temporarily disabled", () => {
  const analyzers = {
    ingest_normalize: completedStatus(),
    structural_pass: completedStatus(),
    local_extraction_mentions: completedStatus(),
    local_extraction_quotes: completedStatus(),
    local_extraction_events: completedStatus(),
    local_extraction_relations: completedStatus(),
    local_extraction_time_location: completedStatus(),
    validation_pass: completedStatus(),
    entity_resolution: completedStatus(),
    scene_assembly: completedStatus(),
    event_timeline: completedStatus(),
    relation_aggregation: completedStatus(),
    summary_synthesis: completedStatus(),
    index_build: completedStatus(),
    repair: completedStatus(),
  } satisfies BookAnalysisStatusDTO["analyzers"];

  const snapshot = buildBookCapabilitySnapshot({
    bookId: "book-1",
    contentVersion: null,
    overallState: "completed",
    coverage: "partial",
    analyzers,
    counts: {
      source: { chapters: 7, paragraphs: 4426, windows: 0 },
      observations: { total: 0, valid: 0, invalid: 0 },
      canonical: { entities: 0, scenes: 0, events: 0, relations: 0, quotes: 0, summaries: 0 },
      readLayer: {
        entityCards: 0,
        sceneCards: 0,
        relationCards: 0,
        timelineSlices: 0,
        quoteSlices: 0,
        searchDocuments: 4426,
        evidenceHits: 0,
        presenceMaps: 0,
        processingReports: 0,
      },
    },
  });

  assert.equal(canUseMvpBookChat(snapshot), false);
  assert.equal(canUseParagraphOnlyBookChat(snapshot), true);

  const readiness = buildBookChatReadiness(analyzers, snapshot);
  assert.equal(readiness.canChat, true);
  assert.match(readiness.summary, /поиск по абзацам/);
});
