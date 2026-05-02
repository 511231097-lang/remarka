-- Token + cost metering pass: closes the unit-economy gaps where the
-- analysis pipeline was losing cached/thoughts breakdowns and the reranker
-- had no metering at all.
--
-- 1. Book aggregate columns mirror the run-level rollup so unit-economy
--    queries can read straight off Book without joining BookAnalysisRun.
-- 2. BookAnalysisRun + BookStageExecution + BookAnalysisChapterMetric
--    each get cached/thoughts (+ chapter cost) so we can finally see the
--    Vertex 90% cache discount benefit and the thinking-model billing.
-- 3. BookChatTurnMetric gets aggregate rerank columns; granular per-call
--    rows go to the new BookRerankCall table.

-- Book aggregate
ALTER TABLE "Book"
  ADD COLUMN "analysisCachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "analysisThoughtsTokens"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "analysisChatCostUsd"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "analysisEmbeddingCostUsd"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "analysisTotalCostUsd"      DOUBLE PRECISION NOT NULL DEFAULT 0;

-- BookAnalysisRun
ALTER TABLE "BookAnalysisRun"
  ADD COLUMN "llmCachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "llmThoughtsTokens"    INTEGER NOT NULL DEFAULT 0;

-- BookStageExecution
ALTER TABLE "BookStageExecution"
  ADD COLUMN "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "thoughtsTokens"    INTEGER NOT NULL DEFAULT 0;

-- BookAnalysisChapterMetric — also gains the cost columns it was missing
ALTER TABLE "BookAnalysisChapterMetric"
  ADD COLUMN "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "thoughtsTokens"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "llmCostUsd"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "embeddingCostUsd"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "totalCostUsd"      DOUBLE PRECISION NOT NULL DEFAULT 0;

-- BookChatTurnMetric — rerank aggregate
ALTER TABLE "BookChatTurnMetric"
  ADD COLUMN "rerankCallCount"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rerankRecordCount"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rerankReturnedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rerankLatencyMs"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rerankCostUsd"       DOUBLE PRECISION NOT NULL DEFAULT 0;

-- BookRerankCall — granular per-call audit trail. nullable bookId/threadId
-- so admin global searches (no chat thread) can still produce a row.
CREATE TABLE "BookRerankCall" (
  "id"             TEXT NOT NULL,
  "source"         TEXT NOT NULL,
  "bookId"         TEXT,
  "threadId"       TEXT,
  "turnMetricId"   TEXT,
  "model"          TEXT NOT NULL,
  "recordCount"    INTEGER NOT NULL DEFAULT 0,
  "returnedCount"  INTEGER NOT NULL DEFAULT 0,
  "latencyMs"      INTEGER NOT NULL DEFAULT 0,
  "costUsd"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pricingVersion" TEXT,
  "errorCode"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookRerankCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BookRerankCall_bookId_createdAt_idx"     ON "BookRerankCall"("bookId", "createdAt");
CREATE INDEX "BookRerankCall_threadId_createdAt_idx"   ON "BookRerankCall"("threadId", "createdAt");
CREATE INDEX "BookRerankCall_turnMetricId_idx"         ON "BookRerankCall"("turnMetricId");
CREATE INDEX "BookRerankCall_source_createdAt_idx"     ON "BookRerankCall"("source", "createdAt");

ALTER TABLE "BookRerankCall"
  ADD CONSTRAINT "BookRerankCall_bookId_fkey"
  FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookRerankCall"
  ADD CONSTRAINT "BookRerankCall_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "BookChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookRerankCall"
  ADD CONSTRAINT "BookRerankCall_turnMetricId_fkey"
  FOREIGN KEY ("turnMetricId") REFERENCES "BookChatTurnMetric"("id") ON DELETE CASCADE ON UPDATE CASCADE;
