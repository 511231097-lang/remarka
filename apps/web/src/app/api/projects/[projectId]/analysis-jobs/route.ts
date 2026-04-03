import { prisma } from "@remarka/db";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { projectId } = await Promise.resolve(context.params);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });

  if (!project) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit") || "20");
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 20;

  const jobs = await prisma.analysisRun.findMany({
    where: {
      projectId,
    },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
    include: {
      _count: {
        select: {
          patchDecisions: true,
        },
      },
    },
  });

  return Response.json({
    jobs: jobs.map((job: any) => ({
      id: job.id,
      projectId: job.projectId,
      documentId: job.documentId,
      chapterId: job.chapterId,
      contentVersion: job.contentVersion,
      status: job.state,
      phase: job.phase,
      error: job.error,
      patchDecisionCount: job._count.patchDecisions,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() || null,
      completedAt: job.completedAt?.toISOString() || null,
      updatedAt: job.updatedAt.toISOString(),
    })),
  });
}
