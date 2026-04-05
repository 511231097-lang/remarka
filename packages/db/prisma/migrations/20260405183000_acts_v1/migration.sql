CREATE TABLE "Act" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "contentVersion" INTEGER NOT NULL,
  "orderIndex" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "paragraphStart" INTEGER NOT NULL,
  "paragraphEnd" INTEGER NOT NULL,
  "createdByRunId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Act_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Act_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Act_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Act_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Act_createdByRunId_fkey" FOREIGN KEY ("createdByRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Act_documentId_contentVersion_orderIndex_key"
  ON "Act"("documentId", "contentVersion", "orderIndex");
CREATE INDEX "Act_projectId_chapterId_orderIndex_idx"
  ON "Act"("projectId", "chapterId", "orderIndex");
CREATE INDEX "Act_documentId_contentVersion_orderIndex_idx"
  ON "Act"("documentId", "contentVersion", "orderIndex");
CREATE INDEX "Act_chapterId_contentVersion_orderIndex_idx"
  ON "Act"("chapterId", "contentVersion", "orderIndex");
CREATE INDEX "Act_createdByRunId_idx"
  ON "Act"("createdByRunId");

ALTER TABLE "Mention"
  ADD COLUMN "actId" TEXT;

ALTER TABLE "Mention"
  ADD CONSTRAINT "Mention_actId_fkey"
  FOREIGN KEY ("actId") REFERENCES "Act"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Mention_actId_idx"
  ON "Mention"("actId");
CREATE INDEX "Mention_entityId_actId_idx"
  ON "Mention"("entityId", "actId");

CREATE TABLE "CharacterActStat" (
  "id" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "actId" TEXT NOT NULL,
  "mentionCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CharacterActStat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CharacterActStat_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CharacterActStat_actId_fkey" FOREIGN KEY ("actId") REFERENCES "Act"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CharacterActStat_characterId_actId_key"
  ON "CharacterActStat"("characterId", "actId");
CREATE INDEX "CharacterActStat_actId_idx"
  ON "CharacterActStat"("actId");
