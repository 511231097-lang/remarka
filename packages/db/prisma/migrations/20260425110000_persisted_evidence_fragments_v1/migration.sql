ALTER TABLE "BookParagraph"
  ADD COLUMN IF NOT EXISTS "chapterOrderIndex" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "paragraphIndex" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "textHash" TEXT NOT NULL DEFAULT '';

ALTER TYPE "BookEvidenceStageKey" ADD VALUE IF NOT EXISTS 'evidence_fragments';

UPDATE "BookParagraph" p
SET
  "chapterOrderIndex" = c."orderIndex",
  "paragraphIndex" = CASE WHEN p."orderInChapter" > 0 THEN p."orderInChapter" ELSE p."paragraphIndex" END,
  "textHash" = CASE WHEN p."textHash" = '' THEN md5(p."text") ELSE p."textHash" END
FROM "BookChapter" c
WHERE c."id" = p."chapterId";

ALTER TABLE "BookParagraphEmbedding"
  ADD COLUMN IF NOT EXISTS "paragraphId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BookParagraph_bookId_chapterId_paragraphIndex_key"
  ON "BookParagraph"("bookId", "chapterId", "paragraphIndex");

CREATE INDEX IF NOT EXISTS "BookParagraph_chapterId_paragraphIndex_idx"
  ON "BookParagraph"("chapterId", "paragraphIndex");

CREATE INDEX IF NOT EXISTS "BookParagraphEmbedding_paragraphId_idx"
  ON "BookParagraphEmbedding"("paragraphId");

UPDATE "BookParagraphEmbedding" e
SET "paragraphId" = p."id"
FROM "BookParagraph" p
WHERE p."bookId" = e."bookId"
  AND p."chapterId" = e."chapterId"
  AND p."paragraphIndex" = e."paragraphIndex"
  AND e."paragraphId" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BookParagraphEmbedding_paragraphId_fkey'
  ) THEN
    ALTER TABLE "BookParagraphEmbedding"
      ADD CONSTRAINT "BookParagraphEmbedding_paragraphId_fkey"
      FOREIGN KEY ("paragraphId") REFERENCES "BookParagraph"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "BookEvidenceFragment" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "primarySceneId" TEXT,
  "sceneIdsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "fragmentType" TEXT NOT NULL,
  "paragraphStart" INTEGER NOT NULL,
  "paragraphEnd" INTEGER NOT NULL,
  "orderIndex" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "textHash" TEXT NOT NULL,
  "embeddingVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookEvidenceFragment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookEvidenceFragment_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookEvidenceFragment_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookEvidenceFragment_primarySceneId_fkey" FOREIGN KEY ("primarySceneId") REFERENCES "BookAnalysisScene"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "BookEvidenceFragmentEmbedding" (
  "id" TEXT NOT NULL,
  "fragmentId" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "fragmentType" TEXT NOT NULL,
  "embeddingModel" TEXT NOT NULL,
  "embeddingVersion" INTEGER NOT NULL DEFAULT 1,
  "taskType" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "sourceText" TEXT NOT NULL,
  "sourceTextHash" TEXT NOT NULL,
  "vector" vector(768),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookEvidenceFragmentEmbedding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookEvidenceFragmentEmbedding_fragmentId_fkey" FOREIGN KEY ("fragmentId") REFERENCES "BookEvidenceFragment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookEvidenceFragmentEmbedding_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookEvidenceFragmentEmbedding_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookEvidenceFragment_bookId_chapterId_fragmentType_paragraphStart_paragraphEnd_embeddingVersion_key"
  ON "BookEvidenceFragment"("bookId", "chapterId", "fragmentType", "paragraphStart", "paragraphEnd", "embeddingVersion");

CREATE INDEX IF NOT EXISTS "BookEvidenceFragment_bookId_idx"
  ON "BookEvidenceFragment"("bookId");

CREATE INDEX IF NOT EXISTS "BookEvidenceFragment_bookId_chapterId_idx"
  ON "BookEvidenceFragment"("bookId", "chapterId");

CREATE INDEX IF NOT EXISTS "BookEvidenceFragment_bookId_fragmentType_idx"
  ON "BookEvidenceFragment"("bookId", "fragmentType");

CREATE INDEX IF NOT EXISTS "BookEvidenceFragment_primarySceneId_idx"
  ON "BookEvidenceFragment"("primarySceneId");

CREATE UNIQUE INDEX IF NOT EXISTS "BookEvidenceFragmentEmbedding_fragmentId_key"
  ON "BookEvidenceFragmentEmbedding"("fragmentId");

CREATE INDEX IF NOT EXISTS "BookEvidenceFragmentEmbedding_bookId_chapterId_idx"
  ON "BookEvidenceFragmentEmbedding"("bookId", "chapterId");

CREATE INDEX IF NOT EXISTS "BookEvidenceFragmentEmbedding_bookId_fragmentType_idx"
  ON "BookEvidenceFragmentEmbedding"("bookId", "fragmentType");

CREATE INDEX IF NOT EXISTS "BookEvidenceFragmentEmbedding_bookId_embeddingVersion_idx"
  ON "BookEvidenceFragmentEmbedding"("bookId", "embeddingVersion");

CREATE INDEX IF NOT EXISTS "BookEvidenceFragmentEmbedding_embeddingModel_idx"
  ON "BookEvidenceFragmentEmbedding"("embeddingModel");

CREATE INDEX IF NOT EXISTS "BookEvidenceFragmentEmbedding_vector_hnsw_idx"
  ON "BookEvidenceFragmentEmbedding"
  USING hnsw ("vector" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "BookEvidenceFragment_text_simple_gin_idx"
  ON "BookEvidenceFragment"
  USING gin (to_tsvector('simple', "text"));

CREATE INDEX IF NOT EXISTS "BookEvidenceFragmentEmbedding_sourceText_simple_gin_idx"
  ON "BookEvidenceFragmentEmbedding"
  USING gin (to_tsvector('simple', "sourceText"));
