UPDATE "User"
SET "defaultBookVisibilityPublic" = false;

ALTER TABLE "User"
ALTER COLUMN "defaultBookVisibilityPublic" SET DEFAULT false;
