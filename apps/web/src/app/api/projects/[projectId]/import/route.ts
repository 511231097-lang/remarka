import { prisma } from "@remarka/db";
import { getLatestProjectImport } from "@/lib/projectImportState";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { projectId } = await Promise.resolve(context.params);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });

  if (!project) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const latestImport = await getLatestProjectImport(projectId);
  return Response.json({ import: latestImport });
}
