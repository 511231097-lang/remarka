UPDATE "BookSceneEmbedding"
SET "vector" = CAST("vectorJson"::text AS vector(768))
WHERE "vector" IS NULL
  AND "dimensions" = 768;

UPDATE "BookParagraphEmbedding"
SET "vector" = CAST("vectorJson"::text AS vector(768))
WHERE "vector" IS NULL
  AND "dimensions" = 768;

DELETE FROM "BookSceneEmbedding"
WHERE "vector" IS NULL;

DELETE FROM "BookParagraphEmbedding"
WHERE "vector" IS NULL;

ALTER TABLE "BookSceneEmbedding"
DROP COLUMN IF EXISTS "vectorJson";

ALTER TABLE "BookParagraphEmbedding"
DROP COLUMN IF EXISTS "vectorJson";
