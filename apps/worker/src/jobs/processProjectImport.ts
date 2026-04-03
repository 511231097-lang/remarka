import { prisma, LocalBlobStore } from "@remarka/db";
import type { Prisma } from "@prisma/client";
import {
  buildPlainTextFromParsedChapter,
  buildRichContentFromParsedChapter,
  ensureParsedBookHasChapters,
  parseBook,
  type ParsedBook,
} from "@remarka/contracts";
import { workerConfig } from "../config";
import { logger } from "../logger";

interface ProcessProjectImportPayload {
  importId: string;
}

function safeErrorMessage(error: unknown): string {
  if (!error) return "Unknown import error";
  if (error instanceof Error) return error.message.slice(0, 2000);
  return String(error).slice(0, 2000);
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function updateImportStatus(
  importId: string,
  data: Prisma.ProjectImportUpdateManyMutationInput
) {
  await prisma.projectImport.updateMany({
    where: { id: importId },
    data,
  });
}

function parseImportedProjectTitle(meta: Record<string, unknown>): { titleProvided: boolean; requestedTitle: string | null } {
  const titleProvided = Boolean(meta.titleProvided);
  const requestedTitle = String(meta.requestedTitle || "").trim() || null;
  return { titleProvided, requestedTitle };
}

function toRichContent(chapter: ParsedBook["chapters"][number]): Prisma.InputJsonValue {
  return buildRichContentFromParsedChapter(chapter) as Prisma.InputJsonValue;
}

export async function processProjectImport(payload: ProcessProjectImportPayload) {
  const importId = String(payload.importId || "").trim();
  if (!importId) {
    throw new Error("Invalid project import payload: importId is required");
  }

  const projectImport = await prisma.projectImport.findUnique({
    where: { id: importId },
    include: {
      sourceAsset: true,
    },
  });

  if (!projectImport) {
    throw new Error(`Project import ${importId} not found`);
  }

  if (projectImport.state === "completed") {
    return;
  }

  if (projectImport.state === "failed") {
    return;
  }

  await updateImportStatus(importId, {
    state: "running",
    stage: "loading_source",
    error: null,
    startedAt: projectImport.startedAt || new Date(),
    completedAt: null,
  });

  const blobStore = new LocalBlobStore({
    rootDir: workerConfig.imports.blobDir,
    provider: projectImport.sourceAsset.provider,
  });

  try {
    const bytes = await blobStore.get(projectImport.sourceAsset.storageKey);

    await updateImportStatus(importId, {
      stage: "parsing",
      error: null,
    });

    const parsed = ensureParsedBookHasChapters(
      await parseBook({
        format: projectImport.format,
        fileName: projectImport.sourceAsset.fileName,
        bytes,
        maxZipUncompressedBytes: workerConfig.imports.maxZipUncompressedBytes,
      })
    );

    const parsedMeta = jsonObject(projectImport.metadataJson);
    const titleResolution = parseImportedProjectTitle(parsedMeta);
    const parsedBookTitle = String(parsed.metadata.title || "").trim() || null;
    const resolvedProjectTitle = titleResolution.titleProvided ? titleResolution.requestedTitle : parsedBookTitle;

    await updateImportStatus(importId, {
      stage: "persisting",
      error: null,
    });

    await prisma.$transaction(async (tx: any) => {
      const existingChapters = await tx.chapter.findMany({
        where: { projectId: projectImport.projectId },
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
      });

      const workingChapters = [...existingChapters];
      if (!workingChapters.length) {
        const firstChapter = await tx.chapter.create({
          data: {
            projectId: projectImport.projectId,
            title: "Новая глава",
            orderIndex: 0,
          },
        });

        await tx.document.create({
          data: {
            projectId: projectImport.projectId,
            chapterId: firstChapter.id,
            content: "",
            richContent: { type: "doc", content: [{ type: "paragraph" }] },
            contentVersion: 0,
            currentRunId: null,
          },
        });

        workingChapters.push(firstChapter);
      }

      const docsToAnalyze: Array<{ documentId: string; chapterId: string; contentVersion: number }> = [];

      for (let index = 0; index < parsed.chapters.length; index += 1) {
        const parsedChapter = parsed.chapters[index];
        const current = workingChapters[index];

        let chapter = current;
        if (chapter) {
          chapter = await tx.chapter.update({
            where: { id: chapter.id },
            data: {
              title: parsedChapter.title || `Глава ${index + 1}`,
              orderIndex: index,
            },
          });
        } else {
          chapter = await tx.chapter.create({
            data: {
              projectId: projectImport.projectId,
              title: parsedChapter.title || `Глава ${index + 1}`,
              orderIndex: index,
            },
          });
          workingChapters.push(chapter);
        }

        const content = buildPlainTextFromParsedChapter(parsedChapter);
        const richContent = toRichContent(parsedChapter);

        const existingDocument = await tx.document.findUnique({
          where: { chapterId: chapter.id },
        });

        const document = existingDocument
          ? await tx.document.update({
              where: { id: existingDocument.id },
              data: {
                projectId: projectImport.projectId,
                chapterId: chapter.id,
                content,
                richContent,
                contentVersion: 1,
                currentRunId: null,
              },
            })
          : await tx.document.create({
              data: {
                projectId: projectImport.projectId,
                chapterId: chapter.id,
                content,
                richContent,
                contentVersion: 1,
                currentRunId: null,
              },
            });

        docsToAnalyze.push({
          documentId: document.id,
          chapterId: chapter.id,
          contentVersion: document.contentVersion,
        });
      }

      const staleChapters = workingChapters.slice(parsed.chapters.length).map((chapter) => chapter.id);
      if (staleChapters.length) {
        await tx.chapter.deleteMany({
          where: {
            projectId: projectImport.projectId,
            id: {
              in: staleChapters,
            },
          },
        });
      }

      await tx.projectImport.update({
        where: { id: importId },
        data: {
          stage: "scheduling_analysis",
          chapterCount: parsed.chapters.length,
          metadataJson: {
            ...parsedMeta,
            parsedMetadata: {
              title: parsed.metadata.title || null,
              author: parsed.metadata.author || null,
              annotation: parsed.metadata.annotation || null,
            },
            resolvedProjectTitle: resolvedProjectTitle || null,
          },
        },
      });

      for (const doc of docsToAnalyze) {
        const run = await tx.analysisRun.create({
          data: {
            projectId: projectImport.projectId,
            documentId: doc.documentId,
            chapterId: doc.chapterId,
            contentVersion: doc.contentVersion,
            state: "queued",
            phase: "queued",
          },
        });

        await tx.analysisRun.updateMany({
          where: {
            documentId: doc.documentId,
            id: { not: run.id },
            state: {
              in: ["queued", "running"],
            },
          },
          data: {
            state: "superseded",
            phase: "superseded",
            supersededByRunId: run.id,
            completedAt: new Date(),
          },
        });

        await tx.document.update({
          where: { id: doc.documentId },
          data: {
            currentRunId: run.id,
          },
        });

        await tx.outbox.create({
          data: {
            aggregateType: "analysis_run",
            aggregateId: run.id,
            eventType: "analysis.run.requested",
            payloadJson: {
              runId: run.id,
              projectId: projectImport.projectId,
              documentId: doc.documentId,
              chapterId: doc.chapterId,
              contentVersion: doc.contentVersion,
            },
          },
        });
      }

      await tx.project.update({
        where: { id: projectImport.projectId },
        data: {
          ...(resolvedProjectTitle ? { title: resolvedProjectTitle } : {}),
          updatedAt: new Date(),
        },
      });

      await tx.projectImport.update({
        where: { id: importId },
        data: {
          state: "completed",
          stage: "completed",
          error: null,
          chapterCount: parsed.chapters.length,
          completedAt: new Date(),
        },
      });
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    logger.error({ err: error, importId }, "Project import failed");
    await updateImportStatus(importId, {
      state: "failed",
      stage: "failed",
      error: message,
      completedAt: new Date(),
    });
  }
}
