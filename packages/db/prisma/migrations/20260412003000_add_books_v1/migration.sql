CREATE TABLE "Book" (
  "id" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "author" TEXT,
  "isPublic" BOOLEAN NOT NULL DEFAULT true,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "storageProvider" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "fileSha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Book_ownerUserId_createdAt_idx" ON "Book"("ownerUserId", "createdAt");
CREATE INDEX "Book_isPublic_createdAt_idx" ON "Book"("isPublic", "createdAt");

ALTER TABLE "Book"
ADD CONSTRAINT "Book_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
