import { prisma } from "@remarka/db";
import type { Prisma } from "@prisma/client";

type UsageSummary = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type PhaseUsage = UsageSummary & {
  provider?: string | null;
  model?: string | null;
  attempt?: number | null;
  finishReason?: string | null;
};

type RunUsage = {
  entityPass: PhaseUsage | null;
  actPass: PhaseUsage | null;
  appearancePass: PhaseUsage | null;
  mentionCompletion: PhaseUsage | null;
  total: UsageSummary | null;
  hasUsage: boolean;
  source: "qualityFlags" | "patchDecision" | "none";
};

type MetricsMap = Record<string, number>;

type CliArgs = {
  projectId: string;
  chapterId: string | null;
  pretty: boolean;
  includeRuns: boolean;
};

function printUsageAndExit(message?: string): never {
  if (message) {
    console.error(`Error: ${message}`);
  }

  console.error(
    [
      "Usage:",
      "  npm --prefix apps/worker run analytics:extraction -- --project <projectId> [--chapter <chapterId>] [--no-pretty] [--include-runs]",
      "",
      "Examples:",
      "  npm --prefix apps/worker run analytics:extraction -- --project cmnj71uyh000h8iowbslr9eo9",
      "  npm --prefix apps/worker run analytics:extraction -- --project cmnj71uyh000h8iowbslr9eo9 --chapter cmnj71uyi000j8iowmpqeis1c",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    projectId: "",
    chapterId: null,
    pretty: true,
    includeRuns: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      printUsageAndExit();
    }

    if (token === "--project" || token === "-p") {
      const value = argv[index + 1];
      if (!value) {
        printUsageAndExit("Missing value for --project");
      }
      args.projectId = value;
      index += 1;
      continue;
    }

    if (token === "--chapter" || token === "-c") {
      const value = argv[index + 1];
      if (!value) {
        printUsageAndExit("Missing value for --chapter");
      }
      args.chapterId = value;
      index += 1;
      continue;
    }

    if (token === "--no-pretty") {
      args.pretty = false;
      continue;
    }

    if (token === "--include-runs") {
      args.includeRuns = true;
      continue;
    }

    printUsageAndExit(`Unknown argument: ${token}`);
  }

  if (!args.projectId) {
    printUsageAndExit("--project is required");
  }

  return args;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }
  return null;
}

function readNumericKeys(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const numeric = asNumber(record[key]);
    if (numeric !== null) {
      return numeric;
    }
  }
  return null;
}

function parseUsage(value: unknown): UsageSummary | null {
  const usageRecord = asRecord(value);
  if (!usageRecord) {
    return null;
  }

  const nestedUsage = asRecord(usageRecord.usage);
  const source = nestedUsage ?? usageRecord;

  const promptTokens = readNumericKeys(source, [
    "prompt_tokens",
    "promptTokens",
    "input_tokens",
    "inputTokens",
    "prompt_token_count",
    "inputTokenCount",
  ]);
  const completionTokens = readNumericKeys(source, [
    "completion_tokens",
    "completionTokens",
    "output_tokens",
    "outputTokens",
    "completion_token_count",
    "outputTokenCount",
  ]);
  const totalTokens = readNumericKeys(source, ["total_tokens", "totalTokens", "token_count", "totalTokenCount"]);

  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null;
  }

  const safePrompt = promptTokens ?? 0;
  const safeCompletion = completionTokens ?? 0;
  const safeTotal = totalTokens ?? safePrompt + safeCompletion;

  return {
    promptTokens: safePrompt,
    completionTokens: safeCompletion,
    totalTokens: safeTotal,
  };
}

function parsePhaseUsage(value: unknown): PhaseUsage | null {
  const phaseRecord = asRecord(value);
  const usage = parseUsage(value);
  if (!phaseRecord && !usage) {
    return null;
  }

  return {
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    provider: (phaseRecord?.provider as string | undefined) ?? null,
    model: (phaseRecord?.model as string | undefined) ?? null,
    attempt: asNumber(phaseRecord?.attempt),
    finishReason: typeof phaseRecord?.finishReason === "string" ? phaseRecord.finishReason : null,
  };
}

function addUsage(target: UsageSummary, value: UsageSummary | null | undefined) {
  if (!value) {
    return;
  }
  target.promptTokens += value.promptTokens;
  target.completionTokens += value.completionTokens;
  target.totalTokens += value.totalTokens;
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function durationMs(run: {
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}, now: Date): number {
  if (!run.startedAt) {
    return Math.max(0, Math.round(now.getTime() - run.createdAt.getTime()));
  }
  if (!run.completedAt) {
    return Math.max(0, Math.round(now.getTime() - run.startedAt.getTime()));
  }
  return Math.max(0, Math.round(run.completedAt.getTime() - run.startedAt.getTime()));
}

function computeDurationStats(values: number[]): { min: number | null; max: number | null; avg: number | null; p95: number | null } {
  if (!values.length) {
    return { min: null, max: null, avg: null, p95: null };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const p95 = sorted[p95Index];

  return { min, max, avg, p95 };
}

function bumpCounter(bucket: MetricsMap, key: string) {
  bucket[key] = (bucket[key] || 0) + 1;
}

function normalizeUsageSource(runUsage: RunUsage): "qualityFlags" | "patchDecision" | "none" {
  if (runUsage.source === "qualityFlags") {
    return "qualityFlags";
  }
  if (runUsage.source === "patchDecision") {
    return "patchDecision";
  }
  return "none";
}

function extractRunUsage(qualityFlags: Prisma.JsonValue | null, patchDecisionUsage: UsageSummary | null): RunUsage {
  const qualityFlagsRecord = asRecord(qualityFlags);
  const llmUsage = asRecord(qualityFlagsRecord?.llmUsage);

  const entityPass = parsePhaseUsage(llmUsage?.entityPass ?? llmUsage?.entity_pass);
  const actPass = parsePhaseUsage(llmUsage?.actPass ?? llmUsage?.act_pass);
  const appearancePass = parsePhaseUsage(llmUsage?.appearancePass ?? llmUsage?.appearance_pass);
  const mentionCompletion = parsePhaseUsage(
    llmUsage?.mentionCompletion ?? llmUsage?.mention_completion ?? llmUsage?.patchCompletion
  );

  let total = parseUsage(llmUsage?.total);
  if (!total && (entityPass || actPass || appearancePass || mentionCompletion)) {
    total = {
      promptTokens:
        (entityPass?.promptTokens ?? 0) +
        (actPass?.promptTokens ?? 0) +
        (appearancePass?.promptTokens ?? 0) +
        (mentionCompletion?.promptTokens ?? 0),
      completionTokens:
        (entityPass?.completionTokens ?? 0) +
        (actPass?.completionTokens ?? 0) +
        (appearancePass?.completionTokens ?? 0) +
        (mentionCompletion?.completionTokens ?? 0),
      totalTokens:
        (entityPass?.totalTokens ?? 0) +
        (actPass?.totalTokens ?? 0) +
        (appearancePass?.totalTokens ?? 0) +
        (mentionCompletion?.totalTokens ?? 0),
    };
  }

  let source: "qualityFlags" | "patchDecision" | "none" = "none";

  if (entityPass || mentionCompletion || total) {
    source = "qualityFlags";
  } else if (patchDecisionUsage) {
    total = patchDecisionUsage;
    source = "patchDecision";
  }

  return {
    entityPass,
    actPass,
    appearancePass,
    mentionCompletion,
    total,
    hasUsage: Boolean(total),
    source,
  };
}

function summarizeOutboxAttempts(rows: Array<{ attemptCount: number }>): { max: number; avg: number } {
  if (!rows.length) {
    return { max: 0, avg: 0 };
  }

  const max = rows.reduce((acc, row) => Math.max(acc, row.attemptCount), 0);
  const avg = Math.round(rows.reduce((acc, row) => acc + row.attemptCount, 0) / rows.length);
  return { max, avg };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const now = new Date();

  const project = await prisma.project.findUnique({
    where: { id: cli.projectId },
    select: {
      id: true,
      title: true,
      description: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!project) {
    throw new Error(`Project not found: ${cli.projectId}`);
  }

  const chapters = await prisma.chapter.findMany({
    where: {
      projectId: cli.projectId,
      ...(cli.chapterId ? { id: cli.chapterId } : {}),
    },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true,
      title: true,
      orderIndex: true,
      createdAt: true,
      updatedAt: true,
      document: {
        select: {
          id: true,
          contentVersion: true,
          currentRunId: true,
          content: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (cli.chapterId && chapters.length === 0) {
    throw new Error(`Chapter ${cli.chapterId} not found in project ${cli.projectId}`);
  }

  const chapterIds = chapters.map((chapter) => chapter.id);
  const documents = chapters
    .map((chapter) => chapter.document)
    .filter((document): document is NonNullable<(typeof chapters)[number]["document"]> => document !== null);
  const documentIds = documents.map((document) => document.id);

  const runs = await prisma.analysisRun.findMany({
    where: {
      projectId: cli.projectId,
      ...(cli.chapterId ? { chapterId: cli.chapterId } : {}),
    },
    orderBy: [{ chapterId: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      projectId: true,
      chapterId: true,
      documentId: true,
      contentVersion: true,
      state: true,
      phase: true,
      error: true,
      patchBudgetReached: true,
      uncertainCountRemaining: true,
      eligibleTotal: true,
      eligibleResolved: true,
      qualityFlags: true,
      supersededByRunId: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const runIds = runs.map((run) => run.id);
  const currentRunIds = documents.map((document) => document.currentRunId).filter((id): id is string => Boolean(id));

  const [candidateGroups, mentionGroups, patchCounts, patchUsageRows, entitiesByTypeRows, outboxRows] = await Promise.all([
    runIds.length
      ? prisma.mentionCandidate.groupBy({
          by: ["runId", "routing", "decisionStatus"],
          where: { runId: { in: runIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    runIds.length
      ? prisma.mention.groupBy({
          by: ["runId"],
          where: { runId: { in: runIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    runIds.length
      ? prisma.patchDecision.groupBy({
          by: ["runId", "applied"],
          where: { runId: { in: runIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    runIds.length
      ? prisma.patchDecision.findMany({
          where: {
            runId: { in: runIds },
          },
          orderBy: { createdAt: "asc" },
          select: {
            runId: true,
            usageJson: true,
          },
        })
      : Promise.resolve([]),
    prisma.entity.groupBy({
      by: ["type"],
      where: { projectId: cli.projectId },
      _count: { _all: true },
    }),
    prisma.outbox.findMany({
      where: {
        aggregateId: {
          in: [project.id, ...chapterIds, ...documentIds, ...runIds],
        },
      },
      select: {
        id: true,
        processedAt: true,
        attemptCount: true,
        error: true,
      },
    }),
  ]);

  const runsById = new Map(runs.map((run) => [run.id, run] as const));
  const runsByChapterId = new Map<string, typeof runs>();
  for (const run of runs) {
    const chapterRuns = runsByChapterId.get(run.chapterId) ?? [];
    chapterRuns.push(run);
    runsByChapterId.set(run.chapterId, chapterRuns);
  }

  const candidatesByRun = new Map<
    string,
    {
      total: number;
      deterministicAccepted: number;
      patchPending: number;
      patchAccepted: number;
      patchRejected: number;
    }
  >();
  for (const group of candidateGroups) {
    const current =
      candidatesByRun.get(group.runId) ??
      {
        total: 0,
        deterministicAccepted: 0,
        patchPending: 0,
        patchAccepted: 0,
        patchRejected: 0,
      };

    const count = group._count._all;
    current.total += count;

    if (group.routing === "deterministic" && group.decisionStatus === "accepted") {
      current.deterministicAccepted += count;
    }
    if (group.routing === "patch" && group.decisionStatus === "pending") {
      current.patchPending += count;
    }
    if (group.routing === "patch" && group.decisionStatus === "accepted") {
      current.patchAccepted += count;
    }
    if (group.routing === "patch" && group.decisionStatus === "rejected") {
      current.patchRejected += count;
    }

    candidatesByRun.set(group.runId, current);
  }

  const mentionsByRun = new Map<string, number>();
  for (const group of mentionGroups) {
    mentionsByRun.set(group.runId, group._count._all);
  }

  const patchCountsByRun = new Map<string, { total: number; applied: number; rejected: number }>();
  for (const group of patchCounts) {
    const current = patchCountsByRun.get(group.runId) ?? { total: 0, applied: 0, rejected: 0 };
    const count = group._count._all;
    current.total += count;
    if (group.applied) {
      current.applied += count;
    } else {
      current.rejected += count;
    }
    patchCountsByRun.set(group.runId, current);
  }

  const patchUsageByRun = new Map<string, UsageSummary>();
  for (const row of patchUsageRows) {
    if (patchUsageByRun.has(row.runId)) {
      continue;
    }

    const usage = parseUsage(row.usageJson);
    if (usage) {
      patchUsageByRun.set(row.runId, usage);
    }
  }

  const runUsageByRun = new Map<string, RunUsage>();
  for (const run of runs) {
    runUsageByRun.set(run.id, extractRunUsage(run.qualityFlags, patchUsageByRun.get(run.id) ?? null));
  }

  const runsByState: MetricsMap = {};
  const runsByPhase: MetricsMap = {};
  const currentRunsByState: MetricsMap = {};

  for (const run of runs) {
    bumpCounter(runsByState, run.state);
    bumpCounter(runsByPhase, run.phase);
  }

  for (const runId of currentRunIds) {
    const run = runsById.get(runId);
    if (run) {
      bumpCounter(currentRunsByState, run.state);
    }
  }

  const allRunDurations = runs.map((run) => durationMs(run, now));
  const currentRunDurations = currentRunIds
    .map((runId) => runsById.get(runId))
    .filter((run): run is NonNullable<typeof run> => Boolean(run))
    .map((run) => durationMs(run, now));

  const entitiesByType: MetricsMap = {
    character: 0,
    location: 0,
    event: 0,
  };
  for (const row of entitiesByTypeRows) {
    entitiesByType[row.type] = row._count._all;
  }

  const totalAllCandidates = Array.from(candidatesByRun.values()).reduce((sum, item) => sum + item.total, 0);
  const totalCurrentCandidates = currentRunIds.reduce((sum, runId) => sum + (candidatesByRun.get(runId)?.total ?? 0), 0);
  const totalAllMentions = Array.from(mentionsByRun.values()).reduce((sum, value) => sum + value, 0);
  const totalCurrentMentions = currentRunIds.reduce((sum, runId) => sum + (mentionsByRun.get(runId) ?? 0), 0);
  const totalAllPatchDecisions = Array.from(patchCountsByRun.values()).reduce((sum, item) => sum + item.total, 0);
  const totalCurrentPatchDecisions = currentRunIds.reduce((sum, runId) => sum + (patchCountsByRun.get(runId)?.total ?? 0), 0);

  const allUsageTotal: UsageSummary = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const currentUsageTotal: UsageSummary = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  let allRunsWithUsage = 0;
  let currentRunsWithUsage = 0;

  const tokenSourceCounts = {
    qualityFlags: 0,
    patchDecision: 0,
    none: 0,
  };

  for (const run of runs) {
    const runUsage = runUsageByRun.get(run.id);
    if (runUsage?.total) {
      addUsage(allUsageTotal, runUsage.total);
      allRunsWithUsage += 1;
    }
    const sourceKey = runUsage ? normalizeUsageSource(runUsage) : "none";
    tokenSourceCounts[sourceKey] += 1;
  }

  for (const runId of currentRunIds) {
    const runUsage = runUsageByRun.get(runId);
    if (runUsage?.total) {
      addUsage(currentUsageTotal, runUsage.total);
      currentRunsWithUsage += 1;
    }
  }

  const chapterReports = chapters.map((chapter) => {
    const document = chapter.document;
    const chapterRuns = runsByChapterId.get(chapter.id) ?? [];
    const chapterCurrentRun = document?.currentRunId ? runsById.get(document.currentRunId) ?? null : null;

    const chapterRunStates: MetricsMap = {};
    for (const run of chapterRuns) {
      bumpCounter(chapterRunStates, run.state);
    }

    const currentRunId = chapterCurrentRun?.id ?? null;
    const currentCandidates = currentRunId
      ? candidatesByRun.get(currentRunId) ?? {
          total: 0,
          deterministicAccepted: 0,
          patchPending: 0,
          patchAccepted: 0,
          patchRejected: 0,
        }
      : {
          total: 0,
          deterministicAccepted: 0,
          patchPending: 0,
          patchAccepted: 0,
          patchRejected: 0,
        };
    const currentMentions = currentRunId ? mentionsByRun.get(currentRunId) ?? 0 : 0;
    const currentPatch = currentRunId
      ? patchCountsByRun.get(currentRunId) ?? { total: 0, applied: 0, rejected: 0 }
      : { total: 0, applied: 0, rejected: 0 };
    const currentUsage = currentRunId ? runUsageByRun.get(currentRunId) ?? null : null;

    const chapterDurations = chapterRuns.map((run) => durationMs(run, now));

    return {
      chapterId: chapter.id,
      title: chapter.title,
      orderIndex: chapter.orderIndex,
      createdAt: toIso(chapter.createdAt),
      updatedAt: toIso(chapter.updatedAt),
      document: document
        ? {
            id: document.id,
            contentVersion: document.contentVersion,
            textLengthChars: document.content.length,
            createdAt: toIso(document.createdAt),
            updatedAt: toIso(document.updatedAt),
          }
        : null,
      runHistory: {
        total: chapterRuns.length,
        byState: chapterRunStates,
        durationMs: computeDurationStats(chapterDurations),
      },
      currentRun: chapterCurrentRun
        ? {
            id: chapterCurrentRun.id,
            state: chapterCurrentRun.state,
            phase: chapterCurrentRun.phase,
            contentVersion: chapterCurrentRun.contentVersion,
            supersededByRunId: chapterCurrentRun.supersededByRunId,
            startedAt: toIso(chapterCurrentRun.startedAt),
            completedAt: toIso(chapterCurrentRun.completedAt),
            createdAt: toIso(chapterCurrentRun.createdAt),
            updatedAt: toIso(chapterCurrentRun.updatedAt),
            durationMs: durationMs(chapterCurrentRun, now),
            error: chapterCurrentRun.error,
            eligibleTotal: chapterCurrentRun.eligibleTotal,
            eligibleResolved: chapterCurrentRun.eligibleResolved,
            uncertainCountRemaining: chapterCurrentRun.uncertainCountRemaining,
            patchBudgetReached: chapterCurrentRun.patchBudgetReached,
            counts: {
              mentionCandidates: currentCandidates.total,
              deterministicAccepted: currentCandidates.deterministicAccepted,
              patchPending: currentCandidates.patchPending,
              patchAccepted: currentCandidates.patchAccepted,
              patchRejected: currentCandidates.patchRejected,
              mentions: currentMentions,
              patchDecisionsTotal: currentPatch.total,
              patchDecisionsApplied: currentPatch.applied,
              patchDecisionsRejected: currentPatch.rejected,
            },
            tokenUsage: currentUsage,
            qualityFlags: chapterCurrentRun.qualityFlags,
          }
        : null,
    };
  });

  const outboxPendingRows = outboxRows.filter((item) => item.processedAt === null);
  const outboxProcessedRows = outboxRows.filter((item) => item.processedAt !== null);
  const outboxErrors = outboxRows.filter((item) => item.error && item.error.trim().length > 0);

  const report = {
    generatedAt: now.toISOString(),
    filters: {
      projectId: cli.projectId,
      chapterId: cli.chapterId,
      scope: cli.chapterId ? "chapter" : "project",
    },
    project: {
      id: project.id,
      title: project.title,
      description: project.description,
      createdAt: toIso(project.createdAt),
      updatedAt: toIso(project.updatedAt),
    },
    totals: {
      chapters: chapters.length,
      documents: documents.length,
      runs: runs.length,
      runsByState,
      runsByPhase,
      currentRuns: currentRunIds.length,
      currentRunsByState,
      entitiesByType,
      allMentionCandidates: totalAllCandidates,
      currentMentionCandidates: totalCurrentCandidates,
      allMentions: totalAllMentions,
      currentMentions: totalCurrentMentions,
      allPatchDecisions: totalAllPatchDecisions,
      currentPatchDecisions: totalCurrentPatchDecisions,
      outbox: {
        total: outboxRows.length,
        pending: outboxPendingRows.length,
        processed: outboxProcessedRows.length,
        withError: outboxErrors.length,
        attemptStats: summarizeOutboxAttempts(outboxRows),
      },
    },
    performance: {
      allRunsDurationMs: computeDurationStats(allRunDurations),
      currentRunsDurationMs: computeDurationStats(currentRunDurations),
    },
    tokenUsage: {
      allRuns: {
        ...allUsageTotal,
        runsWithUsage: allRunsWithUsage,
        runsWithoutUsage: Math.max(0, runs.length - allRunsWithUsage),
      },
      currentRuns: {
        ...currentUsageTotal,
        runsWithUsage: currentRunsWithUsage,
        runsWithoutUsage: Math.max(0, currentRunIds.length - currentRunsWithUsage),
      },
      sourceCoverage: tokenSourceCounts,
    },
    chapters: chapterReports,
    ...(cli.includeRuns
      ? {
          runs: runs.map((run) => ({
            id: run.id,
            chapterId: run.chapterId,
            documentId: run.documentId,
            contentVersion: run.contentVersion,
            state: run.state,
            phase: run.phase,
            supersededByRunId: run.supersededByRunId,
            createdAt: toIso(run.createdAt),
            startedAt: toIso(run.startedAt),
            completedAt: toIso(run.completedAt),
            durationMs: durationMs(run, now),
            error: run.error,
            eligibleTotal: run.eligibleTotal,
            eligibleResolved: run.eligibleResolved,
            uncertainCountRemaining: run.uncertainCountRemaining,
            patchBudgetReached: run.patchBudgetReached,
            counts: {
              mentionCandidates: candidatesByRun.get(run.id)?.total ?? 0,
              mentions: mentionsByRun.get(run.id) ?? 0,
              patchDecisions: patchCountsByRun.get(run.id)?.total ?? 0,
            },
            tokenUsage: runUsageByRun.get(run.id) ?? null,
            qualityFlags: run.qualityFlags,
          })),
        }
      : {}),
  };

  process.stdout.write(`${JSON.stringify(report, null, cli.pretty ? 2 : 0)}\n`);
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
