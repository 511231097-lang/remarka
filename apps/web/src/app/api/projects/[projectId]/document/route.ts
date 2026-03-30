import {
  ChapterNotFoundError,
  getProjectDocument,
  ProjectNotFoundError,
  saveProjectDocument,
} from "@/lib/projectState";
import { z } from "zod";

export const runtime = "nodejs";

const SaveDocumentSchema = z.object({
  richContent: z.unknown(),
});

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await Promise.resolve(context.params);
    const url = new URL(_request.url);
    const chapterId = url.searchParams.get("chapter")?.trim() || null;
    const document = await getProjectDocument(projectId, chapterId);
    return Response.json({ document });
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ChapterNotFoundError) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { projectId } = await Promise.resolve(context.params);
    const url = new URL(request.url);
    const chapterId = url.searchParams.get("chapter")?.trim() || null;
    if (!chapterId) {
      return Response.json(
        {
          error: "VALIDATION_ERROR",
          issues: [{ path: ["chapter"], message: "chapter is required" }],
        },
        { status: 400 }
      );
    }
    const body = await request.json();
    const input = SaveDocumentSchema.parse(body);

    const document = await saveProjectDocument(projectId, chapterId, input.richContent);

    return Response.json({ document });
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ChapterNotFoundError) {
      return Response.json(
        {
          error: "NOT_FOUND",
        },
        { status: 404 }
      );
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

    return Response.json(
      {
        error: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
