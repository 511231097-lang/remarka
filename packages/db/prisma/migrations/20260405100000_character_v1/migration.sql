CREATE TYPE "MentionType" AS ENUM ('named', 'alias', 'descriptor', 'pronoun');
CREATE TYPE "AliasType" AS ENUM ('name', 'nickname', 'title', 'descriptor');

ALTER TABLE "Entity"
  ADD COLUMN "mentionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "firstAppearanceChapterId" TEXT,
  ADD COLUMN "firstAppearanceOffset" INTEGER,
  ADD COLUMN "lastAppearanceChapterId" TEXT,
  ADD COLUMN "lastAppearanceOffset" INTEGER;

ALTER TABLE "Entity"
  ADD CONSTRAINT "Entity_firstAppearanceChapterId_fkey"
  FOREIGN KEY ("firstAppearanceChapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Entity"
  ADD CONSTRAINT "Entity_lastAppearanceChapterId_fkey"
  FOREIGN KEY ("lastAppearanceChapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EntityAlias"
  ADD COLUMN "aliasType" "AliasType" NOT NULL DEFAULT 'name';

ALTER TABLE "Mention"
  ADD COLUMN "mentionType" "MentionType" NOT NULL DEFAULT 'alias';

CREATE TABLE "CharacterChapterStat" (
  "id" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "chapterId" TEXT NOT NULL,
  "mentionCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CharacterChapterStat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CharacterChapterStat_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CharacterChapterStat_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CharacterChapterStat_characterId_chapterId_key"
  ON "CharacterChapterStat"("characterId", "chapterId");
CREATE INDEX "CharacterChapterStat_chapterId_idx"
  ON "CharacterChapterStat"("chapterId");

CREATE INDEX "Entity_projectId_type_mentionCount_idx"
  ON "Entity"("projectId", "type", "mentionCount");
CREATE INDEX "Entity_firstAppearanceChapterId_idx"
  ON "Entity"("firstAppearanceChapterId");
CREATE INDEX "Entity_lastAppearanceChapterId_idx"
  ON "Entity"("lastAppearanceChapterId");

CREATE INDEX "Mention_documentId_contentVersion_entityId_idx"
  ON "Mention"("documentId", "contentVersion", "entityId");
CREATE INDEX "Mention_entityId_mentionType_idx"
  ON "Mention"("entityId", "mentionType");

CREATE INDEX "Mention_sourceText_trgm_idx"
  ON "Mention" USING GIN ("sourceText" gin_trgm_ops);
