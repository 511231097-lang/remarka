ALTER TABLE "Document"
ADD COLUMN "richContent" JSONB NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb;
