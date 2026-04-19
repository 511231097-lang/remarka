import { gunzipSync, gzipSync } from "node:zlib";
import { LocalBlobStore, S3BlobStore, type BlobPutResult, type BlobStore } from "./blobStore";

const DEFAULT_IMPORT_BLOB_DIR = "/tmp/remarka-imports";
const DEFAULT_ARTIFACTS_KEY_PREFIX = "remarka/analysis-artifacts";

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function createArtifactBlobStoreFromEnv(): BlobStore {
  const importRoot = String(process.env.IMPORT_BLOB_DIR || DEFAULT_IMPORT_BLOB_DIR).trim() || DEFAULT_IMPORT_BLOB_DIR;
  const provider = String(process.env.ARTIFACTS_STORAGE_PROVIDER || "local").trim().toLowerCase();

  if (provider === "s3") {
    const bucket = String(process.env.ARTIFACTS_S3_BUCKET || "").trim();
    if (!bucket) {
      throw new Error("ARTIFACTS_S3_BUCKET is required for ARTIFACTS_STORAGE_PROVIDER=s3");
    }

    return new S3BlobStore({
      bucket,
      region: String(process.env.ARTIFACTS_S3_REGION || "us-east-1").trim() || "us-east-1",
      endpoint: String(process.env.ARTIFACTS_S3_ENDPOINT || "").trim() || undefined,
      keyPrefix: String(process.env.ARTIFACTS_S3_KEY_PREFIX || DEFAULT_ARTIFACTS_KEY_PREFIX).trim() || DEFAULT_ARTIFACTS_KEY_PREFIX,
      forcePathStyle: parseBooleanEnv(process.env.ARTIFACTS_S3_FORCE_PATH_STYLE, true),
      credentials:
        String(process.env.ARTIFACTS_S3_ACCESS_KEY_ID || "").trim() &&
        String(process.env.ARTIFACTS_S3_SECRET_ACCESS_KEY || "").trim()
          ? {
              accessKeyId: String(process.env.ARTIFACTS_S3_ACCESS_KEY_ID || "").trim(),
              secretAccessKey: String(process.env.ARTIFACTS_S3_SECRET_ACCESS_KEY || "").trim(),
              sessionToken: String(process.env.ARTIFACTS_S3_SESSION_TOKEN || "").trim() || undefined,
            }
          : undefined,
      provider: "s3",
    });
  }

  return new LocalBlobStore({
    rootDir:
      String(process.env.ANALYSIS_ARTIFACTS_LOCAL_DIR || `${importRoot}/analysis-artifacts`).trim() ||
      `${importRoot}/analysis-artifacts`,
    provider: "local",
  });
}

export function encodeArtifactPayload(payload: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return gzipSync(bytes);
}

export function decodeArtifactPayload(bytes: Uint8Array): unknown {
  const inflated = gunzipSync(Buffer.from(bytes));
  return JSON.parse(inflated.toString("utf-8"));
}

export async function putArtifactPayload(params: {
  store: BlobStore;
  prefix: string;
  fileName: string;
  payload: unknown;
}): Promise<BlobPutResult & { compression: string }> {
  const bytes = encodeArtifactPayload(params.payload);
  const stored = await params.store.put({
    bytes,
    fileName: params.fileName,
    prefix: params.prefix,
  });

  return {
    ...stored,
    compression: "gzip",
  };
}

export async function getArtifactPayload(params: {
  store: BlobStore;
  storageKey: string;
  compression?: string | null;
}): Promise<unknown> {
  const bytes = await params.store.get(params.storageKey);
  const compression = String(params.compression || "gzip").trim().toLowerCase();
  if (!compression || compression === "gzip") {
    return decodeArtifactPayload(bytes);
  }
  throw new Error(`Unsupported artifact compression: ${compression}`);
}
