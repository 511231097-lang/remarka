-- Subscription tier infrastructure. Initial state: every existing user is
-- `free`. tierActivatedAt is null for everyone (Free uses createdAt as
-- period anchor). Manual upgrade to plus is done via psql or admin tooling
-- until ЮKassa integration lands.

CREATE TYPE "UserTier" AS ENUM ('free', 'plus');

-- createdAt/updatedAt didn't exist on User yet — backfill createdAt with
-- the timestamp of the earliest related record, falling back to NOW() for
-- accounts that have no traces. updatedAt = createdAt for the seed.
ALTER TABLE "User"
  ADD COLUMN "tier"            "UserTier"   NOT NULL DEFAULT 'free',
  ADD COLUMN "tierActivatedAt" TIMESTAMP(3),
  ADD COLUMN "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Best-effort backfill of createdAt: take MIN of any related record. Falls
-- back to the column default (NOW) when the user has zero related rows.
UPDATE "User" u
SET "createdAt" = COALESCE(
  (SELECT MIN(b."createdAt") FROM "Book" b WHERE b."ownerUserId" = u.id),
  (SELECT MIN(t."createdAt") FROM "BookChatThread" t WHERE t."ownerUserId" = u.id),
  (SELECT MIN(c."acceptedAt") FROM "LegalConsent" c WHERE c."userId" = u.id),
  u."createdAt"
);

UPDATE "User" SET "updatedAt" = "createdAt";

CREATE INDEX "User_tier_idx" ON "User"("tier");
