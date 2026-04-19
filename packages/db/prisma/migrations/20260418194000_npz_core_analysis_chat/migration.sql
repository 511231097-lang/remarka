-- NPZ core migration: analysis + chat runtime tables and book analysis fields.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnalysisStatus') THEN
    CREATE TYPE "AnalysisStatus" AS ENUM ('not_started', 'queued', 'running', 'completed', 'failed');
  ELSE
    ALTER TYPE "AnalysisStatus" ADD VALUE IF NOT EXISTS 'not_started';
    ALTER TYPE "AnalysisStatus" ADD VALUE IF NOT EXISTS 'queued';
    ALTER TYPE "AnalysisStatus" ADD VALUE IF NOT EXISTS 'running';
    ALTER TYPE "AnalysisStatus" ADD VALUE IF NOT EXISTS 'completed';
    ALTER TYPE "AnalysisStatus" ADD VALUE IF NOT EXISTS 'failed';
  END IF;
END $$;

ALTER TABLE "Book"
  ADD COLUMN IF NOT EXISTS "analysisStatus" "AnalysisStatus" NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS "analysisTotalBlocks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "analysisCheckedBlocks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "analysisPromptTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "analysisCompletionTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "analysisTotalTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "analysisChapterStatsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "analysisRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "analysisFinishedAt" TIMESTAMP(3);

UPDATE "Book"
SET "analysisStatus" = CASE
  WHEN "analysisState" = 'running' THEN 'running'::"AnalysisStatus"
  WHEN "analysisState" = 'completed' THEN 'completed'::"AnalysisStatus"
  WHEN "analysisState" = 'failed' THEN 'failed'::"AnalysisStatus"
  ELSE 'queued'::"AnalysisStatus"
END
WHERE "analysisStatus"::text = 'not_started';

UPDATE "Book"
SET "analysisFinishedAt" = COALESCE("analysisFinishedAt", "analysisCompletedAt")
WHERE "analysisCompletedAt" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BookChatThreadMessageRole') THEN
    CREATE TYPE "BookChatThreadMessageRole" AS ENUM ('user', 'assistant');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "BookAnalysisArtifact" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "chapterOrderIndex" INTEGER NOT NULL,
  "chapterTitle" TEXT NOT NULL,
  "chunkStartParagraph" INTEGER NOT NULL,
  "chunkEndParagraph" INTEGER NOT NULL,
  "attempt" INTEGER NOT NULL,
  "phase" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "llmModel" TEXT NOT NULL,
  "promptTokens" INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "elapsedMs" INTEGER NOT NULL DEFAULT 0,
  "promptText" TEXT NOT NULL,
  "inputJson" JSONB NOT NULL DEFAULT '{}',
  "responseText" TEXT,
  "parsedJson" JSONB,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookAnalysisArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookAnalysisArtifact_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookAnalysisArtifact_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "BookAnalysisScene" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "sceneIndex" INTEGER NOT NULL,
  "paragraphStart" INTEGER NOT NULL,
  "paragraphEnd" INTEGER NOT NULL,
  "locationLabel" TEXT,
  "timeLabel" TEXT,
  "participantsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "sceneSummary" TEXT NOT NULL,
  "sceneCard" TEXT NOT NULL,
  "mentionedEntitiesJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "locationHintsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "timeHintsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "eventLabelsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "unresolvedFormsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "factsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "evidenceSpansJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "changeSignal" TEXT NOT NULL,
  "excerptText" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookAnalysisScene_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookAnalysisScene_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookAnalysisScene_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "BookSceneEmbedding" (
  "id" TEXT NOT NULL,
  "sceneId" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "sceneIndex" INTEGER NOT NULL,
  "embeddingModel" TEXT NOT NULL,
  "embeddingVersion" INTEGER NOT NULL DEFAULT 1,
  "taskType" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "sourceText" TEXT NOT NULL,
  "sourceTextHash" TEXT NOT NULL,
  "vectorJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookSceneEmbedding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookSceneEmbedding_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "BookAnalysisScene"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookSceneEmbedding_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookSceneEmbedding_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "BookParagraphEmbedding" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "paragraphIndex" INTEGER NOT NULL,
  "embeddingModel" TEXT NOT NULL,
  "embeddingVersion" INTEGER NOT NULL DEFAULT 1,
  "taskType" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "sourceText" TEXT NOT NULL,
  "sourceTextHash" TEXT NOT NULL,
  "vectorJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookParagraphEmbedding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookParagraphEmbedding_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookParagraphEmbedding_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "BookChatThread" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookChatThread_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookChatThread_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "BookChatThreadMessage" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "role" "BookChatThreadMessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "citationsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "toolRunsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "metricsJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookChatThreadMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookChatThreadMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "BookChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookAnalysisScene_bookId_chapterId_sceneIndex_key"
  ON "BookAnalysisScene"("bookId", "chapterId", "sceneIndex");
CREATE INDEX IF NOT EXISTS "BookAnalysisScene_bookId_chapterId_idx"
  ON "BookAnalysisScene"("bookId", "chapterId");
CREATE INDEX IF NOT EXISTS "BookAnalysisScene_bookId_sceneIndex_idx"
  ON "BookAnalysisScene"("bookId", "sceneIndex");

CREATE INDEX IF NOT EXISTS "BookAnalysisArtifact_bookId_createdAt_idx"
  ON "BookAnalysisArtifact"("bookId", "createdAt");
CREATE INDEX IF NOT EXISTS "BookAnalysisArtifact_bookId_chapterId_createdAt_idx"
  ON "BookAnalysisArtifact"("bookId", "chapterId", "createdAt");
CREATE INDEX IF NOT EXISTS "BookAnalysisArtifact_bookId_chapterId_chunkStartParagraph_chunkEnd_idx"
  ON "BookAnalysisArtifact"("bookId", "chapterId", "chunkStartParagraph", "chunkEndParagraph", "attempt");

CREATE UNIQUE INDEX IF NOT EXISTS "BookSceneEmbedding_sceneId_key"
  ON "BookSceneEmbedding"("sceneId");
CREATE INDEX IF NOT EXISTS "BookSceneEmbedding_bookId_chapterId_sceneIndex_idx"
  ON "BookSceneEmbedding"("bookId", "chapterId", "sceneIndex");
CREATE INDEX IF NOT EXISTS "BookSceneEmbedding_bookId_embeddingVersion_idx"
  ON "BookSceneEmbedding"("bookId", "embeddingVersion");
CREATE INDEX IF NOT EXISTS "BookSceneEmbedding_embeddingModel_idx"
  ON "BookSceneEmbedding"("embeddingModel");

CREATE UNIQUE INDEX IF NOT EXISTS "BookParagraphEmbedding_bookId_chapterId_paragraphIndex_embeddin_key"
  ON "BookParagraphEmbedding"("bookId", "chapterId", "paragraphIndex", "embeddingVersion");
CREATE INDEX IF NOT EXISTS "BookParagraphEmbedding_bookId_chapterId_paragraphIndex_idx"
  ON "BookParagraphEmbedding"("bookId", "chapterId", "paragraphIndex");
CREATE INDEX IF NOT EXISTS "BookParagraphEmbedding_bookId_embeddingVersion_idx"
  ON "BookParagraphEmbedding"("bookId", "embeddingVersion");
CREATE INDEX IF NOT EXISTS "BookParagraphEmbedding_embeddingModel_idx"
  ON "BookParagraphEmbedding"("embeddingModel");

CREATE INDEX IF NOT EXISTS "BookChatThread_bookId_updatedAt_idx"
  ON "BookChatThread"("bookId", "updatedAt");
CREATE INDEX IF NOT EXISTS "BookChatThread_createdAt_idx"
  ON "BookChatThread"("createdAt");
CREATE INDEX IF NOT EXISTS "BookChatThreadMessage_threadId_createdAt_idx"
  ON "BookChatThreadMessage"("threadId", "createdAt");
CREATE INDEX IF NOT EXISTS "BookChatThreadMessage_role_createdAt_idx"
  ON "BookChatThreadMessage"("role", "createdAt");
