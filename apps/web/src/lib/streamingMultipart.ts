import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import busboy from "busboy";

export class MultipartUploadError extends Error {
  status: number;
  field?: string;

  constructor(status: number, message: string, field?: string) {
    super(message);
    this.name = "MultipartUploadError";
    this.status = status;
    this.field = field;
  }
}

export interface TempUploadedFile {
  fieldName: string;
  fileName: string;
  mimeType: string;
  tempPath: string;
  sizeBytes: number;
  sha256: string;
}

export interface StreamedMultipart {
  fields: Map<string, string[]>;
  files: TempUploadedFile[];
  cleanup: () => Promise<void>;
}

interface StreamMultipartOptions {
  fileFieldNames: readonly string[];
  maxFiles: number;
  maxFileSizeBytes: number;
  tempPrefix: string;
  maxFieldSizeBytes?: number;
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

function requestBodyToNodeStream(request: Request): Readable {
  if (!request.body) {
    throw new MultipartUploadError(400, "Request body is required");
  }
  return Readable.fromWeb(request.body as unknown as import("node:stream/web").ReadableStream);
}

function fieldValues(fields: Map<string, string[]>, name: string): string[] {
  return fields.get(name) ?? [];
}

export function getMultipartField(fields: Map<string, string[]>, name: string, maxLen: number): string {
  const raw = fieldValues(fields, name)[0];
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, maxLen);
}

export function getOptionalMultipartField(fields: Map<string, string[]>, name: string, maxLen: number): string | null {
  const value = getMultipartField(fields, name, maxLen);
  return value || null;
}

export async function parseStreamingMultipart(request: Request, options: StreamMultipartOptions): Promise<StreamedMultipart> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    throw new MultipartUploadError(415, "Content-Type must be multipart/form-data");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${options.tempPrefix}-`));
  const fields = new Map<string, string[]>();
  const files: TempUploadedFile[] = [];
  const allowedFileFields = new Set(options.fileFieldNames);
  const fileWrites: Promise<void>[] = [];
  let filesLimitExceeded = false;

  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  try {
    const parser = busboy({
      headers: { "content-type": contentType },
      limits: {
        files: options.maxFiles,
        fileSize: options.maxFileSizeBytes,
        fieldSize: options.maxFieldSizeBytes ?? 16 * 1024,
      },
    });

    const parserDone = new Promise<void>((resolve, reject) => {
      parser.on("field", (name: string, value: string) => {
        const list = fields.get(name) ?? [];
        list.push(value);
        fields.set(name, list);
      });

      parser.on("filesLimit", () => {
        filesLimitExceeded = true;
      });

      parser.on("file", (fieldName: string, fileStream: NodeJS.ReadableStream, info: { filename?: string; mimeType?: string }) => {
        if (!allowedFileFields.has(fieldName)) {
          fileStream.resume();
          return;
        }

        const fileName = sanitizeFileName(info.filename || "file.bin");
        if (!fileName) {
          fileStream.resume();
          return;
        }

        const tempPath = path.join(tempDir, `${randomUUID()}-${fileName}`);
        const hash = createHash("sha256");
        let sizeBytes = 0;
        let tooLarge = false;

        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            sizeBytes += chunk.byteLength;
            hash.update(chunk);
            callback(null, chunk);
          },
        });

        fileStream.on("limit", () => {
          tooLarge = true;
        });

        const write = pipeline(fileStream, meter, createWriteStream(tempPath)).then(() => {
          if (tooLarge || sizeBytes > options.maxFileSizeBytes) {
            throw new MultipartUploadError(413, `File "${fileName}" exceeds size limit`, fieldName);
          }
          files.push({
            fieldName,
            fileName,
            mimeType: String(info.mimeType || "application/octet-stream").toLowerCase(),
            tempPath,
            sizeBytes,
            sha256: hash.digest("hex"),
          });
        });
        fileWrites.push(write);
      });

      parser.on("error", reject);
      parser.on("finish", resolve);
    });

    await pipeline(requestBodyToNodeStream(request), parser);
    await parserDone;
    await Promise.all(fileWrites);

    if (filesLimitExceeded) {
      throw new MultipartUploadError(400, `Too many files. Max ${options.maxFiles}`);
    }

    return { fields, files, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
