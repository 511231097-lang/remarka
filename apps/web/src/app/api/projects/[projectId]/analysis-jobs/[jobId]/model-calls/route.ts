import { prisma } from "@remarka/db";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string; jobId: string }>;
}

function diffMs(start: Date | null | undefined, end: Date | null | undefined): number | null {
  if (!start || !end) return null;
  return Math.max(0, end.getTime() - start.getTime());
}

export async function GET(request: Request, context: RouteContext) {
  const { projectId, jobId } = await Promise.resolve(context.params);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });

  if (!project) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const run = await prisma.analysisRun.findFirst({
    where: {
      id: jobId,
      projectId,
    },
    select: {
      id: true,
      projectId: true,
      documentId: true,
      chapterId: true,
      contentVersion: true,
      state: true,
      phase: true,
      error: true,
      eligibleTotal: true,
      eligibleResolved: true,
      patchBudgetReached: true,
      uncertainCountRemaining: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      qualityFlags: true,
    },
  });

  if (!run) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const url = new URL(request.url);
  const includePayload = ["1", "true", "yes"].includes((url.searchParams.get("includePayload") || "").toLowerCase());

  const limitRaw = Number(url.searchParams.get("limit") || "200");
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;

  const [patchDecisions, candidateStats] = await Promise.all([
    prisma.patchDecision.findMany({
      where: {
        runId: run.id,
      },
      orderBy: [{ createdAt: "asc" }],
      take: limit,
    }),
    prisma.mentionCandidate.groupBy({
      by: ["decisionStatus", "routing"],
      where: {
        runId: run.id,
      },
      _count: {
        _all: true,
      },
    }),
  ]);

  const queueWaitMs = diffMs(run.createdAt, run.startedAt);
  const processingDurationMs = diffMs(run.startedAt, run.completedAt);
  const totalDurationMs = diffMs(run.createdAt, run.completedAt);

  return Response.json({
    run: {
      id: run.id,
      projectId: run.projectId,
      documentId: run.documentId,
      chapterId: run.chapterId,
      contentVersion: run.contentVersion,
      state: run.state,
      phase: run.phase,
      error: run.error,
      eligibleTotal: run.eligibleTotal,
      eligibleResolved: run.eligibleResolved,
      patchBudgetReached: run.patchBudgetReached,
      uncertainCountRemaining: run.uncertainCountRemaining,
      qualityFlags: run.qualityFlags,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() || null,
      completedAt: run.completedAt?.toISOString() || null,
    },
    stats: {
      queueWaitMs,
      processingDurationMs,
      totalDurationMs,
      patchDecisionsCount: patchDecisions.length,
      candidateStats,
    },
    patchDecisions: patchDecisions.map((item) => ({
      id: item.id,
      windowKey: item.windowKey,
      model: item.model,
      applied: item.applied,
      validationError: item.validationError,
      responseHashSha256: item.responseHashSha256,
      responseBytes: item.responseBytes,
      createdAt: item.createdAt.toISOString(),
      ...(includePayload
        ? {
            inputCandidateIds: item.inputCandidateIds,
            usageJson: item.usageJson,
            rawResponseSnippet: item.rawResponseSnippet,
            blobKey: item.blobKey,
          }
        : {}),
    })),
  });
}
