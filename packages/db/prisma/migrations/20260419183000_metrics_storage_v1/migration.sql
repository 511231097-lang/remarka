ALTER TYPE "BookEvidenceStageKey" ADD VALUE IF NOT EXISTS 'paragraph_embeddings';
ALTER TYPE "BookEvidenceStageKey" ADD VALUE IF NOT EXISTS 'scene_chunk_llm';
ALTER TYPE "BookEvidenceStageKey" ADD VALUE IF NOT EXISTS 'scene_embeddings';
ALTER TYPE "BookEvidenceStageKey" ADD VALUE IF NOT EXISTS 'finalize';

ALTER TABLE "Book"
  ADD COLUMN IF NOT EXISTS "currentAnalysisRunId" TEXT,
  ADD COLUMN IF NOT EXISTS "latestAnalysisRunId" TEXT;

CREATE INDEX IF NOT EXISTS "Book_latestAnalysisRunId_createdAt_idx"
  ON "Book"("latestAnalysisRunId", "createdAt");

DROP INDEX IF EXISTS "BookAnalysisRun_contentVersionId_key";

ALTER TABLE "BookAnalysisRun"
  ADD COLUMN IF NOT EXISTS "attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "configVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "configHash" TEXT,
  ADD COLUMN IF NOT EXISTS "extractModel" TEXT,
  ADD COLUMN IF NOT EXISTS "chatModel" TEXT,
  ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT,
  ADD COLUMN IF NOT EXISTS "pricingVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "llmPromptTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "llmCompletionTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "llmTotalTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "embeddingInputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "embeddingTotalTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "llmCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "embeddingCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalElapsedMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "llmLatencyMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "embeddingLatencyMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "chunkCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "chunkFailedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "llmCalls" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "llmRetries" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "embeddingCalls" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "paragraphEmbeddingCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sceneCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "artifactCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "storageBytesJson" JSONB;

CREATE INDEX IF NOT EXISTS "BookAnalysisRun_bookId_attempt_createdAt_idx"
  ON "BookAnalysisRun"("bookId", "attempt", "createdAt");

ALTER TABLE "BookStageExecution"
  ADD COLUMN IF NOT EXISTS "promptTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "completionTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "embeddingInputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "embeddingTotalTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "llmCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "embeddingCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "elapsedMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "llmCalls" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "embeddingCalls" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "chunkCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "chunkFailedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "outputRowCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "storageBytesJson" JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'BookStageExecution_runId_fkey'
  ) THEN
    ALTER TABLE "BookStageExecution"
      ADD CONSTRAINT "BookStageExecution_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "BookAnalysisRun"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "BookAnalysisChapterMetric" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "contentVersionId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "chapterOrderIndex" INTEGER NOT NULL,
  "chapterTitle" TEXT NOT NULL,
  "stageKey" "BookEvidenceStageKey" NOT NULL,
  "state" "BookAnalysisState" NOT NULL DEFAULT 'queued',
  "error" TEXT,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "embeddingInputTokens" INTEGER NOT NULL DEFAULT 0,
  "embeddingTotalTokens" INTEGER NOT NULL DEFAULT 0,
  "elapsedMs" INTEGER NOT NULL DEFAULT 0,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "llmCalls" INTEGER NOT NULL DEFAULT 0,
  "embeddingCalls" INTEGER NOT NULL DEFAULT 0,
  "chunkCount" INTEGER NOT NULL DEFAULT 0,
  "chunkFailedCount" INTEGER NOT NULL DEFAULT 0,
  "outputRowCount" INTEGER NOT NULL DEFAULT 0,
  "storageBytesJson" JSONB,
  "metadataJson" JSONB,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookAnalysisChapterMetric_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookAnalysisChapterMetric_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookAnalysisChapterMetric_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BookAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookAnalysisChapterMetric_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookAnalysisChapterMetric_runId_chapterId_stageKey_key"
  ON "BookAnalysisChapterMetric"("runId", "chapterId", "stageKey");
CREATE INDEX IF NOT EXISTS "BookAnalysisChapterMetric_bookId_contentVersionId_chapterOr_idx"
  ON "BookAnalysisChapterMetric"("bookId", "contentVersionId", "chapterOrderIndex", "stageKey");
CREATE INDEX IF NOT EXISTS "BookAnalysisChapterMetric_runId_stageKey_chapterOrderIndex_idx"
  ON "BookAnalysisChapterMetric"("runId", "stageKey", "chapterOrderIndex");

ALTER TABLE "BookAnalysisArtifact"
  ADD COLUMN IF NOT EXISTS "runId" TEXT,
  ADD COLUMN IF NOT EXISTS "stageKey" "BookEvidenceStageKey",
  ADD COLUMN IF NOT EXISTS "storageProvider" TEXT,
  ADD COLUMN IF NOT EXISTS "payloadKey" TEXT,
  ADD COLUMN IF NOT EXISTS "payloadSizeBytes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "payloadSha256" TEXT,
  ADD COLUMN IF NOT EXISTS "compression" TEXT,
  ADD COLUMN IF NOT EXISTS "schemaVersion" TEXT;

ALTER TABLE "BookAnalysisArtifact" ALTER COLUMN "promptText" DROP NOT NULL;
ALTER TABLE "BookAnalysisArtifact" ALTER COLUMN "inputJson" DROP NOT NULL;
ALTER TABLE "BookAnalysisArtifact" ALTER COLUMN "inputJson" DROP DEFAULT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'BookAnalysisArtifact_runId_fkey'
  ) THEN
    ALTER TABLE "BookAnalysisArtifact"
      ADD CONSTRAINT "BookAnalysisArtifact_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "BookAnalysisRun"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "BookAnalysisArtifact_runId_createdAt_idx"
  ON "BookAnalysisArtifact"("runId", "createdAt");

DROP INDEX IF EXISTS "BookProcessingReport_contentVersionId_key";
CREATE INDEX IF NOT EXISTS "BookProcessingReport_bookId_contentVersionId_createdAt_idx"
  ON "BookProcessingReport"("bookId", "contentVersionId", "createdAt");
CREATE INDEX IF NOT EXISTS "BookProcessingReport_runId_idx"
  ON "BookProcessingReport"("runId");

CREATE TABLE IF NOT EXISTS "BookChatTurnMetric" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "chatModel" TEXT NOT NULL,
  "embeddingModel" TEXT NOT NULL,
  "selectedToolsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "toolConfigKey" TEXT NOT NULL,
  "promptVariant" TEXT NOT NULL,
  "systemPromptVersion" TEXT NOT NULL,
  "pricingVersion" TEXT NOT NULL,
  "modelInputTokens" INTEGER NOT NULL DEFAULT 0,
  "modelOutputTokens" INTEGER NOT NULL DEFAULT 0,
  "modelTotalTokens" INTEGER NOT NULL DEFAULT 0,
  "embeddingInputTokens" INTEGER NOT NULL DEFAULT 0,
  "chatCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "embeddingCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalLatencyMs" INTEGER NOT NULL DEFAULT 0,
  "answerLengthChars" INTEGER NOT NULL DEFAULT 0,
  "citationCount" INTEGER NOT NULL DEFAULT 0,
  "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
  "fallbackKind" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookChatTurnMetric_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookChatTurnMetric_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookChatTurnMetric_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "BookChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookChatTurnMetric_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "BookChatThreadMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookChatTurnMetric_messageId_key"
  ON "BookChatTurnMetric"("messageId");
CREATE INDEX IF NOT EXISTS "BookChatTurnMetric_bookId_createdAt_idx"
  ON "BookChatTurnMetric"("bookId", "createdAt");
CREATE INDEX IF NOT EXISTS "BookChatTurnMetric_threadId_createdAt_idx"
  ON "BookChatTurnMetric"("threadId", "createdAt");

CREATE TABLE IF NOT EXISTS "BookChatToolRun" (
  "id" TEXT NOT NULL,
  "turnMetricId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "orderIndex" INTEGER NOT NULL,
  "latencyMs" INTEGER NOT NULL DEFAULT 0,
  "argsSummaryJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "resultSummaryJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "storageProvider" TEXT,
  "payloadKey" TEXT,
  "payloadSizeBytes" INTEGER NOT NULL DEFAULT 0,
  "payloadSha256" TEXT,
  "compression" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookChatToolRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookChatToolRun_turnMetricId_fkey" FOREIGN KEY ("turnMetricId") REFERENCES "BookChatTurnMetric"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookChatToolRun_turnMetricId_orderIndex_key"
  ON "BookChatToolRun"("turnMetricId", "orderIndex");
CREATE INDEX IF NOT EXISTS "BookChatToolRun_toolName_createdAt_idx"
  ON "BookChatToolRun"("toolName", "createdAt");
CREATE INDEX IF NOT EXISTS "BookChatToolRun_turnMetricId_createdAt_idx"
  ON "BookChatToolRun"("turnMetricId", "createdAt");
