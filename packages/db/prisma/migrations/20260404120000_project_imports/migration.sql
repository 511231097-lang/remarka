CREATE TYPE "BookFormat" AS ENUM ('fb2', 'fb2_zip');
CREATE TYPE "ProjectImportState" AS ENUM ('queued', 'running', 'completed', 'failed');
CREATE TYPE "ProjectImportStage" AS ENUM ('queued', 'loading_source', 'parsing', 'persisting', 'scheduling_analysis', 'completed', 'failed');

CREATE TABLE "SourceAsset" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SourceAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectImport" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sourceAssetId" TEXT NOT NULL,
  "format" "BookFormat" NOT NULL,
  "state" "ProjectImportState" NOT NULL DEFAULT 'queued',
  "stage" "ProjectImportStage" NOT NULL DEFAULT 'queued',
  "error" TEXT,
  "chapterCount" INTEGER,
  "metadataJson" JSONB,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectImport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectImport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectImport_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "SourceAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "SourceAsset_provider_storageKey_idx" ON "SourceAsset"("provider", "storageKey");
CREATE INDEX "ProjectImport_projectId_createdAt_idx" ON "ProjectImport"("projectId", "createdAt");
CREATE INDEX "ProjectImport_state_createdAt_idx" ON "ProjectImport"("state", "createdAt");
