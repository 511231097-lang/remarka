ALTER TYPE "BookAnalyzerType" ADD VALUE IF NOT EXISTS 'literary';

CREATE TABLE "BookLiteraryAnalysis" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "sectionsJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookLiteraryAnalysis_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookLiteraryAnalysis_bookId_key" ON "BookLiteraryAnalysis"("bookId");

ALTER TABLE "BookLiteraryAnalysis"
ADD CONSTRAINT "BookLiteraryAnalysis_bookId_fkey"
FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
