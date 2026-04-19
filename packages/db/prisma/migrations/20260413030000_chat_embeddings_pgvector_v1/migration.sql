DO $$
BEGIN
  -- Optional on local dev environments where pgvector is not installed.
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN undefined_file THEN
    NULL;
END $$;

ALTER TYPE "BookAnalyzerType" ADD VALUE IF NOT EXISTS 'chat_index';

ALTER TABLE "BookChapter"
ADD COLUMN IF NOT EXISTS "rawText" TEXT;

CREATE TABLE "BookChunk" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "chapterOrderIndex" INTEGER NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "startChar" INTEGER NOT NULL,
  "endChar" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "embedding" JSONB NOT NULL,
  "embeddingModel" TEXT NOT NULL,
  "metadataJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookChatSession" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "lastMessageAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookChatSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookChatMessage" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "citationsJson" JSONB,
  "promptTokens" INTEGER,
  "completionTokens" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookChunk_bookId_chapterOrderIndex_chunkIndex_key"
ON "BookChunk"("bookId", "chapterOrderIndex", "chunkIndex");

CREATE INDEX "BookChunk_bookId_chapter_chunk_idx"
ON "BookChunk"("bookId", "chapterOrderIndex", "chunkIndex");

-- HNSW index is skipped on local dev environments without pgvector.

CREATE INDEX "BookChatSession_book_user_lastMessage_idx"
ON "BookChatSession"("bookId", "userId", "lastMessageAt");

CREATE INDEX "BookChatSession_user_createdAt_idx"
ON "BookChatSession"("userId", "createdAt");

CREATE INDEX "BookChatMessage_session_createdAt_idx"
ON "BookChatMessage"("sessionId", "createdAt");

ALTER TABLE "BookChunk"
ADD CONSTRAINT "BookChunk_bookId_fkey"
FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookChatSession"
ADD CONSTRAINT "BookChatSession_bookId_fkey"
FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookChatSession"
ADD CONSTRAINT "BookChatSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookChatMessage"
ADD CONSTRAINT "BookChatMessage_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "BookChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
