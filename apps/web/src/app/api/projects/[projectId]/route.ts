import { ProjectNotFoundError, deleteProject } from "@/lib/projectState";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await Promise.resolve(context.params);
    const result = await deleteProject(projectId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
