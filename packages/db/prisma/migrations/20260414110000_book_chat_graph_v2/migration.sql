-- CreateEnum
CREATE TYPE "BookGraphEntityType" AS ENUM ('character', 'location', 'group', 'object', 'theme', 'motif', 'concept');

-- CreateEnum
CREATE TYPE "BookEventEdgeType" AS ENUM ('before', 'after', 'causes', 'results_in', 'parallels');

-- CreateEnum
CREATE TYPE "BookRelationEdgeType" AS ENUM ('ally', 'family', 'romance', 'conflict', 'authority', 'dependence', 'rivalry', 'mirror', 'symbolic_association');

-- CreateEnum
CREATE TYPE "BookSummaryArtifactKind" AS ENUM ('book_brief', 'scene_summary', 'chapter_summary', 'character_arc', 'relationship_summary', 'theme_note', 'motif_note', 'chapter_retelling', 'literary_section');

-- CreateEnum
CREATE TYPE "BookEvidenceSubjectType" AS ENUM ('scene', 'event', 'relation', 'summary_artifact', 'entity');

-- CreateEnum
CREATE TYPE "BookEvidenceRefType" AS ENUM ('scene', 'paragraph', 'sentence', 'quote');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BookAnalyzerType" ADD VALUE 'canonical_text';
ALTER TYPE "BookAnalyzerType" ADD VALUE 'scene_build';
ALTER TYPE "BookAnalyzerType" ADD VALUE 'entity_graph';
ALTER TYPE "BookAnalyzerType" ADD VALUE 'event_relation_graph';
ALTER TYPE "BookAnalyzerType" ADD VALUE 'summary_store';
ALTER TYPE "BookAnalyzerType" ADD VALUE 'evidence_store';
ALTER TYPE "BookAnalyzerType" ADD VALUE 'text_index';
ALTER TYPE "BookAnalyzerType" ADD VALUE 'quote_store';

-- CreateTable
CREATE TABLE "BookParagraph" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "sceneId" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "orderInChapter" INTEGER NOT NULL,
    "startChar" INTEGER NOT NULL,
    "endChar" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookParagraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookSentence" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "paragraphId" TEXT NOT NULL,
    "sceneId" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "orderInChapter" INTEGER NOT NULL,
    "orderInScene" INTEGER NOT NULL,
    "startChar" INTEGER NOT NULL,
    "endChar" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookSentence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookScene" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "title" TEXT,
    "summary" TEXT,
    "startParagraphOrder" INTEGER NOT NULL,
    "endParagraphOrder" INTEGER NOT NULL,
    "startChar" INTEGER NOT NULL,
    "endChar" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" vector(768),
    "embeddingModel" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookEntity" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "type" "BookGraphEntityType" NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "mentionCount" INTEGER NOT NULL DEFAULT 0,
    "firstSceneId" TEXT,
    "lastSceneId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookEntityAlias" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "aliasType" "AliasType" NOT NULL DEFAULT 'name',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookEntityAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookMention" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "paragraphId" TEXT,
    "sentenceId" TEXT,
    "mentionType" "MentionType" NOT NULL DEFAULT 'alias',
    "startChar" INTEGER NOT NULL,
    "endChar" INTEGER NOT NULL,
    "sourceText" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookEvent" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "sceneId" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookEventParticipant" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "entityId" TEXT,
    "role" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookEventParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookEventEdge" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "fromEventId" TEXT NOT NULL,
    "toEventId" TEXT NOT NULL,
    "type" "BookEventEdgeType" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookEventEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookRelationEdge" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "fromEntityId" TEXT NOT NULL,
    "toEntityId" TEXT NOT NULL,
    "type" "BookRelationEdgeType" NOT NULL,
    "summary" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "sceneId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookRelationEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookSummaryArtifact" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "kind" "BookSummaryArtifactKind" NOT NULL,
    "key" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "bodyMarkdown" TEXT,
    "chapterId" TEXT,
    "sceneId" TEXT,
    "entityId" TEXT,
    "metadataJson" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookSummaryArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookEvidenceLink" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "subjectType" "BookEvidenceSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "evidenceType" "BookEvidenceRefType" NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "chapterOrderIndex" INTEGER,
    "snippet" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookEvidenceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookChatSessionState" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "stateJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookChatSessionState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookParagraph_chapterId_orderInChapter_idx" ON "BookParagraph"("chapterId", "orderInChapter");

-- CreateIndex
CREATE INDEX "BookParagraph_sceneId_orderIndex_idx" ON "BookParagraph"("sceneId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "BookParagraph_bookId_orderIndex_key" ON "BookParagraph"("bookId", "orderIndex");

-- CreateIndex
CREATE INDEX "BookSentence_paragraphId_orderIndex_idx" ON "BookSentence"("paragraphId", "orderIndex");

-- CreateIndex
CREATE INDEX "BookSentence_sceneId_orderIndex_idx" ON "BookSentence"("sceneId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "BookSentence_bookId_orderIndex_key" ON "BookSentence"("bookId", "orderIndex");

-- CreateIndex
CREATE INDEX "BookScene_chapterId_orderIndex_idx" ON "BookScene"("chapterId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "BookScene_bookId_orderIndex_key" ON "BookScene"("bookId", "orderIndex");

-- CreateIndex
CREATE INDEX "BookEntity_bookId_type_mentionCount_idx" ON "BookEntity"("bookId", "type", "mentionCount");

-- CreateIndex
CREATE INDEX "BookEntity_firstSceneId_idx" ON "BookEntity"("firstSceneId");

-- CreateIndex
CREATE INDEX "BookEntity_lastSceneId_idx" ON "BookEntity"("lastSceneId");

-- CreateIndex
CREATE UNIQUE INDEX "BookEntity_bookId_type_normalizedName_key" ON "BookEntity"("bookId", "type", "normalizedName");

-- CreateIndex
CREATE INDEX "BookEntityAlias_normalizedAlias_idx" ON "BookEntityAlias"("normalizedAlias");

-- CreateIndex
CREATE UNIQUE INDEX "BookEntityAlias_entityId_normalizedAlias_key" ON "BookEntityAlias"("entityId", "normalizedAlias");

-- CreateIndex
CREATE INDEX "BookMention_bookId_entityId_idx" ON "BookMention"("bookId", "entityId");

-- CreateIndex
CREATE INDEX "BookMention_sceneId_entityId_idx" ON "BookMention"("sceneId", "entityId");

-- CreateIndex
CREATE INDEX "BookMention_paragraphId_idx" ON "BookMention"("paragraphId");

-- CreateIndex
CREATE INDEX "BookMention_sentenceId_idx" ON "BookMention"("sentenceId");

-- CreateIndex
CREATE INDEX "BookEvent_chapterId_orderIndex_idx" ON "BookEvent"("chapterId", "orderIndex");

-- CreateIndex
CREATE INDEX "BookEvent_sceneId_idx" ON "BookEvent"("sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "BookEvent_bookId_orderIndex_key" ON "BookEvent"("bookId", "orderIndex");

-- CreateIndex
CREATE INDEX "BookEventParticipant_eventId_idx" ON "BookEventParticipant"("eventId");

-- CreateIndex
CREATE INDEX "BookEventParticipant_entityId_idx" ON "BookEventParticipant"("entityId");

-- CreateIndex
CREATE INDEX "BookEventEdge_bookId_type_idx" ON "BookEventEdge"("bookId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "BookEventEdge_fromEventId_toEventId_type_key" ON "BookEventEdge"("fromEventId", "toEventId", "type");

-- CreateIndex
CREATE INDEX "BookRelationEdge_sceneId_idx" ON "BookRelationEdge"("sceneId");

-- CreateIndex
CREATE INDEX "BookRelationEdge_bookId_type_idx" ON "BookRelationEdge"("bookId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "BookRelationEdge_bookId_fromEntityId_toEntityId_type_key" ON "BookRelationEdge"("bookId", "fromEntityId", "toEntityId", "type");

-- CreateIndex
CREATE INDEX "BookSummaryArtifact_chapterId_idx" ON "BookSummaryArtifact"("chapterId");

-- CreateIndex
CREATE INDEX "BookSummaryArtifact_sceneId_idx" ON "BookSummaryArtifact"("sceneId");

-- CreateIndex
CREATE INDEX "BookSummaryArtifact_entityId_idx" ON "BookSummaryArtifact"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "BookSummaryArtifact_bookId_kind_key_key" ON "BookSummaryArtifact"("bookId", "kind", "key");

-- CreateIndex
CREATE INDEX "BookEvidenceLink_bookId_subjectType_subjectId_idx" ON "BookEvidenceLink"("bookId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "BookEvidenceLink_bookId_evidenceType_evidenceId_idx" ON "BookEvidenceLink"("bookId", "evidenceType", "evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "BookChatSessionState_sessionId_key" ON "BookChatSessionState"("sessionId");

-- CreateIndex
CREATE INDEX "BookChatSessionState_bookId_updatedAt_idx" ON "BookChatSessionState"("bookId", "updatedAt");

-- AddForeignKey
ALTER TABLE "BookParagraph" ADD CONSTRAINT "BookParagraph_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookParagraph" ADD CONSTRAINT "BookParagraph_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookParagraph" ADD CONSTRAINT "BookParagraph_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "BookScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSentence" ADD CONSTRAINT "BookSentence_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSentence" ADD CONSTRAINT "BookSentence_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSentence" ADD CONSTRAINT "BookSentence_paragraphId_fkey" FOREIGN KEY ("paragraphId") REFERENCES "BookParagraph"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSentence" ADD CONSTRAINT "BookSentence_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "BookScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookScene" ADD CONSTRAINT "BookScene_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookScene" ADD CONSTRAINT "BookScene_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEntity" ADD CONSTRAINT "BookEntity_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEntity" ADD CONSTRAINT "BookEntity_firstSceneId_fkey" FOREIGN KEY ("firstSceneId") REFERENCES "BookScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEntity" ADD CONSTRAINT "BookEntity_lastSceneId_fkey" FOREIGN KEY ("lastSceneId") REFERENCES "BookScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEntityAlias" ADD CONSTRAINT "BookEntityAlias_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "BookEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookMention" ADD CONSTRAINT "BookMention_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookMention" ADD CONSTRAINT "BookMention_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "BookEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookMention" ADD CONSTRAINT "BookMention_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookMention" ADD CONSTRAINT "BookMention_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "BookScene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookMention" ADD CONSTRAINT "BookMention_paragraphId_fkey" FOREIGN KEY ("paragraphId") REFERENCES "BookParagraph"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookMention" ADD CONSTRAINT "BookMention_sentenceId_fkey" FOREIGN KEY ("sentenceId") REFERENCES "BookSentence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEvent" ADD CONSTRAINT "BookEvent_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEvent" ADD CONSTRAINT "BookEvent_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEvent" ADD CONSTRAINT "BookEvent_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "BookScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEventParticipant" ADD CONSTRAINT "BookEventParticipant_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "BookEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEventParticipant" ADD CONSTRAINT "BookEventParticipant_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "BookEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEventEdge" ADD CONSTRAINT "BookEventEdge_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEventEdge" ADD CONSTRAINT "BookEventEdge_fromEventId_fkey" FOREIGN KEY ("fromEventId") REFERENCES "BookEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEventEdge" ADD CONSTRAINT "BookEventEdge_toEventId_fkey" FOREIGN KEY ("toEventId") REFERENCES "BookEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookRelationEdge" ADD CONSTRAINT "BookRelationEdge_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookRelationEdge" ADD CONSTRAINT "BookRelationEdge_fromEntityId_fkey" FOREIGN KEY ("fromEntityId") REFERENCES "BookEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookRelationEdge" ADD CONSTRAINT "BookRelationEdge_toEntityId_fkey" FOREIGN KEY ("toEntityId") REFERENCES "BookEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookRelationEdge" ADD CONSTRAINT "BookRelationEdge_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "BookScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSummaryArtifact" ADD CONSTRAINT "BookSummaryArtifact_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSummaryArtifact" ADD CONSTRAINT "BookSummaryArtifact_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "BookChapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSummaryArtifact" ADD CONSTRAINT "BookSummaryArtifact_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "BookScene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSummaryArtifact" ADD CONSTRAINT "BookSummaryArtifact_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "BookEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEvidenceLink" ADD CONSTRAINT "BookEvidenceLink_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookChatSessionState" ADD CONSTRAINT "BookChatSessionState_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "BookChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookChatSessionState" ADD CONSTRAINT "BookChatSessionState_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
