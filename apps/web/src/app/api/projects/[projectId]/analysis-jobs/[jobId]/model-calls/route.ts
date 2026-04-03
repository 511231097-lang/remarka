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
  const stageMetrics = await prisma.analysisJobStageMetric.findMany({
    where: {
      analysisJobId: jobId,
    },
    orderBy: [{ startedAt: "asc" }],
    take: 2000,
  });

  const queueWaitMs = diffMs(job.createdAt, job.startedAt);
  const processingDurationMs = diffMs(job.startedAt, job.completedAt);
  const totalDurationMs = diffMs(job.createdAt, job.completedAt);

  const stageSummary = Array.from(
    stageMetrics.reduce((acc, stageMetric: any) => {
      const key = String(stageMetric.stage || "").trim() || "unknown";
      const existing = acc.get(key) || {
        stage: key,
        count: 0,
        totalDurationMs: 0,
        minDurationMs: Number.POSITIVE_INFINITY,
        maxDurationMs: 0,
      };
      const durationMs = Number(stageMetric.durationMs || 0);
      existing.count += 1;
      existing.totalDurationMs += durationMs;
      existing.minDurationMs = Math.min(existing.minDurationMs, durationMs);
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      acc.set(key, existing);
      return acc;
    }, new Map<string, { stage: string; count: number; totalDurationMs: number; minDurationMs: number; maxDurationMs: number }>())
  )
    .map(([, summary]) => ({
      stage: summary.stage,
      count: summary.count,
      totalDurationMs: summary.totalDurationMs,
      minDurationMs: Number.isFinite(summary.minDurationMs) ? summary.minDurationMs : 0,
      maxDurationMs: summary.maxDurationMs,
      avgDurationMs: summary.count > 0 ? Math.round(summary.totalDurationMs / summary.count) : 0,
    }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);

  const modelCallSummary = Array.from(
    calls.reduce((acc, call: any) => {
      const key = `${call.phase}:${call.extractionMode}`;
      const existing = acc.get(key) || {
        phase: call.phase,
        extractionMode: call.extractionMode,
        count: 0,
        totalDurationMs: 0,
        parseErrors: 0,
      };
      const durationMs = Number(call.durationMs || 0);
      existing.count += 1;
      existing.totalDurationMs += durationMs;
      if (call.parseError) existing.parseErrors += 1;
      acc.set(key, existing);
      return acc;
    }, new Map<string, { phase: string; extractionMode: string; count: number; totalDurationMs: number; parseErrors: number }>())
  )
    .map(([, summary]) => ({
      phase: summary.phase,
      extractionMode: summary.extractionMode,
      count: summary.count,
      parseErrors: summary.parseErrors,
      totalDurationMs: summary.totalDurationMs,
      avgDurationMs: summary.count > 0 ? Math.round(summary.totalDurationMs / summary.count) : 0,
    }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);

  const finishReasonSummary = Array.from(
    calls.reduce((acc, call: any) => {
      const key = String(call.finishReason || "null");
      acc.set(key, (acc.get(key) || 0) + 1);
      return acc;
    }, new Map<string, number>())
  )
    .map(([finishReason, count]) => ({
      finishReason: finishReason === "null" ? null : finishReason,
      count,
    }))
    .sort((a, b) => b.count - a.count);

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
      queueWaitMs,
      processingDurationMs,
      totalDurationMs,
      stageMetricsCount: stageMetrics.length,
      timedModelCalls: calls.filter((call: any) => typeof call.durationMs === "number").length,
      modelCallDurationMsTotal: calls.reduce((sum: number, call: any) => sum + Number(call.durationMs || 0), 0),
      stageSummary,
      modelCallSummary,
      finishReasonSummary,
    },
    calls: calls.map((call: any) => ({
      id: call.id,
      phase: call.phase,
      extractionMode: call.extractionMode,
      batchIndex: call.batchIndex,
      targetParagraphIndices: call.targetParagraphIndices,
      model: call.model,
      attempt: call.attempt,
      finishReason: call.finishReason,
      parseError: call.parseError,
      promptChars: call.prompt.length,
      rawResponseChars: call.rawResponse.length,
      durationMs: call.durationMs,
      requestStartedAt: call.requestStartedAt?.toISOString() || null,
      requestCompletedAt: call.requestCompletedAt?.toISOString() || null,
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
    stageMetrics: stageMetrics.map((stageMetric: any) => ({
      id: stageMetric.id,
      stage: stageMetric.stage,
      durationMs: stageMetric.durationMs,
      startedAt: stageMetric.startedAt.toISOString(),
      completedAt: stageMetric.completedAt.toISOString(),
      createdAt: stageMetric.createdAt.toISOString(),
      metadata: stageMetric.metadata,
    })),
  });
}
