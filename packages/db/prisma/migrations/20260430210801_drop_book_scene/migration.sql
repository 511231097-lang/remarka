-- Drop BookScene — pure dead carry-over from the v1 graph. The active
-- scene model is BookAnalysisScene; runtime calls to prisma.bookScene.*
-- were silently aliased there via npzPrismaAdapter, but every callsite
-- is now renamed to bookAnalysisScene directly and the adapter alias is
-- gone, so BookScene has no readers, no writers, and no rows.
--
-- Verified before this migration:
--   SELECT count(*) FROM "BookScene" → 0
--   SELECT count(*) FROM "BookParagraph" WHERE "sceneId" IS NOT NULL → 0
--   SELECT count(*) FROM "BookSentence" WHERE "sceneId" IS NOT NULL → 0
--   SELECT count(*) FROM "BookSummaryArtifact" WHERE "sceneId" IS NOT NULL → 0
-- (No prod data either — this migration runs on a dev DB only at the
--  moment, but is safe-by-construction even when prod ships.)

-- Drop the orphan sceneId FK columns on the surviving tables. CASCADE
-- handles the FK constraint + the per-table @@index on sceneId.
ALTER TABLE "BookParagraph" DROP COLUMN IF EXISTS "sceneId";
ALTER TABLE "BookSentence" DROP COLUMN IF EXISTS "sceneId";
ALTER TABLE "BookSummaryArtifact" DROP COLUMN IF EXISTS "sceneId";

-- Drop the table itself. CASCADE removes the FK reverse-side that the
-- column drops above might have left dangling.
DROP TABLE IF EXISTS "BookScene" CASCADE;
