import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";

export interface BlobPutInput {
  bytes: Uint8Array;
  fileName: string;
  prefix?: string;
}

export interface BlobPutResult {
  provider: string;
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

export interface BlobStore {
  put(input: BlobPutInput): Promise<BlobPutResult>;
  get(storageKey: string): Promise<Uint8Array>;
  delete(storageKey: string): Promise<void>;
}

function sanitizeFileName(fileName: string): string {
  const base =
    String(fileName || "")
      .replace(/\\/g, "/")
      .split("/")
      .pop() || "file.bin";

  const sanitized = base
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

  return sanitized || "file.bin";
}

function toRelativeSafeKey(storageKey: string): string {
  const normalized = path.posix.normalize(String(storageKey || "").replace(/\\/g, "/"));
  if (!normalized || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw new Error("Invalid storage key");
  }
  return normalized;
}

function normalizePrefix(prefix: string | undefined): string {
  const raw = String(prefix || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (!raw) return "";
  return toRelativeSafeKey(raw);
}

async function getS3BodyBytes(body: GetObjectCommandOutput["Body"]): Promise<Uint8Array> {
  if (!body) return new Uint8Array();

  const bodyAny = body as any;
  if (typeof bodyAny.transformToByteArray === "function") {
    const value = await bodyAny.transformToByteArray();
    return value instanceof Uint8Array ? value : new Uint8Array(value);
  }

  if (typeof bodyAny[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of bodyAny as AsyncIterable<Uint8Array | Buffer | string>) {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else {
        chunks.push(chunk);
      }
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  if (body instanceof Uint8Array) {
    return body;
  }

  throw new Error("Unsupported S3 response body type");
}

export class LocalBlobStore implements BlobStore {
  private readonly rootDir: string;
  private readonly provider: string;

  constructor(options: { rootDir: string; provider?: string }) {
    this.rootDir = path.resolve(options.rootDir);
    this.provider = options.provider || "local";
  }

  private resolveAbsolute(storageKey: string): string {
    const safeKey = toRelativeSafeKey(storageKey);
    const absolute = path.resolve(this.rootDir, safeKey);
    const relative = path.relative(this.rootDir, absolute);

    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Storage key escapes blob root");
    }

    return absolute;
  }

  async put(input: BlobPutInput): Promise<BlobPutResult> {
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
    const safeName = sanitizeFileName(input.fileName);
    const prefix =
      normalizePrefix(input.prefix) || new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    const storageKey = path.posix.join(prefix, `${randomUUID()}-${safeName}`);
    const absolutePath = this.resolveAbsolute(storageKey);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, Buffer.from(bytes));

    return {
      provider: this.provider,
      storageKey,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async get(storageKey: string): Promise<Uint8Array> {
    const absolutePath = this.resolveAbsolute(storageKey);
    const content = await fs.readFile(absolutePath);
    return new Uint8Array(content);
  }

  async delete(storageKey: string): Promise<void> {
    const absolutePath = this.resolveAbsolute(storageKey);
    await fs.rm(absolutePath, { force: true });
  }
}

export class S3BlobStore implements BlobStore {
  private readonly provider: string;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly client: S3Client;

  constructor(options: {
    bucket: string;
    region?: string;
    endpoint?: string;
    forcePathStyle?: boolean;
    keyPrefix?: string;
    provider?: string;
    credentials?: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
  }) {
    this.bucket = String(options.bucket || "").trim();
    if (!this.bucket) {
      throw new Error("S3 bucket is required");
    }

    this.provider = options.provider || "s3";
    this.keyPrefix = normalizePrefix(options.keyPrefix);
    this.client = new S3Client({
      region: String(options.region || "us-east-1").trim() || "us-east-1",
      endpoint: String(options.endpoint || "").trim() || undefined,
      forcePathStyle: Boolean(options.forcePathStyle),
      credentials:
        options.credentials && options.credentials.accessKeyId && options.credentials.secretAccessKey
          ? {
              accessKeyId: options.credentials.accessKeyId,
              secretAccessKey: options.credentials.secretAccessKey,
              sessionToken: options.credentials.sessionToken,
            }
          : undefined,
    });
  }

  private toStorageKey(relativeKey: string): string {
    const safe = toRelativeSafeKey(relativeKey);
    return this.keyPrefix ? path.posix.join(this.keyPrefix, safe) : safe;
  }

  async put(input: BlobPutInput): Promise<BlobPutResult> {
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
    const safeName = sanitizeFileName(input.fileName);
    const prefix =
      normalizePrefix(input.prefix) || new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    const storageKey = this.toStorageKey(path.posix.join(prefix, `${randomUUID()}-${safeName}`));

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: Buffer.from(bytes),
      })
    );

    return {
      provider: this.provider,
      storageKey,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async get(storageKey: string): Promise<Uint8Array> {
    const key = toRelativeSafeKey(storageKey);
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
    return getS3BodyBytes(response.Body);
  }

  async delete(storageKey: string): Promise<void> {
    const key = toRelativeSafeKey(storageKey);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }
}
