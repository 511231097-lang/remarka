import { prisma } from "@remarka/db";
import type { Prisma } from "@prisma/client";
import {
  EMPTY_RICH_TEXT_DOCUMENT,
  RichTextDocumentSchema,
  canonicalizeDocumentContent,
  richTextToPlainText,
} from "@remarka/contracts";
import { getBoss } from "./pgBoss";
import { DOCUMENT_EXTRACT_QUEUE } from "./queue";
import { toDocumentPayload, type DocumentWithRelations } from "./serializers";

const DEFAULT_CHAPTER_TITLE = "Новая глава";

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found`);
    this.name = "ProjectNotFoundError";
  }
}

export class ChapterNotFoundError extends Error {
  constructor(projectId: string, chapterId: string) {
    super(`Chapter ${chapterId} not found in project ${projectId}`);
    this.name = "ChapterNotFoundError";
  }
}

export class LastChapterDeletionError extends Error {
  constructor(projectId: string) {
    super(`Cannot delete last chapter in project ${projectId}`);
    this.name = "LastChapterDeletionError";
  }
}

type ChapterRecord = {
  id: string;
  projectId: string;
  title: string;
  orderIndex: number;
  createdAt: Date;
  updatedAt: Date;
};

type ChapterMoveDirection = "up" | "down";

type ProjectRecord = {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  chapters: ChapterRecord[];
};

async function ensureProjectExists(projectId: string, tx: any = prisma) {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });

  if (!project) {
    throw new ProjectNotFoundError(projectId);
  }
}

async function getOrCreateFirstChapter(projectId: string, tx: any = prisma): Promise<ChapterRecord> {
  const existing = await tx.chapter.findFirst({
    where: { projectId },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
  });

  if (existing) return existing;

  const aggregate = await tx.chapter.aggregate({
    where: { projectId },
    _max: {
      orderIndex: true,
    },
  });
  const nextOrderIndex = Number(aggregate._max.orderIndex ?? -1) + 1;

  return tx.chapter.create({
    data: {
      projectId,
      title: DEFAULT_CHAPTER_TITLE,
      orderIndex: nextOrderIndex,
    },
  });
}

async function resolveProjectChapter(
  projectId: string,
  chapterId: string | null | undefined,
  tx: any = prisma
): Promise<ChapterRecord> {
  await ensureProjectExists(projectId, tx);

  if (!chapterId) {
    return getOrCreateFirstChapter(projectId, tx);
  }

  const chapter = await tx.chapter.findFirst({
    where: {
      id: chapterId,
      projectId,
    },
  });

  if (!chapter) {
    throw new ChapterNotFoundError(projectId, chapterId);
  }

  return chapter;
}

async function normalizeChapterOrder(projectId: string, tx: any = prisma) {
  const chapters = await tx.chapter.findMany({
    where: { projectId },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
  });

  await Promise.all(
    chapters.map((chapter: ChapterRecord, index: number) => {
      if (chapter.orderIndex === index) {
        return Promise.resolve();
      }

      return tx.chapter.update({
        where: { id: chapter.id },
        data: { orderIndex: index },
      });
    })
  );

  return tx.chapter.findMany({
    where: { projectId },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
  });
}

async function getDocumentOrCreate(projectId: string, chapterId?: string | null): Promise<DocumentWithRelations> {
  const chapter = await resolveProjectChapter(projectId, chapterId);

  const existing = await prisma.document.findUnique({
    where: { chapterId: chapter.id },
    include: {
      mentions: {
        include: {
          entity: {
            select: {
              id: true,
              type: true,
              name: true,
            },
          },
        },
        orderBy: { startOffset: "asc" },
      },
      annotations: {
        include: {
          entity: {
            select: {
              id: true,
              type: true,
              name: true,
            },
          },
        },
        orderBy: [{ paragraphIndex: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  if (existing) return existing as unknown as DocumentWithRelations;

  return prisma.document.create({
    data: {
      projectId,
      chapterId: chapter.id,
      content: "",
      richContent: EMPTY_RICH_TEXT_DOCUMENT as unknown as Prisma.InputJsonValue,
      contentVersion: 0,
      analysisStatus: "idle",
    },
    include: {
      mentions: {
        include: {
          entity: {
            select: {
              id: true,
              type: true,
              name: true,
            },
          },
        },
      },
      annotations: {
        include: {
          entity: {
            select: {
              id: true,
              type: true,
              name: true,
            },
          },
        },
      },
    },
  }) as unknown as DocumentWithRelations;
}

export async function listProjects(): Promise<ProjectRecord[]> {
  return prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      chapters: {
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
      },
    },
  });
}

export async function createProject(input: { title: string; description?: string | null }): Promise<ProjectRecord> {
  const title = input.title.trim();
  const description = input.description?.trim() || null;

  return prisma.$transaction(async (tx: any) => {
    const project = await tx.project.create({
      data: {
        title,
        description,
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
        analysisStatus: "idle",
      },
    });

    return {
      ...project,
      chapters: [firstChapter],
    };
  });
}

export async function listProjectChapters(projectId: string): Promise<ChapterRecord[]> {
  await ensureProjectExists(projectId);
  const chapters = await prisma.chapter.findMany({
    where: { projectId },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
  });

  if (chapters.length) {
    return chapters;
  }

  const created = await prisma.$transaction(async (tx: any) => {
    const chapter = await getOrCreateFirstChapter(projectId, tx);

    const existingDocument = await tx.document.findUnique({
      where: { chapterId: chapter.id },
      select: { id: true },
    });

    if (!existingDocument) {
      await tx.document.create({
        data: {
          projectId,
          chapterId: chapter.id,
          content: "",
          richContent: EMPTY_RICH_TEXT_DOCUMENT as unknown as Prisma.InputJsonValue,
          contentVersion: 0,
          analysisStatus: "idle",
        },
      });
    }

    return chapter;
  });

  return [created];
}

export async function createProjectChapter(projectId: string, input?: { title?: string | null }): Promise<ChapterRecord> {
  await ensureProjectExists(projectId);
  const requestedTitle = String(input?.title || "").trim();
  const baseTitle = requestedTitle || DEFAULT_CHAPTER_TITLE;

  return prisma.$transaction(async (tx: any) => {
    const aggregate = await tx.chapter.aggregate({
      where: { projectId },
      _max: {
        orderIndex: true,
      },
    });
    const nextOrderIndex = Number(aggregate._max.orderIndex ?? -1) + 1;
    const chapter = await tx.chapter.create({
      data: {
        projectId,
        title: baseTitle,
        orderIndex: nextOrderIndex,
      },
    });

    await tx.document.create({
      data: {
        projectId,
        chapterId: chapter.id,
        content: "",
        richContent: EMPTY_RICH_TEXT_DOCUMENT as unknown as Prisma.InputJsonValue,
        contentVersion: 0,
        analysisStatus: "idle",
      },
    });

    await tx.project.update({
      where: { id: projectId },
      data: {
        updatedAt: new Date(),
      },
    });

    return chapter;
  });
}

export async function updateProjectChapter(
  projectId: string,
  chapterId: string,
  input: { title?: string | null; move?: ChapterMoveDirection | null }
): Promise<ChapterRecord> {
  await ensureProjectExists(projectId);

  const requestedTitle = input.title == null ? null : String(input.title).trim();
  const moveDirection = input.move || null;

  return prisma.$transaction(async (tx: any) => {
    await resolveProjectChapter(projectId, chapterId, tx);

    if (requestedTitle !== null) {
      await tx.chapter.update({
        where: { id: chapterId },
        data: {
          title: requestedTitle || DEFAULT_CHAPTER_TITLE,
        },
      });
    }

    if (moveDirection) {
      const chapters = await tx.chapter.findMany({
        where: { projectId },
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
      });
      const fromIndex = chapters.findIndex((chapter: ChapterRecord) => chapter.id === chapterId);
      if (fromIndex >= 0) {
        const toIndex = moveDirection === "up" ? fromIndex - 1 : fromIndex + 1;
        if (toIndex >= 0 && toIndex < chapters.length) {
          const reordered = [...chapters];
          const [current] = reordered.splice(fromIndex, 1);
          reordered.splice(toIndex, 0, current);

          await Promise.all(
            reordered.map((chapter: ChapterRecord, index: number) =>
              tx.chapter.update({
                where: { id: chapter.id },
                data: { orderIndex: index },
              })
            )
          );
        }
      }
    }

    await normalizeChapterOrder(projectId, tx);

    await tx.project.update({
      where: { id: projectId },
      data: {
        updatedAt: new Date(),
      },
    });

    return tx.chapter.findUniqueOrThrow({
      where: { id: chapterId },
    });
  });
}

export async function deleteProjectChapter(projectId: string, chapterId: string): Promise<{
  deletedChapterId: string;
  fallbackChapterId: string;
}> {
  await ensureProjectExists(projectId);

  return prisma.$transaction(async (tx: any) => {
    const chapters = await tx.chapter.findMany({
      where: { projectId },
      orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
    });

    const index = chapters.findIndex((chapter: ChapterRecord) => chapter.id === chapterId);
    if (index === -1) {
      throw new ChapterNotFoundError(projectId, chapterId);
    }

    if (chapters.length <= 1) {
      throw new LastChapterDeletionError(projectId);
    }

    const fallbackChapter =
      chapters[index + 1] ||
      chapters[index - 1] ||
      null;
    if (!fallbackChapter) {
      throw new LastChapterDeletionError(projectId);
    }

    await tx.chapter.delete({
      where: { id: chapterId },
    });

    await normalizeChapterOrder(projectId, tx);

    await tx.project.update({
      where: { id: projectId },
      data: {
        updatedAt: new Date(),
      },
    });

    return {
      deletedChapterId: chapterId,
      fallbackChapterId: fallbackChapter.id,
    };
  });
}

export async function getProjectDocument(projectId: string, chapterId?: string | null) {
  const document = await getDocumentOrCreate(projectId, chapterId);
  return toDocumentPayload(document);
}

export async function saveProjectDocument(projectId: string, chapterId: string, rawRichContent: unknown) {
  await ensureProjectExists(projectId);
  const parsedRich = RichTextDocumentSchema.safeParse(rawRichContent);
  if (!parsedRich.success) {
    throw new Error("Invalid rich document payload");
  }

  const richContent = parsedRich.data as unknown as Prisma.InputJsonValue;
  const content = canonicalizeDocumentContent(richTextToPlainText(richContent));

  const transactionResult = await prisma.$transaction(async (tx: any) => {
    const chapter = await resolveProjectChapter(projectId, chapterId, tx);
    let document = await tx.document.findUnique({ where: { chapterId: chapter.id } });

    if (!document) {
      document = await tx.document.create({
        data: {
          projectId,
          chapterId: chapter.id,
          content,
          richContent,
          contentVersion: 1,
          analysisStatus: "queued",
        },
      });
    } else {
      document = await tx.document.update({
        where: { id: document.id },
        data: {
          content,
          richContent,
          contentVersion: { increment: 1 },
          analysisStatus: "queued",
        },
      });
    }

    const job = await tx.analysisJob.create({
      data: {
        projectId,
        documentId: document.id,
        contentVersion: document.contentVersion,
        status: "queued",
      },
    });

    await tx.project.update({
      where: { id: projectId },
      data: {
        updatedAt: new Date(),
      },
    });

    const hydrated = await tx.document.findUniqueOrThrow({
      where: { id: document.id },
      include: {
        mentions: {
          include: {
            entity: {
              select: {
                id: true,
                type: true,
                name: true,
              },
            },
          },
          orderBy: { startOffset: "asc" },
        },
        annotations: {
          include: {
            entity: {
              select: {
                id: true,
                type: true,
                name: true,
              },
            },
          },
          orderBy: [{ paragraphIndex: "asc" }, { createdAt: "asc" }],
        },
      },
    });

    return { document: hydrated, job };
  });

  try {
    const boss = await getBoss();
    await boss.send(DOCUMENT_EXTRACT_QUEUE, {
      jobId: transactionResult.job.id,
      projectId,
      documentId: transactionResult.job.documentId,
      contentVersion: transactionResult.job.contentVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Queue send failed";

    await prisma.$transaction(async (tx: any) => {
      await tx.analysisJob.update({
        where: { id: transactionResult.job.id },
        data: {
          status: "failed",
          error: message.slice(0, 1000),
          completedAt: new Date(),
        },
      });

      await tx.document.updateMany({
        where: {
          id: transactionResult.job.documentId,
          contentVersion: transactionResult.job.contentVersion,
        },
        data: {
          analysisStatus: "failed",
        },
      });
    });
  }

  const latest = await getDocumentOrCreate(projectId, chapterId);
  return toDocumentPayload(latest);
}
