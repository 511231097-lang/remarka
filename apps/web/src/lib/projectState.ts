import { prisma } from "@remarka/db";
import type { Prisma } from "@prisma/client";
import {
  EMPTY_RICH_TEXT_DOCUMENT,
  QualityFlagsSchema,
  RichTextDocumentSchema,
  canonicalizeDocumentContent,
  richTextToPlainText,
  type AnalysisRunPayload,
  type DocumentSnapshot,
  type DocumentViewResponse,
  type PutDocumentResponse,
  type QualityFlags,
} from "@remarka/contracts";

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

export class PreconditionFailedError extends Error {
  currentContentVersion: number;

  constructor(currentContentVersion: number) {
    super(`If-Match failed: current contentVersion=${currentContentVersion}`);
    this.name = "PreconditionFailedError";
    this.currentContentVersion = currentContentVersion;
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
  projectImports: Array<{
    id: string;
    projectId: string;
    format: "fb2" | "fb2_zip";
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
};

function parseQualityFlags(value: unknown): QualityFlags | null {
  const parsed = QualityFlagsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function serializeRun(run: any | null): AnalysisRunPayload | null {
  if (!run) return null;

  return {
    id: run.id,
    projectId: run.projectId,
    documentId: run.documentId,
    chapterId: run.chapterId,
    contentVersion: run.contentVersion,
    state: run.state,
    phase: run.phase,
    error: run.error || null,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    qualityFlags: parseQualityFlags(run.qualityFlags),
  };
}

function serializeSnapshot(document: any, mentions: any[]): DocumentSnapshot {
  return {
    id: document.id,
    projectId: document.projectId,
    chapterId: document.chapterId,
    content: document.content,
    richContent: document.richContent,
    contentVersion: document.contentVersion,
    updatedAt: document.updatedAt.toISOString(),
    mentions: mentions.map((mention) => ({
      id: mention.id,
      entityId: mention.entityId,
      paragraphIndex: mention.paragraphIndex,
      startOffset: mention.startOffset,
      endOffset: mention.endOffset,
      sourceText: mention.sourceText,
      entity: {
        id: mention.entity.id,
        type: mention.entity.type,
        name: mention.entity.canonicalName,
      },
    })),
  };
}

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

async function getOrCreateDocument(projectId: string, chapterId?: string | null, tx: any = prisma) {
  const chapter = await resolveProjectChapter(projectId, chapterId, tx);

  const existing = await tx.document.findUnique({
    where: { chapterId: chapter.id },
  });

  if (existing) return existing;

  return tx.document.create({
    data: {
      projectId,
      chapterId: chapter.id,
      content: "",
      richContent: EMPTY_RICH_TEXT_DOCUMENT as unknown as Prisma.InputJsonValue,
      contentVersion: 0,
      currentRunId: null,
    },
  });
}

async function enqueueAnalysisRun(params: {
  tx: any;
  projectId: string;
  documentId: string;
  chapterId: string;
  contentVersion: number;
  idempotencyKey?: string | null;
}) {
  const idempotencyKey = String(params.idempotencyKey || "").trim() || null;
  const run = await params.tx.analysisRun.create({
    data: {
      projectId: params.projectId,
      documentId: params.documentId,
      chapterId: params.chapterId,
      contentVersion: params.contentVersion,
      state: "queued",
      phase: "queued",
      idempotencyKey,
    },
  });

  await params.tx.analysisRun.updateMany({
    where: {
      documentId: params.documentId,
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

  await params.tx.document.update({
    where: { id: params.documentId },
    data: {
      currentRunId: run.id,
    },
  });

  await params.tx.outbox.create({
    data: {
      aggregateType: "analysis_run",
      aggregateId: run.id,
      eventType: "analysis.run.requested",
      payloadJson: {
        runId: run.id,
        projectId: params.projectId,
        documentId: params.documentId,
        chapterId: params.chapterId,
        contentVersion: params.contentVersion,
      },
    },
  });

  return run;
}

async function loadDocumentState(projectId: string, chapterId?: string | null, tx: any = prisma): Promise<DocumentViewResponse> {
  const document = await getOrCreateDocument(projectId, chapterId, tx);

  const currentRun = document.currentRunId
    ? await tx.analysisRun.findUnique({ where: { id: document.currentRunId } })
    : await tx.analysisRun.findFirst({
        where: { documentId: document.id },
        orderBy: [{ createdAt: "desc" }],
      });

  const mentions = await tx.mention.findMany({
    where: {
      documentId: document.id,
      contentVersion: document.contentVersion,
    },
    include: {
      entity: {
        select: {
          id: true,
          type: true,
          canonicalName: true,
        },
      },
    },
    orderBy: [{ startOffset: "asc" }, { id: "asc" }],
  });

  const runPayload = serializeRun(currentRun);

  return {
    run: runPayload,
    snapshot: serializeSnapshot(document, mentions),
    qualityFlags: runPayload?.qualityFlags || null,
  };
}

export async function listProjects(): Promise<ProjectRecord[]> {
  return prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      chapters: {
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
      },
      projectImports: {
        orderBy: [{ createdAt: "desc" }],
        take: 1,
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
        currentRunId: null,
      },
    });

    return {
      ...project,
      chapters: [firstChapter],
      projectImports: [],
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
    await getOrCreateDocument(projectId, chapter.id, tx);
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
        currentRunId: null,
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

    const fallbackChapter = chapters[index + 1] || chapters[index - 1] || null;
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

export async function getProjectDocument(projectId: string, chapterId?: string | null): Promise<DocumentViewResponse> {
  return loadDocumentState(projectId, chapterId, prisma);
}

export async function saveProjectDocument(
  projectId: string,
  chapterId: string,
  rawRichContent: unknown,
  options?: {
    ifMatchContentVersion?: number | null;
    idempotencyKey?: string | null;
  }
): Promise<PutDocumentResponse> {
  await ensureProjectExists(projectId);
  const parsedRich = RichTextDocumentSchema.safeParse(rawRichContent);
  if (!parsedRich.success) {
    throw new Error("Invalid rich document payload");
  }

  const richContent = parsedRich.data as unknown as Prisma.InputJsonValue;
  const content = canonicalizeDocumentContent(richTextToPlainText(richContent));
  const ifMatch =
    typeof options?.ifMatchContentVersion === "number" && Number.isInteger(options.ifMatchContentVersion)
      ? options.ifMatchContentVersion
      : null;
  const idempotencyKey = String(options?.idempotencyKey || "").trim() || null;

  const result = await prisma.$transaction(async (tx: any) => {
    const chapter = await resolveProjectChapter(projectId, chapterId, tx);
    let document = await tx.document.findUnique({ where: { chapterId: chapter.id } });

    if (!document) {
      document = await tx.document.create({
        data: {
          projectId,
          chapterId: chapter.id,
          content: "",
          richContent: EMPTY_RICH_TEXT_DOCUMENT as unknown as Prisma.InputJsonValue,
          contentVersion: 0,
          currentRunId: null,
        },
      });
    }

    if (idempotencyKey) {
      const existingByKey = await tx.analysisRun.findFirst({
        where: {
          documentId: document.id,
          idempotencyKey,
        },
        orderBy: [{ createdAt: "desc" }],
      });

      if (existingByKey) {
        const state = await loadDocumentState(projectId, chapter.id, tx);
        return {
          replay: true,
          run: existingByKey,
          state,
        };
      }
    }

    if (ifMatch !== null && document.contentVersion !== ifMatch) {
      throw new PreconditionFailedError(document.contentVersion);
    }

    const nextVersion = document.contentVersion + 1;

    document = await tx.document.update({
      where: { id: document.id },
      data: {
        content,
        richContent,
        contentVersion: nextVersion,
      },
    });

    const run = await enqueueAnalysisRun({
      tx,
      projectId,
      documentId: document.id,
      chapterId: chapter.id,
      contentVersion: document.contentVersion,
      idempotencyKey,
    });

    await tx.project.update({
      where: { id: projectId },
      data: {
        updatedAt: new Date(),
      },
    });

    const state = await loadDocumentState(projectId, chapter.id, tx);

    return {
      replay: false,
      run,
      state,
    };
  });

  if (result.replay) {
    return {
      runId: result.run.id,
      contentVersion: result.run.contentVersion,
      runState: result.run.state,
      snapshotAvailable: true,
      snapshot: result.state.snapshot,
      qualityFlags: result.state.qualityFlags,
    };
  }

  return {
    runId: result.run.id,
    contentVersion: result.run.contentVersion,
    runState: result.run.state,
    snapshotAvailable: true,
    snapshot: result.state.snapshot,
    qualityFlags: result.state.qualityFlags,
  };
}

export async function rerunProjectChapterAnalysis(
  projectId: string,
  chapterId: string,
  options?: {
    idempotencyKey?: string | null;
  }
): Promise<PutDocumentResponse> {
  await ensureProjectExists(projectId);
  const idempotencyKey = String(options?.idempotencyKey || "").trim() || null;

  const result = await prisma.$transaction(async (tx: any) => {
    const chapter = await resolveProjectChapter(projectId, chapterId, tx);
    let document = await tx.document.findUnique({
      where: { chapterId: chapter.id },
    });

    if (!document) {
      document = await tx.document.create({
        data: {
          projectId,
          chapterId: chapter.id,
          content: "",
          richContent: EMPTY_RICH_TEXT_DOCUMENT as unknown as Prisma.InputJsonValue,
          contentVersion: 0,
          currentRunId: null,
        },
      });
    }

    if (idempotencyKey) {
      const existingByKey = await tx.analysisRun.findFirst({
        where: {
          documentId: document.id,
          idempotencyKey,
        },
        orderBy: [{ createdAt: "desc" }],
      });

      if (existingByKey) {
        const state = await loadDocumentState(projectId, chapter.id, tx);
        return {
          replay: true,
          run: existingByKey,
          state,
        };
      }
    }

    const run = await enqueueAnalysisRun({
      tx,
      projectId,
      documentId: document.id,
      chapterId: chapter.id,
      contentVersion: document.contentVersion,
      idempotencyKey,
    });

    await tx.project.update({
      where: { id: projectId },
      data: {
        updatedAt: new Date(),
      },
    });

    const state = await loadDocumentState(projectId, chapter.id, tx);
    return {
      replay: false,
      run,
      state,
    };
  });

  if (result.replay) {
    return {
      runId: result.run.id,
      contentVersion: result.run.contentVersion,
      runState: result.run.state,
      snapshotAvailable: true,
      snapshot: result.state.snapshot,
      qualityFlags: result.state.qualityFlags,
    };
  }

  return {
    runId: result.run.id,
    contentVersion: result.run.contentVersion,
    runState: result.run.state,
    snapshotAvailable: true,
    snapshot: result.state.snapshot,
    qualityFlags: result.state.qualityFlags,
  };
}
