import { LocalBlobStore, S3BlobStore, createArtifactBlobStoreFromEnv, createBookTextCorpusBlobStoreFromEnv } from "@remarka/db";

// Helpers for purging the blob storage that hangs off a book — extracted so
// both the per-book DELETE route and the account-deletion route can reuse
// the same cleanup logic without duplicating env wiring.

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveLocalBlobRoots(): string[] {
  const importRoot = String(process.env.IMPORT_BLOB_DIR || "/tmp/remarka-imports").trim() || "/tmp/remarka-imports";
  const booksRoot = String(process.env.BOOKS_LOCAL_DIR || `${importRoot}/books`).trim() || `${importRoot}/books`;
  return Array.from(new Set([booksRoot, importRoot]));
}

/**
 * Remove a book's original uploaded file from object storage.
 *
 * Returns silently on missing keys / unconfigured stores — the caller is
 * expected to wrap in try/catch for hard failures and log there. Cleanup
 * errors should never block a logical delete: it's better to leave an
 * orphan blob than to refuse the user's deletion request.
 */
export async function deleteBookBlob(params: {
  storageProvider: string;
  storageKey: string;
}): Promise<void> {
  const storageProvider = String(params.storageProvider || "").trim().toLowerCase();
  const storageKey = String(params.storageKey || "").trim();
  if (!storageKey) return;

  if (storageProvider === "s3") {
    const bucket = String(process.env.BOOKS_S3_BUCKET || "").trim();
    if (!bucket) return;

    const store = new S3BlobStore({
      bucket,
      region: String(process.env.BOOKS_S3_REGION || "us-east-1").trim() || "us-east-1",
      endpoint: String(process.env.BOOKS_S3_ENDPOINT || "").trim() || undefined,
      keyPrefix: String(process.env.BOOKS_S3_KEY_PREFIX || "remarka/books").trim() || "remarka/books",
      forcePathStyle: parseBooleanEnv(process.env.BOOKS_S3_FORCE_PATH_STYLE, true),
      credentials:
        String(process.env.BOOKS_S3_ACCESS_KEY_ID || "").trim() &&
        String(process.env.BOOKS_S3_SECRET_ACCESS_KEY || "").trim()
          ? {
              accessKeyId: String(process.env.BOOKS_S3_ACCESS_KEY_ID || "").trim(),
              secretAccessKey: String(process.env.BOOKS_S3_SECRET_ACCESS_KEY || "").trim(),
              sessionToken: String(process.env.BOOKS_S3_SESSION_TOKEN || "").trim() || undefined,
            }
          : undefined,
      provider: "s3",
    });

    await store.delete(storageKey);
    return;
  }

  let lastError: unknown = null;
  for (const rootDir of resolveLocalBlobRoots()) {
    try {
      const store = new LocalBlobStore({
        rootDir,
        provider: "local",
      });
      await store.delete(storageKey);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    return;
  }
}

export async function deleteBookTextCorpusBlob(params: {
  storageKey: string | null | undefined;
}): Promise<void> {
  const storageKey = String(params.storageKey || "").trim();
  if (!storageKey) return;

  const store = createBookTextCorpusBlobStoreFromEnv();
  await store.delete(storageKey);
}

/**
 * Remove derived artifact payloads (analysis run intermediates, chat-run
 * traces) for a given bookId. Uses Promise.allSettled so a partial failure
 * doesn't abort the rest.
 */
export async function deleteArtifactPayloadsForBook(bookId: string): Promise<void> {
  const store = createArtifactBlobStoreFromEnv();
  await Promise.allSettled([
    store.deletePrefix(`analysis-runs/${bookId}`),
    store.deletePrefix(`chat-runs/${bookId}`),
  ]);
}

export async function deleteBookStoragePayloads(params: {
  bookId: string;
  storageProvider: string;
  storageKey: string;
  textCorpusStorageKey?: string | null;
}): Promise<void> {
  await Promise.allSettled([
    deleteBookBlob({
      storageProvider: params.storageProvider,
      storageKey: params.storageKey,
    }),
    deleteBookTextCorpusBlob({
      storageKey: params.textCorpusStorageKey,
    }),
    deleteArtifactPayloadsForBook(params.bookId),
  ]);
}
