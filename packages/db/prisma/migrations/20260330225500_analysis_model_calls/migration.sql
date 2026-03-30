CREATE TABLE "AnalysisModelCall" (
  "id" TEXT NOT NULL,
  "analysisJobId" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "extractionMode" TEXT NOT NULL,
  "batchIndex" INTEGER,
  "targetParagraphIndices" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "model" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "rawResponse" TEXT NOT NULL,
  "jsonCandidate" TEXT,
  "normalizedPayload" JSONB,
  "parseError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AnalysisModelCall_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AnalysisModelCall_analysisJobId_fkey" FOREIGN KEY ("analysisJobId") REFERENCES "AnalysisJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AnalysisModelCall_analysisJobId_createdAt_idx"
  ON "AnalysisModelCall"("analysisJobId", "createdAt");
