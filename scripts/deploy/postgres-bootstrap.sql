-- postgres-bootstrap.sql
--
-- One-shot, idempotent setup applied to the managed Postgres after
-- `prisma migrate deploy` has created the schema. Run with:
--
--   psql "$DATABASE_URL" -f scripts/deploy/postgres-bootstrap.sql
--
-- Safe to re-run: each statement uses IF NOT EXISTS / IF EXISTS guards.
--
-- The Timeweb DBaaS instance already has the relevant extensions enabled at
-- the cluster level, but we re-create them per database to be self-contained.

BEGIN;

-- pgvector ships its extension under the name `vector` (not `pgvector`).
-- This is the upstream-canonical name and works on every provider that
-- ships the extension. The pgvector author's repo confirms it:
--   https://github.com/pgvector/pgvector#installation
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram index support — used by lexical retrieval / fuzzy entity match.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- pg_stat_statements may be installed cluster-wide on managed PG; per-DB
-- CREATE EXTENSION can fail with insufficient_privilege (the user lacks
-- CREATE on the system schema). Treat that as harmless.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'pg_stat_statements: insufficient_privilege, skipping (likely already provided cluster-wide).';
    WHEN feature_not_supported THEN
        RAISE NOTICE 'pg_stat_statements: feature_not_supported, skipping.';
END
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- HNSW indexes on vector columns.
--
-- Prisma uses Unsupported("vector(768)") for these columns, so it never emits
-- HNSW indexes itself. We create them here. m=16, ef_construction=64 is the
-- pgvector recommendation for 768-dim cosine search, balancing build time vs
-- recall (raise ef_construction to 128 for better recall at the cost of
-- ~2x longer build).
--
-- IF NOT EXISTS is supported on CREATE INDEX since PG 9.5, so re-running
-- is cheap — Postgres skips creation when the named index is present.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS book_paragraph_embedding_vector_hnsw
    ON "BookParagraphEmbedding"
    USING hnsw ("vector" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS book_scene_embedding_vector_hnsw
    ON "BookSceneEmbedding"
    USING hnsw ("vector" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS book_evidence_fragment_embedding_vector_hnsw
    ON "BookEvidenceFragmentEmbedding"
    USING hnsw ("vector" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Refresh planner stats after creating indexes so query plans pick them up.
ANALYZE "BookParagraphEmbedding";
ANALYZE "BookSceneEmbedding";
ANALYZE "BookEvidenceFragmentEmbedding";
