CREATE TYPE "BookAnalysisState" AS ENUM ('queued', 'running', 'completed', 'failed');

ALTER TABLE "Book"
ADD COLUMN "summary" TEXT,
ADD COLUMN "analysisState" "BookAnalysisState" NOT NULL DEFAULT 'queued',
ADD COLUMN "analysisError" TEXT,
ADD COLUMN "analysisStartedAt" TIMESTAMP(3),
ADD COLUMN "analysisCompletedAt" TIMESTAMP(3);

ALTER TABLE "BookChapter"
DROP COLUMN "previewText",
ADD COLUMN "summary" TEXT;

-- Existing books were created before this analyzer existed.
-- Mark them completed to avoid a perpetual "queued" state.
UPDATE "Book"
SET "analysisState" = 'completed'
WHERE "analysisState" = 'queued';
