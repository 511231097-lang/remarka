ALTER TABLE "Book"
ADD COLUMN "chapterCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "BookChapter" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "orderIndex" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "previewText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookChapter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookChapter_bookId_orderIndex_key" ON "BookChapter"("bookId", "orderIndex");
CREATE INDEX "BookChapter_bookId_orderIndex_idx" ON "BookChapter"("bookId", "orderIndex");

ALTER TABLE "BookChapter"
ADD CONSTRAINT "BookChapter_bookId_fkey"
FOREIGN KEY ("bookId") REFERENCES "Book"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
