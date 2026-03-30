import { prisma } from "@remarka/db";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string; jobId: string }>;
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

  const job = await prisma.analysisJob.findFirst({
    where: {
      id: jobId,
      projectId,
    },
    select: {
      id: true,
      projectId: true,
      documentId: true,
      contentVersion: true,
      status: true,
      error: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  });

  if (!job) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const url = new URL(request.url);
  const includeText = ["1", "true", "yes"].includes((url.searchParams.get("includeText") || "").toLowerCase());
  const includeNormalized = ["1", "true", "yes"].includes(
    (url.searchParams.get("includeNormalized") || "").toLowerCase()
  );

  const limitRaw = Number(url.searchParams.get("limit") || "200");
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;

  const calls = await prisma.analysisModelCall.findMany({
    where: {
      analysisJobId: jobId,
    },
    orderBy: [{ createdAt: "asc" }],
    take: limit,
  });

  return Response.json({
    job: {
      id: job.id,
      projectId: job.projectId,
      documentId: job.documentId,
      contentVersion: job.contentVersion,
      status: job.status,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() || null,
      completedAt: job.completedAt?.toISOString() || null,
    },
    stats: {
      total: calls.length,
      parseErrors: calls.filter((call: any) => Boolean(call.parseError)).length,
    },
    calls: calls.map((call: any) => ({
      id: call.id,
      phase: call.phase,
      extractionMode: call.extractionMode,
      batchIndex: call.batchIndex,
      targetParagraphIndices: call.targetParagraphIndices,
      model: call.model,
      parseError: call.parseError,
      promptChars: call.prompt.length,
      rawResponseChars: call.rawResponse.length,
      createdAt: call.createdAt.toISOString(),
      ...(includeText
        ? {
            prompt: call.prompt,
            rawResponse: call.rawResponse,
            jsonCandidate: call.jsonCandidate,
          }
        : {}),
      ...(includeNormalized
        ? {
            normalizedPayload: call.normalizedPayload,
          }
        : {}),
    })),
  });
}
