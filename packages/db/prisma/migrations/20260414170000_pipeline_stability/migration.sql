ALTER TABLE "BookAnalyzerTask"
ADD COLUMN "metadataJson" JSONB;

ALTER TABLE "Outbox"
ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Outbox"
SET "availableAt" = COALESCE("createdAt", CURRENT_TIMESTAMP)
WHERE "availableAt" IS NULL;

CREATE INDEX "BookAnalyzerTask_state_updatedAt_idx"
ON "BookAnalyzerTask"("state", "updatedAt");

CREATE INDEX "Outbox_processedAt_availableAt_createdAt_idx"
ON "Outbox"("processedAt", "availableAt", "createdAt");
