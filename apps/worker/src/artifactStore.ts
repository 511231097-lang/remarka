import path from "node:path";
import {
  LocalBlobStore,
  S3BlobStore,
  type BlobPutResult,
  type BlobStore,
} from "@remarka/db";
import { workerConfig } from "./config";
import { logger } from "./logger";

export interface RunArtifactRecord {
  phase: "entity_pass" | "act_pass" | "appearance_pass" | "mention_completion";
  label: string;
  provider: string;
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

const artifactBlobStore: BlobStore | null = (() => {
  if (!workerConfig.artifacts.enabled) return null;

  if (workerConfig.artifacts.storageProvider === "s3") {
    return new S3BlobStore({
      bucket: workerConfig.artifacts.s3.bucket,
      region: workerConfig.artifacts.s3.region,
      endpoint: workerConfig.artifacts.s3.endpoint || undefined,
      keyPrefix: workerConfig.artifacts.s3.keyPrefix,
      forcePathStyle: workerConfig.artifacts.s3.forcePathStyle,
      credentials:
        workerConfig.artifacts.s3.accessKeyId && workerConfig.artifacts.s3.secretAccessKey
          ? {
              accessKeyId: workerConfig.artifacts.s3.accessKeyId,
              secretAccessKey: workerConfig.artifacts.s3.secretAccessKey,
              sessionToken: workerConfig.artifacts.s3.sessionToken || undefined,
            }
          : undefined,
      provider: "s3",
    });
  }

  return new LocalBlobStore({
    rootDir: workerConfig.artifacts.localDir,
    provider: "local",
  });
})();

if (artifactBlobStore) {
  if (workerConfig.artifacts.storageProvider === "s3") {
    logger.info(
      {
        provider: "s3",
        bucket: workerConfig.artifacts.s3.bucket,
        region: workerConfig.artifacts.s3.region,
        endpoint: workerConfig.artifacts.s3.endpoint || null,
        keyPrefix: workerConfig.artifacts.s3.keyPrefix,
        forcePathStyle: workerConfig.artifacts.s3.forcePathStyle,
      },
      "Artifact blob store initialized"
    );
  } else {
    logger.info(
      {
        provider: "local",
        rootDir: workerConfig.artifacts.localDir,
      },
      "Artifact blob store initialized"
    );
  }
} else {
  logger.info({ enabled: false }, "Artifact blob store disabled");
}

export function getArtifactBlobStore(): BlobStore | null {
  return artifactBlobStore;
}

export async function persistRunArtifact(params: {
  projectId: string;
  runId: string;
  phase: "entity_pass" | "act_pass" | "appearance_pass" | "mention_completion";
  label: string;
  payload: unknown;
}): Promise<RunArtifactRecord | null> {
  const store = artifactBlobStore;
  if (!store) return null;
  const startedAtMs = Date.now();

  const prefix = path.posix.join("runs", params.projectId, params.runId, params.phase);
  const fileName = `${params.label}.json`;
  const bytes = new TextEncoder().encode(JSON.stringify(params.payload, null, 2));

  let blob: BlobPutResult;
  try {
    blob = await store.put({
      bytes,
      fileName,
      prefix,
    });
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    logger.warn(
      {
        err: error,
        runId: params.runId,
        projectId: params.projectId,
        phase: params.phase,
        label: params.label,
        durationMs,
      },
      "Failed to persist run artifact"
    );
    return null;
  }

  const durationMs = Math.max(0, Date.now() - startedAtMs);
  logger.info(
    {
      runId: params.runId,
      projectId: params.projectId,
      phase: params.phase,
      label: params.label,
      provider: blob.provider,
      storageKey: blob.storageKey,
      sizeBytes: blob.sizeBytes,
      sha256: blob.sha256,
      durationMs,
    },
    "Run artifact persisted"
  );

  return {
    phase: params.phase,
    label: params.label,
    provider: blob.provider,
    storageKey: blob.storageKey,
    sizeBytes: blob.sizeBytes,
    sha256: blob.sha256,
    createdAt: new Date().toISOString(),
  };
}
