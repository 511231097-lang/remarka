import {
  ChapterNotFoundError,
  ProjectNotFoundError,
  rerunProjectChapterAnalysis,
} from "@/lib/projectState";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string; chapterId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId, chapterId } = await Promise.resolve(context.params);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
    const result = await rerunProjectChapterAnalysis(projectId, chapterId, {
      idempotencyKey,
    });

    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ChapterNotFoundError) {
      return Response.json(
        {
          error: "NOT_FOUND",
        },
        { status: 404 }
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
