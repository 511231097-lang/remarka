// Storage для вложений к жалобам правообладателей. Отдельный prefix
// относительно books-bucket'а — чтобы LegalOps мог spis'ать всё по
// одному префиксу при необходимости (e-discovery, retention).
//
// Конфиг env-driven, аналогично BOOKS_STORAGE_PROVIDER в apps/web/src/app/api/books/route.ts.
// На проде ставим S3, локально — local FS.

import path from "node:path";
import {
  LocalBlobStore,
  S3BlobStore,
  type BlobStore,
} from "@remarka/db";

const DEFAULT_LOCAL_BLOB_ROOT = "/tmp/remarka-imports";
const DEFAULT_S3_REGION = "us-east-1";
const DEFAULT_S3_KEY_PREFIX = "remarka/copyright-complaints";

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveLocalBlobRoot(): string {
  const importRoot = String(process.env.IMPORT_BLOB_DIR || DEFAULT_LOCAL_BLOB_ROOT).trim() || DEFAULT_LOCAL_BLOB_ROOT;
  const dir = String(process.env.COPYRIGHT_COMPLAINTS_LOCAL_DIR || `${importRoot}/copyright-complaints`).trim();
  return dir || `${importRoot}/copyright-complaints`;
}

export function resolveCopyrightComplaintsBlobStore(): BlobStore {
  // По умолчанию переиспользуем настройки books-стораджа — у нас один
  // S3-провайдер на инстанс. Если понадобится отдельный bucket, можно
  // выставить COPYRIGHT_COMPLAINTS_STORAGE_PROVIDER явно.
  const provider = String(
    process.env.COPYRIGHT_COMPLAINTS_STORAGE_PROVIDER ||
      process.env.BOOKS_STORAGE_PROVIDER ||
      "local",
  )
    .trim()
    .toLowerCase();

  if (provider === "s3") {
    const bucket = String(
      process.env.COPYRIGHT_COMPLAINTS_S3_BUCKET ||
        process.env.BOOKS_S3_BUCKET ||
        "",
    ).trim();
    if (!bucket) {
      throw new Error(
        "COPYRIGHT_COMPLAINTS_S3_BUCKET (or fallback BOOKS_S3_BUCKET) is required for s3 provider",
      );
    }

    const accessKeyId = String(
      process.env.COPYRIGHT_COMPLAINTS_S3_ACCESS_KEY_ID ||
        process.env.BOOKS_S3_ACCESS_KEY_ID ||
        "",
    ).trim();
    const secretAccessKey = String(
      process.env.COPYRIGHT_COMPLAINTS_S3_SECRET_ACCESS_KEY ||
        process.env.BOOKS_S3_SECRET_ACCESS_KEY ||
        "",
    ).trim();
    const sessionToken = String(
      process.env.COPYRIGHT_COMPLAINTS_S3_SESSION_TOKEN ||
        process.env.BOOKS_S3_SESSION_TOKEN ||
        "",
    ).trim() || undefined;

    return new S3BlobStore({
      bucket,
      region:
        String(
          process.env.COPYRIGHT_COMPLAINTS_S3_REGION ||
            process.env.BOOKS_S3_REGION ||
            DEFAULT_S3_REGION,
        ).trim() || DEFAULT_S3_REGION,
      endpoint:
        String(
          process.env.COPYRIGHT_COMPLAINTS_S3_ENDPOINT ||
            process.env.BOOKS_S3_ENDPOINT ||
            "",
        ).trim() || undefined,
      keyPrefix:
        String(process.env.COPYRIGHT_COMPLAINTS_S3_KEY_PREFIX || DEFAULT_S3_KEY_PREFIX).trim() ||
        DEFAULT_S3_KEY_PREFIX,
      forcePathStyle: parseBooleanEnv(
        process.env.COPYRIGHT_COMPLAINTS_S3_FORCE_PATH_STYLE ?? process.env.BOOKS_S3_FORCE_PATH_STYLE,
        true,
      ),
      credentials:
        accessKeyId && secretAccessKey
          ? {
              accessKeyId,
              secretAccessKey,
              sessionToken,
            }
          : undefined,
      provider: "s3",
    });
  }

  return new LocalBlobStore({
    rootDir: path.resolve(resolveLocalBlobRoot()),
    provider: "local",
  });
}

export interface CopyrightAttachmentRecord {
  storageProvider: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
}
