-- CreateEnum
CREATE TYPE "AppearanceScope" AS ENUM ('stable', 'temporary', 'scene');

-- AlterEnum
ALTER TYPE "AnalysisRunPhase" ADD VALUE IF NOT EXISTS 'act_pass';
ALTER TYPE "AnalysisRunPhase" ADD VALUE IF NOT EXISTS 'appearance_pass';

-- CreateTable
CREATE TABLE "CharacterAppearanceObservation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "contentVersion" INTEGER NOT NULL,
    "runId" TEXT,
    "characterId" TEXT NOT NULL,
    "actId" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "attributeKey" TEXT NOT NULL,
    "attributeLabel" TEXT NOT NULL,
    "valueText" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "scope" "AppearanceScope" NOT NULL DEFAULT 'scene',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CharacterAppearanceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CharacterAppearanceEvidence" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "mentionId" TEXT NOT NULL,
    "evidenceOrder" INTEGER NOT NULL DEFAULT 0,
    "paragraphIndex" INTEGER NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "sourceText" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CharacterAppearanceEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CharacterAppearanceObservation_projectId_characterId_chapte_idx" ON "CharacterAppearanceObservation"("projectId", "characterId", "chapterId", "orderIndex");

-- CreateIndex
CREATE INDEX "CharacterAppearanceObservation_documentId_contentVersion_or_idx" ON "CharacterAppearanceObservation"("documentId", "contentVersion", "orderIndex");

-- CreateIndex
CREATE INDEX "CharacterAppearanceObservation_characterId_actId_idx" ON "CharacterAppearanceObservation"("characterId", "actId");

-- CreateIndex
CREATE INDEX "CharacterAppearanceObservation_runId_idx" ON "CharacterAppearanceObservation"("runId");

-- CreateIndex
CREATE INDEX "CharacterAppearanceEvidence_observationId_evidenceOrder_idx" ON "CharacterAppearanceEvidence"("observationId", "evidenceOrder");

-- CreateIndex
CREATE INDEX "CharacterAppearanceEvidence_mentionId_idx" ON "CharacterAppearanceEvidence"("mentionId");

-- CreateIndex
CREATE UNIQUE INDEX "CharacterAppearanceEvidence_observationId_mentionId_key" ON "CharacterAppearanceEvidence"("observationId", "mentionId");

-- AddForeignKey
ALTER TABLE "CharacterAppearanceObservation" ADD CONSTRAINT "CharacterAppearanceObservation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterAppearanceObservation" ADD CONSTRAINT "CharacterAppearanceObservation_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterAppearanceObservation" ADD CONSTRAINT "CharacterAppearanceObservation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterAppearanceObservation" ADD CONSTRAINT "CharacterAppearanceObservation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterAppearanceObservation" ADD CONSTRAINT "CharacterAppearanceObservation_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (guarded: Act table is created in a later migration in this repo)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Act') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'CharacterAppearanceObservation_actId_fkey'
    ) THEN
      ALTER TABLE "CharacterAppearanceObservation"
        ADD CONSTRAINT "CharacterAppearanceObservation_actId_fkey"
        FOREIGN KEY ("actId") REFERENCES "Act"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
  END IF;
END $$;

-- AddForeignKey
ALTER TABLE "CharacterAppearanceEvidence" ADD CONSTRAINT "CharacterAppearanceEvidence_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "CharacterAppearanceObservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharacterAppearanceEvidence" ADD CONSTRAINT "CharacterAppearanceEvidence_mentionId_fkey" FOREIGN KEY ("mentionId") REFERENCES "Mention"("id") ON DELETE CASCADE ON UPDATE CASCADE;
