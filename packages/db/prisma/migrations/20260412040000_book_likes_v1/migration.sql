CREATE TABLE "BookLike" (
  "bookId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BookLike_pkey" PRIMARY KEY ("bookId", "userId")
);

CREATE INDEX "BookLike_userId_createdAt_idx" ON "BookLike"("userId", "createdAt");
CREATE INDEX "BookLike_bookId_createdAt_idx" ON "BookLike"("bookId", "createdAt");

ALTER TABLE "BookLike"
ADD CONSTRAINT "BookLike_bookId_fkey"
FOREIGN KEY ("bookId") REFERENCES "Book"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookLike"
ADD CONSTRAINT "BookLike_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
