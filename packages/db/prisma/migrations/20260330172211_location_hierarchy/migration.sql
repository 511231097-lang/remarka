-- Reset derived extraction data (no backward compatibility)
DELETE FROM "Mention";
DELETE FROM "Annotation";
DELETE FROM "Entity";
DELETE FROM "AnalysisJob";

-- Switch EntityType enum from flat location to hierarchical location types
CREATE TYPE "EntityType_new" AS ENUM (
  'character',
  'location_small',
  'location_city',
  'location_region',
  'event',
  'time_marker'
);

ALTER TABLE "Entity"
ALTER COLUMN "type" TYPE "EntityType_new"
USING ("type"::text::"EntityType_new");

ALTER TABLE "Annotation"
ALTER COLUMN "type" TYPE "EntityType_new"
USING ("type"::text::"EntityType_new");

DROP TYPE "EntityType";
ALTER TYPE "EntityType_new" RENAME TO "EntityType";

-- Add location hierarchy relation
ALTER TABLE "Entity"
ADD COLUMN "parentEntityId" TEXT;

ALTER TABLE "Entity"
ADD CONSTRAINT "Entity_parentEntityId_fkey"
FOREIGN KEY ("parentEntityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Entity_parentEntityId_idx" ON "Entity"("parentEntityId");

-- Re-queue analysis for all non-empty documents
UPDATE "Document"
SET
  "analysisStatus" = CASE
    WHEN btrim("content") = '' THEN 'idle'::"AnalysisStatus"
    ELSE 'queued'::"AnalysisStatus"
  END,
  "lastAnalyzedVersion" = NULL,
  "updatedAt" = NOW();

INSERT INTO "AnalysisJob" (
  "id",
  "projectId",
  "documentId",
  "contentVersion",
  "status",
  "createdAt",
  "updatedAt"
)
SELECT
  'requeue-' || md5(d."id" || ':' || clock_timestamp()::text || ':' || random()::text),
  d."projectId",
  d."id",
  d."contentVersion",
  'queued'::"AnalysisJobStatus",
  NOW(),
  NOW()
FROM "Document" d
WHERE btrim(d."content") <> '';
