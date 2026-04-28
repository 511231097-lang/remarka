-- Extend analyzer types with a dedicated quotes pipeline.
ALTER TYPE "BookAnalyzerType" ADD VALUE IF NOT EXISTS 'quotes';

CREATE TYPE "BookQuoteType" AS ENUM ('dialogue', 'monologue', 'narration', 'description', 'reflection', 'action');

CREATE TYPE "BookQuoteTag" AS ENUM (
  'conflict',
  'relationship',
  'identity',
  'morality',
  'power',
  'freedom',
  'fear',
  'guilt',
  'hope',
  'fate',
  'society',
  'violence',
  'love',
  'death',
  'faith'
);

CREATE TYPE "BookQuoteMentionKind" AS ENUM ('character', 'theme', 'location');

CREATE TABLE "BookQuote" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "chapterOrderIndex" INTEGER NOT NULL,
  "startChar" INTEGER NOT NULL,
  "endChar" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "type" "BookQuoteType" NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "commentary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookQuote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookQuoteTagLink" (
  "quoteId" TEXT NOT NULL,
  "tag" "BookQuoteTag" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookQuoteTagLink_pkey" PRIMARY KEY ("quoteId", "tag")
);

CREATE TABLE "BookQuoteMention" (
  "id" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "kind" "BookQuoteMentionKind" NOT NULL,
  "value" TEXT NOT NULL,
  "normalizedValue" TEXT NOT NULL,
  "startChar" INTEGER NOT NULL,
  "endChar" INTEGER NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookQuoteMention_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BookQuote_bookId_chapter_start_idx"
  ON "BookQuote"("bookId", "chapterOrderIndex", "startChar");
CREATE INDEX "BookQuote_bookId_type_idx"
  ON "BookQuote"("bookId", "type");
CREATE INDEX "BookQuote_bookId_confidence_idx"
  ON "BookQuote"("bookId", "confidence");
CREATE INDEX "BookQuote_text_commentary_fts_idx"
  ON "BookQuote"
  USING GIN (to_tsvector('russian', COALESCE("text", '') || ' ' || COALESCE("commentary", '')));

CREATE INDEX "BookQuoteTagLink_tag_idx"
  ON "BookQuoteTagLink"("tag");

CREATE INDEX "BookQuoteMention_quoteId_idx"
  ON "BookQuoteMention"("quoteId");
CREATE INDEX "BookQuoteMention_kind_normalized_confidence_idx"
  ON "BookQuoteMention"("kind", "normalizedValue", "confidence");

ALTER TABLE "BookQuote"
ADD CONSTRAINT "BookQuote_bookId_fkey"
FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookQuoteTagLink"
ADD CONSTRAINT "BookQuoteTagLink_quoteId_fkey"
FOREIGN KEY ("quoteId") REFERENCES "BookQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookQuoteMention"
ADD CONSTRAINT "BookQuoteMention_quoteId_fkey"
FOREIGN KEY ("quoteId") REFERENCES "BookQuote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
