-- Hybrid extraction v2 (destructive cutover, no backward compatibility)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP TABLE IF EXISTS "AnalysisJobStageMetric" CASCADE;
DROP TABLE IF EXISTS "AnalysisModelCall" CASCADE;
DROP TABLE IF EXISTS "AnalysisJob" CASCADE;
DROP TABLE IF EXISTS "Annotation" CASCADE;
DROP TABLE IF EXISTS "PatchDecision" CASCADE;
DROP TABLE IF EXISTS "MentionCandidate" CASCADE;
DROP TABLE IF EXISTS "Mention" CASCADE;
DROP TABLE IF EXISTS "EntityAlias" CASCADE;
DROP TABLE IF EXISTS "LocationContainment" CASCADE;
DROP TABLE IF EXISTS "Entity" CASCADE;
DROP TABLE IF EXISTS "Outbox" CASCADE;
DROP TABLE IF EXISTS "AnalysisRun" CASCADE;

ALTER TABLE "Document" DROP COLUMN IF EXISTS "analysisStatus";
ALTER TABLE "Document" DROP COLUMN IF EXISTS "lastAnalyzedVersion";
ALTER TABLE "Document" DROP COLUMN IF EXISTS "lastAnalyzedContent";
ALTER TABLE "Document" DROP COLUMN IF EXISTS "currentRunId";
ALTER TABLE "Document" ADD COLUMN "currentRunId" TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnalysisStatus') THEN
    DROP TYPE "AnalysisStatus";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnalysisJobStatus') THEN
    DROP TYPE "AnalysisJobStatus";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MentionRouting') THEN
    DROP TYPE "MentionRouting";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MentionDecisionStatus') THEN
    DROP TYPE "MentionDecisionStatus";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MentionCandidateType') THEN
    DROP TYPE "MentionCandidateType";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnalysisRunPhase') THEN
    DROP TYPE "AnalysisRunPhase";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnalysisRunState') THEN
    DROP TYPE "AnalysisRunState";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntityType') THEN
    DROP TYPE "EntityType";
  END IF;
END $$;

CREATE TYPE "EntityType" AS ENUM ('character', 'location', 'event');
CREATE TYPE "AnalysisRunState" AS ENUM ('queued', 'running', 'completed', 'failed', 'superseded');
CREATE TYPE "AnalysisRunPhase" AS ENUM ('queued', 'prepass', 'entity_pass', 'sweep', 'mention_completion', 'apply', 'completed', 'failed', 'superseded');
CREATE TYPE "MentionRouting" AS ENUM ('deterministic', 'patch');
CREATE TYPE "MentionDecisionStatus" AS ENUM ('pending', 'accepted', 'rejected');
CREATE TYPE "MentionCandidateType" AS ENUM ('alias', 'role', 'coreference', 'ambiguous');

CREATE TABLE "AnalysisRun" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "contentVersion" INTEGER NOT NULL,
  "idempotencyKey" TEXT,
  "state" "AnalysisRunState" NOT NULL DEFAULT 'queued',
  "phase" "AnalysisRunPhase" NOT NULL DEFAULT 'queued',
  "error" TEXT,
  "patchBudgetReached" BOOLEAN NOT NULL DEFAULT false,
  "uncertainCountRemaining" INTEGER NOT NULL DEFAULT 0,
  "eligibleTotal" INTEGER NOT NULL DEFAULT 0,
  "eligibleResolved" INTEGER NOT NULL DEFAULT 0,
  "routingPolicyVersion" TEXT,
  "qualityFlags" JSONB,
  "quickSnapshot" JSONB,
  "finalSnapshot" JSONB,
  "supersededByRunId" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AnalysisRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AnalysisRun_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AnalysisRun_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AnalysisRun_supersededByRunId_fkey" FOREIGN KEY ("supersededByRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "AnalysisRun_projectId_state_idx" ON "AnalysisRun"("projectId", "state");
CREATE INDEX "AnalysisRun_documentId_contentVersion_idx" ON "AnalysisRun"("documentId", "contentVersion");
CREATE INDEX "AnalysisRun_chapterId_createdAt_idx" ON "AnalysisRun"("chapterId", "createdAt");
CREATE UNIQUE INDEX "AnalysisRun_documentId_idempotencyKey_key" ON "AnalysisRun"("documentId", "idempotencyKey");

CREATE TABLE "Entity" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "type" "EntityType" NOT NULL,
  "canonicalName" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdByRunId" TEXT,
  "mergedIntoEntityId" TEXT,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Entity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Entity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Entity_createdByRunId_fkey" FOREIGN KEY ("createdByRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Entity_mergedIntoEntityId_fkey" FOREIGN KEY ("mergedIntoEntityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Entity_projectId_type_normalizedName_key" ON "Entity"("projectId", "type", "normalizedName");
CREATE INDEX "Entity_projectId_type_canonicalName_idx" ON "Entity"("projectId", "type", "canonicalName");
CREATE INDEX "Entity_projectId_type_normalizedName_idx" ON "Entity"("projectId", "type", "normalizedName");

CREATE TABLE "EntityAlias" (
  "id" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "alias" TEXT NOT NULL,
  "normalizedAlias" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "observed" BOOLEAN NOT NULL DEFAULT true,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EntityAlias_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EntityAlias_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EntityAlias_entityId_normalizedAlias_key" ON "EntityAlias"("entityId", "normalizedAlias");
CREATE INDEX "EntityAlias_entityId_idx" ON "EntityAlias"("entityId");
CREATE INDEX "EntityAlias_normalizedAlias_idx" ON "EntityAlias"("normalizedAlias");
CREATE INDEX "EntityAlias_normalizedAlias_trgm_idx" ON "EntityAlias" USING GIN ("normalizedAlias" gin_trgm_ops);

CREATE TABLE "MentionCandidate" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "contentVersion" INTEGER NOT NULL,
  "paragraphIndex" INTEGER NOT NULL,
  "startOffset" INTEGER NOT NULL,
  "endOffset" INTEGER NOT NULL,
  "sourceText" TEXT NOT NULL,
  "candidateType" "MentionCandidateType" NOT NULL,
  "routing" "MentionRouting" NOT NULL DEFAULT 'deterministic',
  "decisionStatus" "MentionDecisionStatus" NOT NULL DEFAULT 'pending',
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "featuresJson" JSONB,
  "conflictGroupId" TEXT,
  "entityHintId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MentionCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MentionCandidate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MentionCandidate_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MentionCandidate_entityHintId_fkey" FOREIGN KEY ("entityHintId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "MentionCandidate_runId_idx" ON "MentionCandidate"("runId");
CREATE INDEX "MentionCandidate_documentId_paragraphIndex_idx" ON "MentionCandidate"("documentId", "paragraphIndex");
CREATE INDEX "MentionCandidate_decisionStatus_idx" ON "MentionCandidate"("decisionStatus");

CREATE TABLE "Mention" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "contentVersion" INTEGER NOT NULL,
  "entityId" TEXT NOT NULL,
  "candidateId" TEXT,
  "paragraphIndex" INTEGER NOT NULL,
  "startOffset" INTEGER NOT NULL,
  "endOffset" INTEGER NOT NULL,
  "sourceText" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "resolvedBy" TEXT NOT NULL DEFAULT 'deterministic',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Mention_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Mention_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Mention_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Mention_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Mention_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "MentionCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "Mention_documentId_paragraphIndex_idx" ON "Mention"("documentId", "paragraphIndex");
CREATE INDEX "Mention_documentId_entityId_idx" ON "Mention"("documentId", "entityId");
CREATE INDEX "Mention_runId_idx" ON "Mention"("runId");
CREATE INDEX "Mention_candidateId_idx" ON "Mention"("candidateId");

CREATE TABLE "PatchDecision" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "windowKey" TEXT NOT NULL,
  "inputCandidateIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "model" TEXT NOT NULL,
  "usageJson" JSONB,
  "applied" BOOLEAN NOT NULL DEFAULT false,
  "validationError" TEXT,
  "responseHashSha256" TEXT,
  "rawResponseSnippet" TEXT,
  "responseBytes" INTEGER,
  "blobKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PatchDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PatchDecision_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PatchDecision_runId_windowKey_idx" ON "PatchDecision"("runId", "windowKey");

CREATE TABLE "Outbox" (
  "id" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payloadJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "error" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Outbox_processedAt_createdAt_idx" ON "Outbox"("processedAt", "createdAt");
CREATE INDEX "Outbox_aggregateType_aggregateId_idx" ON "Outbox"("aggregateType", "aggregateId");

CREATE TABLE "LocationContainment" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "childEntityId" TEXT NOT NULL,
  "parentEntityId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LocationContainment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LocationContainment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LocationContainment_childEntityId_fkey" FOREIGN KEY ("childEntityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LocationContainment_parentEntityId_fkey" FOREIGN KEY ("parentEntityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LocationContainment_child_parent_not_equal" CHECK ("childEntityId" <> "parentEntityId")
);

CREATE UNIQUE INDEX "LocationContainment_childEntityId_key" ON "LocationContainment"("childEntityId");
CREATE UNIQUE INDEX "LocationContainment_childEntityId_parentEntityId_key" ON "LocationContainment"("childEntityId", "parentEntityId");
CREATE INDEX "LocationContainment_projectId_parentEntityId_idx" ON "LocationContainment"("projectId", "parentEntityId");

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_currentRunId_fkey"
  FOREIGN KEY ("currentRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Document_currentRunId_idx" ON "Document"("currentRunId");

-- Hard reset of active run pointer and initial reindex outbox seeds.
UPDATE "Document"
SET "currentRunId" = NULL,
    "updatedAt" = NOW();

INSERT INTO "Outbox" (
  "id",
  "aggregateType",
  "aggregateId",
  "eventType",
  "payloadJson",
  "createdAt",
  "attemptCount"
)
SELECT
  'reindex-' || md5(d."id" || ':' || clock_timestamp()::text || ':' || random()::text),
  'document',
  d."id",
  'document.reindex.requested',
  jsonb_build_object(
    'projectId', d."projectId",
    'documentId', d."id",
    'chapterId', d."chapterId",
    'contentVersion', d."contentVersion"
  ),
  NOW(),
  0
FROM "Document" d
WHERE btrim(d."content") <> '';
