CREATE TYPE "BookAnalyzerType" AS ENUM ('summary', 'characters', 'themes', 'locations', 'events');

CREATE TABLE "BookAnalyzerTask" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "analyzerType" "BookAnalyzerType" NOT NULL,
  "state" "BookAnalysisState" NOT NULL DEFAULT 'queued',
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookAnalyzerTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookCharacter" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "arc" TEXT NOT NULL,
  "mentionCount" INTEGER NOT NULL DEFAULT 0,
  "firstAppearanceChapterOrder" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookCharacter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookCharacterQuote" (
  "id" TEXT NOT NULL,
  "bookCharacterId" TEXT NOT NULL,
  "chapterOrderIndex" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "context" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookCharacterQuote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookAnalyzerTask_bookId_analyzerType_key" ON "BookAnalyzerTask"("bookId", "analyzerType");
CREATE INDEX "BookAnalyzerTask_bookId_state_analyzerType_idx" ON "BookAnalyzerTask"("bookId", "state", "analyzerType");

CREATE UNIQUE INDEX "BookCharacter_bookId_normalizedName_key" ON "BookCharacter"("bookId", "normalizedName");
CREATE INDEX "BookCharacter_bookId_mentionCount_desc_firstAppearance_idx" ON "BookCharacter"("bookId", "mentionCount" DESC, "firstAppearanceChapterOrder" ASC, "name" ASC);

CREATE INDEX "BookCharacterQuote_bookCharacterId_chapterOrderIndex_idx" ON "BookCharacterQuote"("bookCharacterId", "chapterOrderIndex");

ALTER TABLE "BookAnalyzerTask"
ADD CONSTRAINT "BookAnalyzerTask_bookId_fkey"
FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookCharacter"
ADD CONSTRAINT "BookCharacter_bookId_fkey"
FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookCharacterQuote"
ADD CONSTRAINT "BookCharacterQuote_bookCharacterId_fkey"
FOREIGN KEY ("bookCharacterId") REFERENCES "BookCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill summary analyzer task from existing Book analysis fields.
INSERT INTO "BookAnalyzerTask" (
  "id",
  "bookId",
  "analyzerType",
  "state",
  "error",
  "startedAt",
  "completedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  ('batsk_' || substr(md5("id" || ':summary'), 1, 24)),
  "id",
  'summary'::"BookAnalyzerType",
  "analysisState",
  "analysisError",
  "analysisStartedAt",
  "analysisCompletedAt",
  "createdAt",
  "updatedAt"
FROM "Book"
ON CONFLICT ("bookId", "analyzerType") DO NOTHING;
