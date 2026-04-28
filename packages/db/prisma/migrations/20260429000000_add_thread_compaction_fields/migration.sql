-- AddCompactionFields: per-thread history compaction state.
--
-- When a chat thread grows beyond N pairs we replace the older turns with a
-- single lite-model summary persisted on the thread. Hysteresis avoids
-- re-summarizing on every turn. See ensureCompactedHistory in
-- apps/web/src/lib/bookChatService.ts.
--
-- Idempotent ALTERs so this migration is safe on databases where the columns
-- were already added out-of-band (early prod was bootstrapped with manual SQL
-- before this migration was authored).

ALTER TABLE "BookChatThread"
  ADD COLUMN IF NOT EXISTS "compactedHistory" TEXT,
  ADD COLUMN IF NOT EXISTS "compactedHistoryThroughMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "compactedHistoryUpdatedAt" TIMESTAMP(3);
