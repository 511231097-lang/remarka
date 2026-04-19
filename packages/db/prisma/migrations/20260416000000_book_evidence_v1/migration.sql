-- CreateEnum
CREATE TYPE "BookAnalysisRunState" AS ENUM ('queued', 'running', 'completed', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "BookEvidenceStageKey" AS ENUM ('ingest_normalize', 'structural_pass', 'local_extraction_mentions', 'local_extraction_quotes', 'local_extraction_events', 'local_extraction_relations', 'local_extraction_time_location', 'validation_pass', 'entity_resolution', 'scene_assembly', 'event_timeline', 'relation_aggregation', 'summary_synthesis', 'index_build', 'repair');

-- CreateEnum
CREATE TYPE "BookObservationType" AS ENUM ('mention', 'quote', 'scene_boundary', 'event', 'relation', 'location', 'time_marker');

-- CreateEnum
CREATE TYPE "BookObservationCertainty" AS ENUM ('explicit', 'implied', 'uncertain');

-- CreateEnum
CREATE TYPE "BookObservationValidationStatus" AS ENUM ('pending', 'valid', 'invalid');

-- CreateEnum
CREATE TYPE "BookCanonicalEntityStatus" AS ENUM ('active', 'ambiguous', 'merged');

-- CreateEnum
CREATE TYPE "BookTimelineOrder" AS ENUM ('before', 'after', 'same', 'uncertain');

-- CreateEnum
CREATE TYPE "BookSummaryTargetType" AS ENUM ('entity', 'scene', 'chapter', 'book', 'arc', 'relation');

-- CreateEnum
CREATE TYPE "BookSummaryKind" AS ENUM ('short', 'full', 'timeline', 'role', 'relation_history');

-- CreateEnum
CREATE TYPE "BookCoverageStatus" AS ENUM ('full', 'partial');

-- CreateTable
CREATE TABLE "BookContentVersion" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceFormat" "BookFormat" NOT NULL,
    "normalizationVersion" INTEGER NOT NULL DEFAULT 1,
    "fileSha256" TEXT NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookContentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookAnalysisRun" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "state" "BookAnalysisRunState" NOT NULL DEFAULT 'queued',
    "currentStageKey" "BookEvidenceStageKey",
    "error" TEXT,
    "qualityFlagsJson" JSONB,
    "metricsJson" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookAnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookStageExecution" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stageKey" "BookEvidenceStageKey" NOT NULL,
    "state" "BookAnalysisState" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "metadataJson" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookStageExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookValidationFailure" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stageKey" "BookEvidenceStageKey" NOT NULL,
    "observationId" TEXT,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sourceSpanJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookValidationFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookSourceChapter" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "bookChapterId" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "paragraphStart" INTEGER NOT NULL,
    "paragraphEnd" INTEGER NOT NULL,
    "charLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookSourceChapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookSourceParagraph" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "sourceChapterId" TEXT NOT NULL,
    "orderIndexInBook" INTEGER NOT NULL,
    "orderIndexInChapter" INTEGER NOT NULL,
    "startChar" INTEGER NOT NULL,
    "endChar" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "charLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookSourceParagraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookAnalysisWindow" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "sourceChapterId" TEXT NOT NULL,
    "windowIndex" INTEGER NOT NULL,
    "paragraphStart" INTEGER NOT NULL,
    "paragraphEnd" INTEGER NOT NULL,
    "stride" INTEGER NOT NULL,
    "windowSize" INTEGER NOT NULL,
    "textPreview" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookAnalysisWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookObservation" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "windowId" TEXT,
    "observationType" "BookObservationType" NOT NULL,
    "sourceSpansJson" JSONB NOT NULL,
    "evidenceQuote" TEXT,
    "certainty" "BookObservationCertainty" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "validationStatus" "BookObservationValidationStatus" NOT NULL DEFAULT 'pending',
    "payloadJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookCanonicalEntity" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" "BookGraphEntityType" NOT NULL,
    "subtype" TEXT,
    "canonicalName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "aliasesJson" JSONB,
    "summaryShort" TEXT,
    "summaryFull" TEXT,
    "stableFactsJson" JSONB,
    "firstSceneId" TEXT,
    "lastSceneId" TEXT,
    "status" "BookCanonicalEntityStatus" NOT NULL DEFAULT 'active',
    "supportingObservationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceSpansJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookCanonicalEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookCanonicalAlias" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookCanonicalAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookCanonicalScene" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceChapterId" TEXT NOT NULL,
    "chapterOrderIndex" INTEGER NOT NULL,
    "indexInBook" INTEGER NOT NULL,
    "paragraphStart" INTEGER NOT NULL,
    "paragraphEnd" INTEGER NOT NULL,
    "participantEntityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locationEntityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeMarkerValuesJson" JSONB,
    "summaryShort" TEXT,
    "summaryFull" TEXT,
    "supportingObservationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceSpansJson" JSONB NOT NULL,
    "unresolvedParagraphCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookCanonicalScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookCanonicalEvent" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sceneId" TEXT,
    "sourceChapterId" TEXT,
    "orderIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "actorEntityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetEntityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locationEntityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeMarkerValuesJson" JSONB,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "supportingObservationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceRefsJson" JSONB,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookCanonicalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookTimelineEdge" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fromEventId" TEXT NOT NULL,
    "toEventId" TEXT NOT NULL,
    "order" "BookTimelineOrder" NOT NULL,
    "reason" TEXT,
    "supportingObservationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceRefsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookTimelineEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookCanonicalRelation" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "entityAId" TEXT NOT NULL,
    "entityBId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "currentState" TEXT,
    "stateHistoryJson" JSONB,
    "supportingObservationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceRefsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookCanonicalRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookCanonicalQuote" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sceneId" TEXT,
    "speakerEntityId" TEXT,
    "aboutEntityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quoteText" TEXT NOT NULL,
    "spanRefJson" JSONB NOT NULL,
    "attributionMode" TEXT NOT NULL,
    "supportingObservationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookCanonicalQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookCanonicalSummary" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "targetType" "BookSummaryTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "summaryKind" "BookSummaryKind" NOT NULL,
    "text" TEXT NOT NULL,
    "supportingRefsJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookCanonicalSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookEntityCard" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "cardJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookEntityCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookSceneCard" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "cardJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookSceneCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookRelationCard" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "relationId" TEXT NOT NULL,
    "cardJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookRelationCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookTimelineSlice" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "sliceKey" TEXT NOT NULL,
    "sliceJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookTimelineSlice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookQuoteSlice" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "sliceJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookQuoteSlice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookSearchDocument" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "title" TEXT,
    "bodyText" TEXT NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookSearchDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookEvidenceHit" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "linkedObjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "spanRefJson" JSONB NOT NULL,
    "whyMatched" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookEvidenceHit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookPresenceMap" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "chapterOrderIndex" INTEGER NOT NULL,
    "paragraphStart" INTEGER NOT NULL,
    "paragraphEnd" INTEGER NOT NULL,
    "mentionCount" INTEGER NOT NULL DEFAULT 0,
    "copresentEntityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookPresenceMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookProcessingReport" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contentVersionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "coverage" "BookCoverageStatus" NOT NULL DEFAULT 'partial',
    "reportJson" JSONB NOT NULL,
    "countsJson" JSONB NOT NULL,
    "unresolvedJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookProcessingReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookContentVersion_bookId_createdAt_idx" ON "BookContentVersion"("bookId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookContentVersion_bookId_version_key" ON "BookContentVersion"("bookId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BookAnalysisRun_contentVersionId_key" ON "BookAnalysisRun"("contentVersionId");

-- CreateIndex
CREATE INDEX "BookAnalysisRun_bookId_state_createdAt_idx" ON "BookAnalysisRun"("bookId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "BookAnalysisRun_bookId_contentVersionId_idx" ON "BookAnalysisRun"("bookId", "contentVersionId");

-- CreateIndex
CREATE INDEX "BookStageExecution_bookId_contentVersionId_stageKey_idx" ON "BookStageExecution"("bookId", "contentVersionId", "stageKey");

-- CreateIndex
CREATE INDEX "BookStageExecution_state_updatedAt_idx" ON "BookStageExecution"("state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookStageExecution_runId_stageKey_key" ON "BookStageExecution"("runId", "stageKey");

-- CreateIndex
CREATE INDEX "BookValidationFailure_bookId_contentVersionId_stageKey_idx" ON "BookValidationFailure"("bookId", "contentVersionId", "stageKey");

-- CreateIndex
CREATE INDEX "BookValidationFailure_runId_stageKey_idx" ON "BookValidationFailure"("runId", "stageKey");

-- CreateIndex
CREATE INDEX "BookValidationFailure_observationId_idx" ON "BookValidationFailure"("observationId");

-- CreateIndex
CREATE INDEX "BookSourceChapter_bookId_contentVersionId_orderIndex_idx" ON "BookSourceChapter"("bookId", "contentVersionId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "BookSourceChapter_contentVersionId_orderIndex_key" ON "BookSourceChapter"("contentVersionId", "orderIndex");

-- CreateIndex
CREATE INDEX "BookSourceParagraph_bookId_contentVersionId_sourceChapterId_idx" ON "BookSourceParagraph"("bookId", "contentVersionId", "sourceChapterId");

-- CreateIndex
CREATE INDEX "BookSourceParagraph_sourceChapterId_orderIndexInChapter_idx" ON "BookSourceParagraph"("sourceChapterId", "orderIndexInChapter");

-- CreateIndex
CREATE UNIQUE INDEX "BookSourceParagraph_contentVersionId_orderIndexInBook_key" ON "BookSourceParagraph"("contentVersionId", "orderIndexInBook");

-- CreateIndex
CREATE INDEX "BookAnalysisWindow_bookId_contentVersionId_sourceChapterId_idx" ON "BookAnalysisWindow"("bookId", "contentVersionId", "sourceChapterId");

-- CreateIndex
CREATE UNIQUE INDEX "BookAnalysisWindow_contentVersionId_windowIndex_key" ON "BookAnalysisWindow"("contentVersionId", "windowIndex");

-- CreateIndex
CREATE INDEX "BookObservation_bookId_contentVersionId_observationType_idx" ON "BookObservation"("bookId", "contentVersionId", "observationType");

-- CreateIndex
CREATE INDEX "BookObservation_runId_observationType_idx" ON "BookObservation"("runId", "observationType");

-- CreateIndex
CREATE INDEX "BookObservation_runId_validationStatus_idx" ON "BookObservation"("runId", "validationStatus");

-- CreateIndex
CREATE INDEX "BookObservation_windowId_idx" ON "BookObservation"("windowId");

-- CreateIndex
CREATE INDEX "BookCanonicalEntity_bookId_contentVersionId_type_idx" ON "BookCanonicalEntity"("bookId", "contentVersionId", "type");

-- CreateIndex
CREATE INDEX "BookCanonicalEntity_bookId_contentVersionId_firstSceneId_idx" ON "BookCanonicalEntity"("bookId", "contentVersionId", "firstSceneId");

-- CreateIndex
CREATE INDEX "BookCanonicalEntity_bookId_contentVersionId_lastSceneId_idx" ON "BookCanonicalEntity"("bookId", "contentVersionId", "lastSceneId");

-- CreateIndex
CREATE UNIQUE INDEX "BookCanonicalEntity_contentVersionId_type_normalizedName_key" ON "BookCanonicalEntity"("contentVersionId", "type", "normalizedName");

-- CreateIndex
CREATE INDEX "BookCanonicalAlias_bookId_contentVersionId_normalizedValue_idx" ON "BookCanonicalAlias"("bookId", "contentVersionId", "normalizedValue");

-- CreateIndex
CREATE UNIQUE INDEX "BookCanonicalAlias_entityId_normalizedValue_key" ON "BookCanonicalAlias"("entityId", "normalizedValue");

-- CreateIndex
CREATE INDEX "BookCanonicalScene_bookId_contentVersionId_sourceChapterId_idx" ON "BookCanonicalScene"("bookId", "contentVersionId", "sourceChapterId");

-- CreateIndex
CREATE UNIQUE INDEX "BookCanonicalScene_contentVersionId_indexInBook_key" ON "BookCanonicalScene"("contentVersionId", "indexInBook");

-- CreateIndex
CREATE INDEX "BookCanonicalEvent_bookId_contentVersionId_sceneId_idx" ON "BookCanonicalEvent"("bookId", "contentVersionId", "sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "BookCanonicalEvent_contentVersionId_orderIndex_key" ON "BookCanonicalEvent"("contentVersionId", "orderIndex");

-- CreateIndex
CREATE INDEX "BookTimelineEdge_bookId_contentVersionId_order_idx" ON "BookTimelineEdge"("bookId", "contentVersionId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "BookTimelineEdge_contentVersionId_fromEventId_toEventId_key" ON "BookTimelineEdge"("contentVersionId", "fromEventId", "toEventId");

-- CreateIndex
CREATE INDEX "BookCanonicalRelation_bookId_contentVersionId_entityAId_idx" ON "BookCanonicalRelation"("bookId", "contentVersionId", "entityAId");

-- CreateIndex
CREATE INDEX "BookCanonicalRelation_bookId_contentVersionId_entityBId_idx" ON "BookCanonicalRelation"("bookId", "contentVersionId", "entityBId");

-- CreateIndex
CREATE UNIQUE INDEX "BookCanonicalRelation_contentVersionId_entityAId_entityBId__key" ON "BookCanonicalRelation"("contentVersionId", "entityAId", "entityBId", "relationType");

-- CreateIndex
CREATE INDEX "BookCanonicalQuote_bookId_contentVersionId_sceneId_idx" ON "BookCanonicalQuote"("bookId", "contentVersionId", "sceneId");

-- CreateIndex
CREATE INDEX "BookCanonicalQuote_bookId_contentVersionId_speakerEntityId_idx" ON "BookCanonicalQuote"("bookId", "contentVersionId", "speakerEntityId");

-- CreateIndex
CREATE INDEX "BookCanonicalSummary_bookId_contentVersionId_targetType_idx" ON "BookCanonicalSummary"("bookId", "contentVersionId", "targetType");

-- CreateIndex
CREATE UNIQUE INDEX "BookCanonicalSummary_contentVersionId_targetType_targetId_s_key" ON "BookCanonicalSummary"("contentVersionId", "targetType", "targetId", "summaryKind");

-- CreateIndex
CREATE INDEX "BookEntityCard_bookId_contentVersionId_idx" ON "BookEntityCard"("bookId", "contentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "BookEntityCard_contentVersionId_entityId_key" ON "BookEntityCard"("contentVersionId", "entityId");

-- CreateIndex
CREATE INDEX "BookSceneCard_bookId_contentVersionId_idx" ON "BookSceneCard"("bookId", "contentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "BookSceneCard_contentVersionId_sceneId_key" ON "BookSceneCard"("contentVersionId", "sceneId");

-- CreateIndex
CREATE INDEX "BookRelationCard_bookId_contentVersionId_idx" ON "BookRelationCard"("bookId", "contentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "BookRelationCard_contentVersionId_relationId_key" ON "BookRelationCard"("contentVersionId", "relationId");

-- CreateIndex
CREATE INDEX "BookTimelineSlice_bookId_contentVersionId_idx" ON "BookTimelineSlice"("bookId", "contentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "BookTimelineSlice_contentVersionId_sliceKey_key" ON "BookTimelineSlice"("contentVersionId", "sliceKey");

-- CreateIndex
CREATE INDEX "BookQuoteSlice_bookId_contentVersionId_idx" ON "BookQuoteSlice"("bookId", "contentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "BookQuoteSlice_contentVersionId_quoteId_key" ON "BookQuoteSlice"("contentVersionId", "quoteId");

-- CreateIndex
CREATE INDEX "BookSearchDocument_bookId_contentVersionId_documentType_idx" ON "BookSearchDocument"("bookId", "contentVersionId", "documentType");

-- CreateIndex
CREATE UNIQUE INDEX "BookSearchDocument_contentVersionId_documentType_documentId_key" ON "BookSearchDocument"("contentVersionId", "documentType", "documentId");

-- CreateIndex
CREATE INDEX "BookEvidenceHit_bookId_contentVersionId_subjectType_subject_idx" ON "BookEvidenceHit"("bookId", "contentVersionId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "BookPresenceMap_bookId_contentVersionId_sceneId_idx" ON "BookPresenceMap"("bookId", "contentVersionId", "sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "BookPresenceMap_contentVersionId_entityId_sceneId_key" ON "BookPresenceMap"("contentVersionId", "entityId", "sceneId");

-- CreateIndex
CREATE UNIQUE INDEX "BookProcessingReport_contentVersionId_key" ON "BookProcessingReport"("contentVersionId");

-- CreateIndex
CREATE INDEX "BookProcessingReport_bookId_coverage_idx" ON "BookProcessingReport"("bookId", "coverage");

-- AddForeignKey
ALTER TABLE "BookContentVersion" ADD CONSTRAINT "BookContentVersion_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookAnalysisRun" ADD CONSTRAINT "BookAnalysisRun_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookStageExecution" ADD CONSTRAINT "BookStageExecution_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookValidationFailure" ADD CONSTRAINT "BookValidationFailure_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSourceChapter" ADD CONSTRAINT "BookSourceChapter_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSourceParagraph" ADD CONSTRAINT "BookSourceParagraph_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookAnalysisWindow" ADD CONSTRAINT "BookAnalysisWindow_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookObservation" ADD CONSTRAINT "BookObservation_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookCanonicalEntity" ADD CONSTRAINT "BookCanonicalEntity_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookCanonicalAlias" ADD CONSTRAINT "BookCanonicalAlias_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookCanonicalScene" ADD CONSTRAINT "BookCanonicalScene_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookCanonicalEvent" ADD CONSTRAINT "BookCanonicalEvent_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookTimelineEdge" ADD CONSTRAINT "BookTimelineEdge_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookCanonicalRelation" ADD CONSTRAINT "BookCanonicalRelation_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookCanonicalQuote" ADD CONSTRAINT "BookCanonicalQuote_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookCanonicalSummary" ADD CONSTRAINT "BookCanonicalSummary_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEntityCard" ADD CONSTRAINT "BookEntityCard_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSceneCard" ADD CONSTRAINT "BookSceneCard_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookRelationCard" ADD CONSTRAINT "BookRelationCard_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookTimelineSlice" ADD CONSTRAINT "BookTimelineSlice_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookQuoteSlice" ADD CONSTRAINT "BookQuoteSlice_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookSearchDocument" ADD CONSTRAINT "BookSearchDocument_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookEvidenceHit" ADD CONSTRAINT "BookEvidenceHit_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookPresenceMap" ADD CONSTRAINT "BookPresenceMap_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookProcessingReport" ADD CONSTRAINT "BookProcessingReport_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
