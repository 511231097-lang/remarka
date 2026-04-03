ALTER TABLE "AnalysisModelCall"
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "requestStartedAt" TIMESTAMP(3),
  ADD COLUMN "requestCompletedAt" TIMESTAMP(3),
  ADD COLUMN "durationMs" INTEGER;

CREATE TABLE "AnalysisJobStageMetric" (
  "id" TEXT NOT NULL,
  "analysisJobId" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AnalysisJobStageMetric_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AnalysisJobStageMetric_analysisJobId_fkey"
    FOREIGN KEY ("analysisJobId") REFERENCES "AnalysisJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AnalysisJobStageMetric_analysisJobId_createdAt_idx"
  ON "AnalysisJobStageMetric"("analysisJobId", "createdAt");

CREATE INDEX "AnalysisJobStageMetric_analysisJobId_stage_idx"
  ON "AnalysisJobStageMetric"("analysisJobId", "stage");
