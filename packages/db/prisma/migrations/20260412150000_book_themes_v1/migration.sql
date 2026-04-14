CREATE TABLE "BookTheme" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "development" TEXT NOT NULL,
  "mentionCount" INTEGER NOT NULL DEFAULT 0,
  "firstAppearanceChapterOrder" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookTheme_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookThemeQuote" (
  "id" TEXT NOT NULL,
  "bookThemeId" TEXT NOT NULL,
  "chapterOrderIndex" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "context" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookThemeQuote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookTheme_bookId_normalizedName_key"
  ON "BookTheme"("bookId", "normalizedName");
CREATE INDEX "BookTheme_bookId_mentionCount_desc_firstAppearance_idx"
  ON "BookTheme"("bookId", "mentionCount" DESC, "firstAppearanceChapterOrder" ASC, "name" ASC);

CREATE INDEX "BookThemeQuote_bookThemeId_chapterOrderIndex_idx"
  ON "BookThemeQuote"("bookThemeId", "chapterOrderIndex");

ALTER TABLE "BookTheme"
ADD CONSTRAINT "BookTheme_bookId_fkey"
FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookThemeQuote"
ADD CONSTRAINT "BookThemeQuote_bookThemeId_fkey"
FOREIGN KEY ("bookThemeId") REFERENCES "BookTheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
