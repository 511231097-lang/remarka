ALTER TYPE "BookAnalyzerType" ADD VALUE IF NOT EXISTS 'core_window_scan';
ALTER TYPE "BookAnalyzerType" ADD VALUE IF NOT EXISTS 'core_merge';
ALTER TYPE "BookAnalyzerType" ADD VALUE IF NOT EXISTS 'core_profiles';
ALTER TYPE "BookAnalyzerType" ADD VALUE IF NOT EXISTS 'core_quotes_finalize';
ALTER TYPE "BookAnalyzerType" ADD VALUE IF NOT EXISTS 'core_literary';

CREATE TABLE IF NOT EXISTS "BookExpertCore" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "snapshotJson" JSONB NOT NULL,
  "generatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookExpertCore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookExpertCore_bookId_key" ON "BookExpertCore"("bookId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'BookExpertCore_bookId_fkey'
      AND table_name = 'BookExpertCore'
  ) THEN
    ALTER TABLE "BookExpertCore"
      ADD CONSTRAINT "BookExpertCore_bookId_fkey"
      FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
