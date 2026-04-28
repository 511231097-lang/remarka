CREATE TABLE "BookLocation" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "significance" TEXT NOT NULL,
  "mentionCount" INTEGER NOT NULL DEFAULT 0,
  "firstAppearanceChapterOrder" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookLocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookLocationQuote" (
  "id" TEXT NOT NULL,
  "bookLocationId" TEXT NOT NULL,
  "chapterOrderIndex" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "context" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookLocationQuote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookLocation_bookId_normalizedName_key"
  ON "BookLocation"("bookId", "normalizedName");
CREATE INDEX "BookLocation_bookId_mentionCount_desc_firstAppearance_idx"
  ON "BookLocation"("bookId", "mentionCount" DESC, "firstAppearanceChapterOrder" ASC, "name" ASC);

CREATE INDEX "BookLocationQuote_bookLocationId_chapterOrderIndex_idx"
  ON "BookLocationQuote"("bookLocationId", "chapterOrderIndex");

ALTER TABLE "BookLocation"
ADD CONSTRAINT "BookLocation_bookId_fkey"
FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookLocationQuote"
ADD CONSTRAINT "BookLocationQuote_bookLocationId_fkey"
FOREIGN KEY ("bookLocationId") REFERENCES "BookLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
