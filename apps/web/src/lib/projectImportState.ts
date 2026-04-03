import { LocalBlobStore, prisma } from "@remarka/db";
import type { Prisma } from "@prisma/client";
import {
  BookImportError,
  detectBookFormatFromFileName,
  extractSingleFb2FromZip,
  inferBookTitleFromFileName,
  ProjectImportPayloadSchema,
  type BookFormat,
  type ProjectImportPayload,
  EMPTY_RICH_TEXT_DOCUMENT,
} from "@remarka/contracts";

const DEFAULT_CHAPTER_TITLE = "Новая глава";
const DEFAULT_PROJECT_TITLE = "Новая книга";

function getImportBlobDir(): string {
  return String(process.env.IMPORT_BLOB_DIR || "/tmp/remarka-imports").trim() || "/tmp/remarka-imports";
}

function getMaxFileBytes(): number {
  const fallback = 25 * 1024 * 1024;
  const raw = String(process.env.IMPORT_MAX_FILE_BYTES || "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getMaxZipUncompressedBytes(): number {
  const fallback = 50 * 1024 * 1024;
  const raw = String(process.env.IMPORT_MAX_ZIP_UNCOMPRESSED_BYTES || "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export class ImportValidationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ImportValidationError";
    this.code = code;
  }
}

function serializeProjectImport(run: {
  id: string;
  projectId: string;
  format: BookFormat;
  state: "queued" | "running" | "completed" | "failed";
  stage:
    | "queued"
    | "loading_source"
    | "parsing"
    | "persisting"
    | "scheduling_analysis"
    | "completed"
    | "failed";
  error: string | null;
  chapterCount: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ProjectImportPayload {
  return ProjectImportPayloadSchema.parse({
    id: run.id,
    projectId: run.projectId,
    format: run.format,
    state: run.state,
    stage: run.stage,
    error: run.error,
    chapterCount: run.chapterCount,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  });
}

function normalizeTitle(input: string | null | undefined): string {
  return String(input || "").trim();
}

export interface CreateProjectImportInput {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  requestedTitle?: string | null;
  requestedDescription?: string | null;
}

export async function createProjectImportFromUpload(input: CreateProjectImportInput): Promise<{
  project: {
    id: string;
    title: string;
    description: string | null;
    chapters: Array<{
      id: string;
      projectId: string;
      title: string;
      orderIndex: number;
      createdAt: Date;
      updatedAt: Date;
    }>;
    createdAt: Date;
    updatedAt: Date;
  };
  projectImport: ProjectImportPayload;
}> {
  const fileName = String(input.fileName || "").trim();
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);

  if (!fileName) {
    throw new ImportValidationError("IMPORT_INVALID_FILE", "Book file name is required");
  }

  if (!bytes.byteLength) {
    throw new ImportValidationError("IMPORT_EMPTY_FILE", "Book file is empty");
  }

  const format = detectBookFormatFromFileName(fileName);
  if (!format) {
    throw new ImportValidationError("IMPORT_UNSUPPORTED_FORMAT", "Only .fb2 and .fb2.zip files are supported");
  }

  const maxFileBytes = getMaxFileBytes();
  if (bytes.byteLength > maxFileBytes) {
    throw new ImportValidationError("IMPORT_FILE_TOO_LARGE", `Book file exceeds ${maxFileBytes} bytes limit`);
  }

  if (format === "fb2_zip") {
    await extractSingleFb2FromZip(bytes, {
      maxUncompressedBytes: getMaxZipUncompressedBytes(),
    });
  }

  const requestedTitle = normalizeTitle(input.requestedTitle);
  const requestedDescription = normalizeTitle(input.requestedDescription) || null;
  const fallbackTitle = inferBookTitleFromFileName(fileName) || DEFAULT_PROJECT_TITLE;
  const projectTitle = requestedTitle || fallbackTitle;
  const titleProvided = Boolean(requestedTitle);

  const blobStore = new LocalBlobStore({
    rootDir: getImportBlobDir(),
    provider: "local",
  });

  const blob = await blobStore.put({
    bytes,
    fileName,
  });

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const project = await tx.project.create({
        data: {
          title: projectTitle,
          description: requestedDescription,
        },
      });

      const firstChapter = await tx.chapter.create({
        data: {
          projectId: project.id,
          title: DEFAULT_CHAPTER_TITLE,
          orderIndex: 0,
        },
      });

      await tx.document.create({
        data: {
          projectId: project.id,
          chapterId: firstChapter.id,
          content: "",
          richContent: EMPTY_RICH_TEXT_DOCUMENT as unknown as Prisma.InputJsonValue,
          contentVersion: 0,
          currentRunId: null,
        },
      });

      const sourceAsset = await tx.sourceAsset.create({
        data: {
          provider: blob.provider,
          storageKey: blob.storageKey,
          fileName,
          mimeType: String(input.mimeType || "application/octet-stream").trim() || "application/octet-stream",
          sizeBytes: blob.sizeBytes,
          sha256: blob.sha256,
        },
      });

      const projectImport = await tx.projectImport.create({
        data: {
          projectId: project.id,
          sourceAssetId: sourceAsset.id,
          format,
          state: "queued",
          stage: "queued",
          metadataJson: {
            requestedTitle: requestedTitle || null,
            titleProvided,
            uploadedFileName: fileName,
            uploadedAt: new Date().toISOString(),
          },
        },
      });

      await tx.outbox.create({
        data: {
          aggregateType: "project_import",
          aggregateId: projectImport.id,
          eventType: "project.import.requested",
          payloadJson: {
            importId: projectImport.id,
            projectId: project.id,
          },
        },
      });

      return {
        project: {
          ...project,
          chapters: [firstChapter],
        },
        projectImport,
      };
    });

    return {
      project: result.project,
      projectImport: serializeProjectImport(result.projectImport),
    };
  } catch (error) {
    await blobStore.delete(blob.storageKey).catch(() => undefined);

    if (error instanceof BookImportError || error instanceof ImportValidationError) {
      throw error;
    }

    throw error;
  }
}

export async function getLatestProjectImport(projectId: string): Promise<ProjectImportPayload | null> {
  const latest = await prisma.projectImport.findFirst({
    where: { projectId },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      projectId: true,
      format: true,
      state: true,
      stage: true,
      error: true,
      chapterCount: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return latest ? serializeProjectImport(latest) : null;
}

export function serializeLatestImportForProject(project: {
  projectImports?: Array<{
    id: string;
    projectId: string;
    format: BookFormat;
    state: "queued" | "running" | "completed" | "failed";
    stage:
      | "queued"
      | "loading_source"
      | "parsing"
      | "persisting"
      | "scheduling_analysis"
      | "completed"
      | "failed";
    error: string | null;
    chapterCount: number | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
}): ProjectImportPayload | null {
  const latest = Array.isArray(project.projectImports) ? project.projectImports[0] : null;
  return latest ? serializeProjectImport(latest) : null;
}
