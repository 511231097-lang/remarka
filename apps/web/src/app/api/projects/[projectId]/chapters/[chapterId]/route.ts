import {
  ChapterNotFoundError,
  LastChapterDeletionError,
  ProjectNotFoundError,
  deleteProjectChapter,
  updateProjectChapter,
} from "@/lib/projectState";
import { z } from "zod";

export const runtime = "nodejs";

const UpdateChapterSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional().nullable(),
    move: z.enum(["up", "down"]).optional().nullable(),
  })
  .refine((input) => input.title != null || input.move != null, {
    message: "Either title or move must be provided",
    path: ["title"],
  });

interface RouteContext {
  params: Promise<{ projectId: string; chapterId: string }>;
}

function toChapterPayload(chapter: {
  id: string;
  projectId: string;
  title: string;
  orderIndex: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: chapter.id,
    projectId: chapter.projectId,
    title: chapter.title,
    orderIndex: chapter.orderIndex,
    createdAt: chapter.createdAt.toISOString(),
    updatedAt: chapter.updatedAt.toISOString(),
  };
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { projectId, chapterId } = await Promise.resolve(context.params);
    const body = await request.json().catch(() => ({}));
    const input = UpdateChapterSchema.parse(body);
    const chapter = await updateProjectChapter(projectId, chapterId, {
      title: input.title ?? undefined,
      move: input.move ?? undefined,
    });

    return Response.json({
      chapter: toChapterPayload(chapter),
    });
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ChapterNotFoundError) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    if (error instanceof z.ZodError) {
      return Response.json(
        {
          error: "VALIDATION_ERROR",
          issues: error.issues,
        },
        { status: 400 }
      );
    }

    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { projectId, chapterId } = await Promise.resolve(context.params);
    const result = await deleteProjectChapter(projectId, chapterId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ChapterNotFoundError) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    if (error instanceof LastChapterDeletionError) {
      return Response.json(
        {
          error: "LAST_CHAPTER",
          message: "Нельзя удалить последнюю главу проекта",
        },
        { status: 400 }
      );
    }

    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
