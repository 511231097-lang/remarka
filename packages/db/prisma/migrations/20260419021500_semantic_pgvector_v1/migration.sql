CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "BookSceneEmbedding"
ADD COLUMN IF NOT EXISTS "vector" vector(768);

ALTER TABLE "BookParagraphEmbedding"
ADD COLUMN IF NOT EXISTS "vector" vector(768);

UPDATE "BookSceneEmbedding"
SET "vector" = CAST("vectorJson"::text AS vector(768))
WHERE "vector" IS NULL
  AND "dimensions" = 768;

UPDATE "BookParagraphEmbedding"
SET "vector" = CAST("vectorJson"::text AS vector(768))
WHERE "vector" IS NULL
  AND "dimensions" = 768;

CREATE INDEX IF NOT EXISTS "BookSceneEmbedding_vector_hnsw_idx"
  ON "BookSceneEmbedding"
  USING hnsw ("vector" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "BookParagraphEmbedding_vector_hnsw_idx"
  ON "BookParagraphEmbedding"
  USING hnsw ("vector" vector_cosine_ops);
