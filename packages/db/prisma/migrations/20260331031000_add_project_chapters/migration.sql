-- CreateTable
CREATE TABLE "Chapter" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chapter_pkey" PRIMARY KEY ("id")
);

-- Add nullable chapterId first to allow data backfill
ALTER TABLE "Document" ADD COLUMN "chapterId" TEXT;

-- Backfill first chapter for every project
INSERT INTO "Chapter" ("id", "projectId", "title", "orderIndex", "createdAt", "updatedAt")
SELECT
  ('chapter_' || p."id") AS "id",
  p."id" AS "projectId",
  'Новая глава' AS "title",
  0 AS "orderIndex",
  p."createdAt" AS "createdAt",
  p."updatedAt" AS "updatedAt"
FROM "Project" p;

-- Attach existing documents to the generated first chapter
UPDATE "Document"
SET "chapterId" = ('chapter_' || "projectId")
WHERE "chapterId" IS NULL;

-- Enforce new constraints
ALTER TABLE "Document" ALTER COLUMN "chapterId" SET NOT NULL;

-- Remove one-document-per-project restriction
DROP INDEX "Document_projectId_key";

-- CreateIndex
CREATE INDEX "Chapter_projectId_orderIndex_idx" ON "Chapter"("projectId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Document_chapterId_key" ON "Document"("chapterId");

-- CreateIndex
CREATE INDEX "Document_chapterId_idx" ON "Document"("chapterId");

-- AddForeignKey
ALTER TABLE "Chapter" ADD CONSTRAINT "Chapter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
