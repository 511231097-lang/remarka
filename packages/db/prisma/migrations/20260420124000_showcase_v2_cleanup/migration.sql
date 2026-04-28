-- One-time cleanup of legacy showcase artifacts.
DELETE FROM "BookSummaryArtifact"
WHERE "kind" = 'book_brief'
  AND "key" = 'showcase_v1';
