ALTER TYPE "BookSummaryArtifactKind" ADD VALUE IF NOT EXISTS 'entity_summary';

ALTER TABLE "BookEntity"
  ADD COLUMN "metadataJson" JSONB;

ALTER TABLE "BookEvent"
  ADD COLUMN "metadataJson" JSONB;

ALTER TABLE "BookRelationEdge"
  ADD COLUMN "metadataJson" JSONB;

ALTER TABLE "BookQuoteMention"
  ADD COLUMN "entityId" TEXT;

CREATE TABLE "BookEntityMembership" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "collectionEntityId" TEXT NOT NULL,
  "memberEntityId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "sceneId" TEXT,
  "eventId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookEntityMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookEntityMembership_bookId_collectionEntityId_memberEntityId_role_key"
  ON "BookEntityMembership"("bookId", "collectionEntityId", "memberEntityId", "role");

CREATE INDEX "BookEntityMembership_bookId_collectionEntityId_idx"
  ON "BookEntityMembership"("bookId", "collectionEntityId");

CREATE INDEX "BookEntityMembership_bookId_memberEntityId_idx"
  ON "BookEntityMembership"("bookId", "memberEntityId");

CREATE INDEX "BookEntityMembership_sceneId_idx"
  ON "BookEntityMembership"("sceneId");

CREATE INDEX "BookEntityMembership_eventId_idx"
  ON "BookEntityMembership"("eventId");

CREATE INDEX "BookQuoteMention_entityId_idx"
  ON "BookQuoteMention"("entityId");

ALTER TABLE "BookQuoteMention"
  ADD CONSTRAINT "BookQuoteMention_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "BookEntity"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "BookEntityMembership"
  ADD CONSTRAINT "BookEntityMembership_bookId_fkey"
  FOREIGN KEY ("bookId") REFERENCES "Book"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "BookEntityMembership"
  ADD CONSTRAINT "BookEntityMembership_collectionEntityId_fkey"
  FOREIGN KEY ("collectionEntityId") REFERENCES "BookEntity"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "BookEntityMembership"
  ADD CONSTRAINT "BookEntityMembership_memberEntityId_fkey"
  FOREIGN KEY ("memberEntityId") REFERENCES "BookEntity"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "BookEntityMembership"
  ADD CONSTRAINT "BookEntityMembership_sceneId_fkey"
  FOREIGN KEY ("sceneId") REFERENCES "BookScene"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "BookEntityMembership"
  ADD CONSTRAINT "BookEntityMembership_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "BookEvent"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
