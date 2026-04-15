ALTER TYPE "BookAnalyzerType" ADD VALUE IF NOT EXISTS 'core_resolve';

DO $$
BEGIN
  CREATE TYPE "BookRefResolutionStatus" AS ENUM ('resolved', 'unresolved');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "BookQuoteMention"
  ADD COLUMN "resolutionStatus" "BookRefResolutionStatus" NOT NULL DEFAULT 'unresolved';

ALTER TABLE "BookEntityMembership"
  DROP CONSTRAINT IF EXISTS "BookEntityMembership_memberEntityId_fkey";

DROP INDEX IF EXISTS "BookEntityMembership_bookId_collectionEntityId_memberEntityId_role_key";

ALTER TABLE "BookEntityMembership"
  ADD COLUMN "memberValue" TEXT,
  ADD COLUMN "memberNormalizedValue" TEXT,
  ADD COLUMN "resolutionStatus" "BookRefResolutionStatus" NOT NULL DEFAULT 'unresolved';

UPDATE "BookEntityMembership" membership
SET
  "memberValue" = entity."canonicalName",
  "memberNormalizedValue" = entity."normalizedName"
FROM "BookEntity" entity
WHERE membership."memberEntityId" = entity."id";

ALTER TABLE "BookEntityMembership"
  ALTER COLUMN "memberValue" SET NOT NULL,
  ALTER COLUMN "memberNormalizedValue" SET NOT NULL,
  ALTER COLUMN "memberEntityId" DROP NOT NULL;

ALTER TABLE "BookEntityMembership"
  ADD CONSTRAINT "BookEntityMembership_memberEntityId_fkey"
  FOREIGN KEY ("memberEntityId") REFERENCES "BookEntity"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "BookEntityMembership_bookId_collectionEntityId_memberNormalizedValue_role_key"
  ON "BookEntityMembership"("bookId", "collectionEntityId", "memberNormalizedValue", "role");

CREATE INDEX "BookEntityMembership_bookId_memberNormalizedValue_idx"
  ON "BookEntityMembership"("bookId", "memberNormalizedValue");
