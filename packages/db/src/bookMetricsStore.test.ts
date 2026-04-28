import test from "node:test";
import assert from "node:assert/strict";
import {
  createBookAnalysisArtifactManifest,
  createBookAnalysisRun,
  ensureBookContentVersion,
  replaceBookChatToolRuns,
  upsertBookChatTurnMetric,
} from "./bookMetricsStore";

test("ensureBookContentVersion reuses latest version when file hash matches", async () => {
  let created = false;
  const client = {
    bookContentVersion: {
      async findFirst() {
        return {
          id: "cv-3",
          version: 3,
          fileSha256: "same-hash",
        };
      },
      async create() {
        created = true;
        return {
          id: "cv-4",
          version: 4,
        };
      },
    },
  };

  const result = await ensureBookContentVersion({
    client,
    bookId: "book-1",
    fileSha256: "same-hash",
    fileName: "book.fb2",
    mimeType: "application/xml",
  });

  assert.deepEqual(result, {
    id: "cv-3",
    version: 3,
  });
  assert.equal(created, false);
});

test("createBookAnalysisRun increments attempt per content version and updates latest snapshot pointers", async () => {
  const observed: Record<string, unknown> = {};
  const client = {
    bookAnalysisRun: {
      async findFirst() {
        return {
          attempt: 2,
        };
      },
      async create(input: Record<string, unknown>) {
        observed.create = input;
        return {
          id: "run-3",
          attempt: 3,
          contentVersionId: "cv-1",
        };
      },
    },
    book: {
      async update(input: Record<string, unknown>) {
        observed.bookUpdate = input;
        return {
          id: "book-1",
        };
      },
    },
  };

  const result = await createBookAnalysisRun({
    client,
    bookId: "book-1",
    contentVersionId: "cv-1",
    configVersion: "npz-analysis-v1",
    configHash: "cfg-hash",
    extractModel: "gemini-extract",
    chatModel: "gemini-chat",
    embeddingModel: "gemini-embedding",
    pricingVersion: "pricing-v1",
    startedAt: new Date("2026-04-19T10:00:00.000Z"),
  });

  assert.deepEqual(result, {
    id: "run-3",
    attempt: 3,
    contentVersionId: "cv-1",
  });
  assert.equal((observed.create as any)?.data?.attempt, 3);
  assert.deepEqual((observed.bookUpdate as any)?.data, {
    currentAnalysisRunId: "run-3",
    latestAnalysisRunId: "run-3",
  });
});

test("createBookAnalysisArtifactManifest stores manifest fields without requiring inline payload blobs", async () => {
  let created: Record<string, unknown> | null = null;
  const client = {
    bookAnalysisArtifact: {
      async create(input: Record<string, unknown>) {
        created = input;
        return {
          id: "artifact-1",
        };
      },
    },
  };

  await createBookAnalysisArtifactManifest({
    client,
    runId: "run-1",
    bookId: "book-1",
    chapterId: "chapter-1",
    chapterOrderIndex: 4,
    chapterTitle: "Глава 4",
    chunkStartParagraph: 12,
    chunkEndParagraph: 25,
    attempt: 2,
    stageKey: "scene_chunk_llm",
    phase: "chunk_llm",
    status: "ok",
    llmModel: "gemini-3.1-flash-lite-preview",
    promptTokens: 123,
    completionTokens: 45,
    totalTokens: 168,
    elapsedMs: 3200,
    storageProvider: "s3",
    payloadKey: "analysis-runs/book-1/run-1/chapter-4/chunk-12-25/attempt-2.json.gz",
    payloadSizeBytes: 4096,
    payloadSha256: "payload-sha",
    compression: "gzip",
    schemaVersion: "analysis-artifact-payload-v1",
    promptText: null,
    inputJson: null,
    responseText: null,
    parsedJson: null,
  });

  assert.equal((created as any)?.data?.runId, "run-1");
  assert.equal((created as any)?.data?.stageKey, "scene_chunk_llm");
  assert.equal((created as any)?.data?.storageProvider, "s3");
  assert.equal((created as any)?.data?.payloadKey, "analysis-runs/book-1/run-1/chapter-4/chunk-12-25/attempt-2.json.gz");
  assert.equal((created as any)?.data?.payloadSizeBytes, 4096);
  assert.equal((created as any)?.data?.promptText, null);
});

test("chat turn metrics and tool runs are normalized into summary rows", async () => {
  const observed: Record<string, unknown> = {};
  const client = {
    bookChatTurnMetric: {
      async upsert(input: Record<string, unknown>) {
        observed.turnMetric = input;
        return {
          id: "turn-metric-1",
        };
      },
    },
    bookChatToolRun: {
      async deleteMany(input: Record<string, unknown>) {
        observed.deleteMany = input;
        return {
          count: 2,
        };
      },
      async createMany(input: Record<string, unknown>) {
        observed.createMany = input;
        return {
          count: 2,
        };
      },
    },
  };

  const turnMetric = await upsertBookChatTurnMetric({
    client,
    bookId: "book-1",
    threadId: "thread-1",
    messageId: "message-1",
    chatModel: "gemini-3.1-flash-lite-preview",
    embeddingModel: "gemini-embedding-001",
    selectedTools: ["search_paragraphs_hybrid", "search_scenes"],
    toolConfigKey: "search_paragraphs_hybrid+search_scenes",
    promptVariant: "thread-book-chat",
    systemPromptVersion: "tool-aware-v1",
    pricingVersion: "pricing-v1",
    modelInputTokens: 120,
    modelOutputTokens: 45,
    modelTotalTokens: 165,
    embeddingInputTokens: 12,
    chatCostUsd: 0.0021,
    embeddingCostUsd: 0.0002,
    totalCostUsd: 0.0023,
    totalLatencyMs: 18200,
    answerLengthChars: 640,
    citationCount: 6,
    fallbackUsed: false,
    fallbackKind: null,
  });

  await replaceBookChatToolRuns({
    client,
    turnMetricId: turnMetric.id,
    runs: [
      {
        toolName: "search_paragraphs_hybrid",
        orderIndex: 0,
        latencyMs: 11200,
        argsSummaryJson: { query: "кто помог Гарри" },
        resultSummaryJson: { returned: 8 },
      },
      {
        toolName: "search_scenes",
        orderIndex: 1,
        latencyMs: 4300,
        argsSummaryJson: { query: "испытания" },
        resultSummaryJson: { returned: 3 },
        storageProvider: "s3",
        payloadKey: "chat-runs/book-1/thread-1/message-1/search_scenes/tool-run-2.json.gz",
        payloadSizeBytes: 2048,
        payloadSha256: "tool-payload-sha",
        compression: "gzip",
      },
    ],
  });

  assert.equal((observed.turnMetric as any)?.create?.toolConfigKey, "search_paragraphs_hybrid+search_scenes");
  assert.deepEqual((observed.turnMetric as any)?.create?.selectedToolsJson, [
    "search_paragraphs_hybrid",
    "search_scenes",
  ]);
  assert.deepEqual((observed.deleteMany as any)?.where, {
    turnMetricId: "turn-metric-1",
  });
  assert.equal(Array.isArray((observed.createMany as any)?.data), true);
  assert.equal((observed.createMany as any)?.data?.length, 2);
  assert.equal((observed.createMany as any)?.data?.[1]?.payloadKey, "chat-runs/book-1/thread-1/message-1/search_scenes/tool-run-2.json.gz");
});
