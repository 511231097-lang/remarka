import {
  ChapterNotFoundError,
  ProjectNotFoundError,
  createProjectChapter,
  listProjectChapters,
} from "@/lib/projectState";
import { z } from "zod";

export const runtime = "nodejs";

const CreateChapterSchema = z.object({
  title: z.string().trim().max(160).optional().nullable(),
});

interface RouteContext {
  params: Promise<{ projectId: string }>;
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

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await Promise.resolve(context.params);
    const chapters = await listProjectChapters(projectId);
    return Response.json({
      chapters: chapters.map((chapter) => toChapterPayload(chapter)),
    });
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ChapterNotFoundError) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await Promise.resolve(context.params);
    const body = await request.json().catch(() => ({}));
    const input = CreateChapterSchema.parse(body);
    const chapter = await createProjectChapter(projectId, input);
    return Response.json({ chapter: toChapterPayload(chapter) }, { status: 201 });
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

