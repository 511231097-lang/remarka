-- Reset derived extraction data (no backward compatibility)
DELETE FROM "Mention";
DELETE FROM "Annotation";
DELETE FROM "Entity";
DELETE FROM "AnalysisModelCall";
DELETE FROM "AnalysisJob";

-- Switch EntityType enum to single flat location type
CREATE TYPE "EntityType_new" AS ENUM (
  'character',
  'location',
  'event',
  'time_marker'
);

ALTER TABLE "Entity"
ALTER COLUMN "type" TYPE "EntityType_new"
USING (
  CASE
    WHEN "type"::text IN ('location_small', 'location_city', 'location_region') THEN 'location'
    ELSE "type"::text
  END
::"EntityType_new"
);

ALTER TABLE "Annotation"
ALTER COLUMN "type" TYPE "EntityType_new"
USING (
  CASE
    WHEN "type"::text IN ('location_small', 'location_city', 'location_region') THEN 'location'
    ELSE "type"::text
  END
::"EntityType_new"
);

DROP TYPE "EntityType";
ALTER TYPE "EntityType_new" RENAME TO "EntityType";

-- Remove hierarchical parent column/constraint from Entity
ALTER TABLE "Entity" DROP CONSTRAINT IF EXISTS "Entity_parentEntityId_fkey";
DROP INDEX IF EXISTS "Entity_parentEntityId_idx";
ALTER TABLE "Entity" DROP COLUMN IF EXISTS "parentEntityId";

-- Remove strict uniqueness to allow same-name locations in different containers
DROP INDEX IF EXISTS "Entity_projectId_type_normalizedName_key";

-- Create flat containment links (single parent per location)
CREATE TABLE IF NOT EXISTS "LocationContainment" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "childEntityId" TEXT NOT NULL,
  "parentEntityId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LocationContainment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LocationContainment_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LocationContainment_childEntityId_fkey"
    FOREIGN KEY ("childEntityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LocationContainment_parentEntityId_fkey"
    FOREIGN KEY ("parentEntityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LocationContainment_child_parent_not_equal"
    CHECK ("childEntityId" <> "parentEntityId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LocationContainment_childEntityId_key"
  ON "LocationContainment"("childEntityId");

CREATE UNIQUE INDEX IF NOT EXISTS "LocationContainment_childEntityId_parentEntityId_key"
  ON "LocationContainment"("childEntityId", "parentEntityId");

CREATE INDEX IF NOT EXISTS "LocationContainment_projectId_parentEntityId_idx"
  ON "LocationContainment"("projectId", "parentEntityId");

-- Re-queue analysis for all non-empty documents
UPDATE "Document"
SET
  "analysisStatus" = CASE
    WHEN btrim("content") = '' THEN 'idle'::"AnalysisStatus"
    ELSE 'queued'::"AnalysisStatus"
  END,
  "lastAnalyzedVersion" = NULL,
  "lastAnalyzedContent" = NULL,
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
