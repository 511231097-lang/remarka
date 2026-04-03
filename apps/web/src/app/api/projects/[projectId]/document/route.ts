import {
  ChapterNotFoundError,
  getProjectDocument,
  PreconditionFailedError,
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
    const state = await getProjectDocument(projectId, chapterId);
    return Response.json(state);
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
    const ifMatchRaw = request.headers.get("if-match")?.trim() || "";
    const ifMatchVersion = ifMatchRaw ? Number.parseInt(ifMatchRaw, 10) : null;
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
    const result = await saveProjectDocument(projectId, chapterId, input.richContent, {
      ifMatchContentVersion:
        ifMatchVersion !== null && Number.isFinite(ifMatchVersion) && Number.isInteger(ifMatchVersion)
          ? ifMatchVersion
          : null,
      idempotencyKey,
    });

    return Response.json(result);
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

    if (error instanceof PreconditionFailedError) {
      return Response.json(
        {
          error: "PRECONDITION_FAILED",
          currentContentVersion: error.currentContentVersion,
        },
        { status: 412 }
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
