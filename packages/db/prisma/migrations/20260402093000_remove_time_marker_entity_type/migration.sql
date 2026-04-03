-- Drop legacy time_marker data before enum narrowing.
DELETE FROM "Annotation"
WHERE "type" = 'time_marker';

DELETE FROM "Entity"
WHERE "type" = 'time_marker';

-- Recreate EntityType enum without time_marker.
CREATE TYPE "EntityType_new" AS ENUM (
  'character',
  'location',
  'event'
);

ALTER TABLE "Entity"
ALTER COLUMN "type" TYPE "EntityType_new"
USING ("type"::text::"EntityType_new");

ALTER TABLE "Annotation"
ALTER COLUMN "type" TYPE "EntityType_new"
USING ("type"::text::"EntityType_new");

DROP TYPE "EntityType";
ALTER TYPE "EntityType_new" RENAME TO "EntityType";
