DO $$
BEGIN
  CREATE TYPE "UserRole" AS ENUM ('user', 'admin');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "role" "UserRole" NOT NULL DEFAULT 'user';

CREATE INDEX IF NOT EXISTS "User_role_idx"
  ON "User"("role");

ALTER TABLE "BookChatThread"
  ADD COLUMN IF NOT EXISTS "ownerUserId" TEXT;

UPDATE "BookChatThread" AS thread
SET "ownerUserId" = book."ownerUserId"
FROM "Book" AS book
WHERE thread."bookId" = book."id"
  AND thread."ownerUserId" IS NULL;

ALTER TABLE "BookChatThread"
  ALTER COLUMN "ownerUserId" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'BookChatThread_ownerUserId_fkey'
  ) THEN
    ALTER TABLE "BookChatThread"
      ADD CONSTRAINT "BookChatThread_ownerUserId_fkey"
      FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "BookChatThread_ownerUserId_updatedAt_idx"
  ON "BookChatThread"("ownerUserId", "updatedAt");

UPDATE "User"
SET "role" = 'admin'::"UserRole"
WHERE lower("email") = 'maricooper1602@gmail.com';
