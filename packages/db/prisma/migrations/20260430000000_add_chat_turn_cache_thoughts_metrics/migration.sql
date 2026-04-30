-- Add cache + thoughts token metrics to BookChatTurnMetric so we can:
-- 1) See how much of each turn's input was served from Vertex implicit/explicit cache
-- 2) Track how many "thinking" tokens (invisible in output but billed) were consumed
ALTER TABLE "BookChatTurnMetric"
  ADD COLUMN "modelCachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "modelThoughtsTokens" INTEGER NOT NULL DEFAULT 0;
