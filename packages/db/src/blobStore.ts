import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface BlobPutInput {
  bytes: Uint8Array;
  fileName: string;
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
    const prefix = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
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
