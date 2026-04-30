-- Purge ~44 unused models from old experiments (v1 analyzer, abandoned
-- canonical-graph V2, legacy session-based chat). No prod data exists,
-- so we just CASCADE-drop everything. The remaining schema is the V3
-- pipeline: Book → Chapter → Paragraph/Sentence/Scene → AnalysisArtifact
-- → SummaryArtifact + BookChatThread/BookChatThreadMessage for chat.
--
-- See docs/research/rag-audit-2026-04-30.md for the audit that flagged
-- these as zero-consumer.

DROP TABLE IF EXISTS "BookAnalysisWindow" CASCADE;
DROP TABLE IF EXISTS "BookCanonicalAlias" CASCADE;
DROP TABLE IF EXISTS "BookCanonicalEntity" CASCADE;
DROP TABLE IF EXISTS "BookCanonicalEvent" CASCADE;
DROP TABLE IF EXISTS "BookCanonicalQuote" CASCADE;
DROP TABLE IF EXISTS "BookCanonicalRelation" CASCADE;
DROP TABLE IF EXISTS "BookCanonicalScene" CASCADE;
DROP TABLE IF EXISTS "BookCanonicalSummary" CASCADE;
DROP TABLE IF EXISTS "BookCharacter" CASCADE;
DROP TABLE IF EXISTS "BookCharacterQuote" CASCADE;
DROP TABLE IF EXISTS "BookChatMessage" CASCADE;
DROP TABLE IF EXISTS "BookChatSession" CASCADE;
DROP TABLE IF EXISTS "BookChatSessionState" CASCADE;
DROP TABLE IF EXISTS "BookChunk" CASCADE;
DROP TABLE IF EXISTS "BookEntity" CASCADE;
DROP TABLE IF EXISTS "BookEntityAlias" CASCADE;
DROP TABLE IF EXISTS "BookEntityCard" CASCADE;
DROP TABLE IF EXISTS "BookEntityMembership" CASCADE;
DROP TABLE IF EXISTS "BookEvent" CASCADE;
DROP TABLE IF EXISTS "BookEventEdge" CASCADE;
DROP TABLE IF EXISTS "BookEventParticipant" CASCADE;
DROP TABLE IF EXISTS "BookEvidenceHit" CASCADE;
DROP TABLE IF EXISTS "BookEvidenceLink" CASCADE;
DROP TABLE IF EXISTS "BookExpertCore" CASCADE;
DROP TABLE IF EXISTS "BookLiteraryAnalysis" CASCADE;
DROP TABLE IF EXISTS "BookLocation" CASCADE;
DROP TABLE IF EXISTS "BookLocationQuote" CASCADE;
DROP TABLE IF EXISTS "BookMention" CASCADE;
DROP TABLE IF EXISTS "BookObservation" CASCADE;
DROP TABLE IF EXISTS "BookPresenceMap" CASCADE;
DROP TABLE IF EXISTS "BookProcessingReport" CASCADE;
DROP TABLE IF EXISTS "BookQuote" CASCADE;
DROP TABLE IF EXISTS "BookQuoteMention" CASCADE;
DROP TABLE IF EXISTS "BookQuoteSlice" CASCADE;
DROP TABLE IF EXISTS "BookQuoteTagLink" CASCADE;
DROP TABLE IF EXISTS "BookRelationCard" CASCADE;
DROP TABLE IF EXISTS "BookRelationEdge" CASCADE;
DROP TABLE IF EXISTS "BookSceneCard" CASCADE;
DROP TABLE IF EXISTS "BookSearchDocument" CASCADE;
DROP TABLE IF EXISTS "BookSourceChapter" CASCADE;
DROP TABLE IF EXISTS "BookSourceParagraph" CASCADE;
DROP TABLE IF EXISTS "BookTheme" CASCADE;
DROP TABLE IF EXISTS "BookThemeQuote" CASCADE;
DROP TABLE IF EXISTS "BookTimelineEdge" CASCADE;
DROP TABLE IF EXISTS "BookTimelineSlice" CASCADE;
DROP TABLE IF EXISTS "BookValidationFailure" CASCADE;

-- Drop the entityId column from BookSummaryArtifact (now an orphaned FK
-- pointing at the dropped BookEntity table). The column itself doesn't
-- have a remaining FK constraint after BookEntity is gone, so just drop
-- the column.
ALTER TABLE "BookSummaryArtifact" DROP COLUMN IF EXISTS "entityId";

-- Drop orphan enum types. Postgres won't drop enums automatically when
-- the only column using them is dropped, so list them explicitly.
DROP TYPE IF EXISTS "MentionType";
DROP TYPE IF EXISTS "AliasType";
DROP TYPE IF EXISTS "BookGraphEntityType";
DROP TYPE IF EXISTS "BookEventEdgeType";
DROP TYPE IF EXISTS "BookRelationEdgeType";
DROP TYPE IF EXISTS "BookEvidenceSubjectType";
DROP TYPE IF EXISTS "BookEvidenceRefType";
DROP TYPE IF EXISTS "BookQuoteType";
DROP TYPE IF EXISTS "BookQuoteTag";
DROP TYPE IF EXISTS "BookQuoteMentionKind";
DROP TYPE IF EXISTS "BookRefResolutionStatus";
DROP TYPE IF EXISTS "BookObservationType";
DROP TYPE IF EXISTS "BookObservationCertainty";
DROP TYPE IF EXISTS "BookObservationValidationStatus";
DROP TYPE IF EXISTS "BookCanonicalEntityStatus";
DROP TYPE IF EXISTS "BookTimelineOrder";
DROP TYPE IF EXISTS "BookSummaryTargetType";
DROP TYPE IF EXISTS "BookSummaryKind";
DROP TYPE IF EXISTS "BookCoverageStatus";
