// Retrieval-only evaluation: planner + search_paragraphs, NO main-answer LLM.
// ~10x cheaper and ~5x faster than chatRegressionEval --golden, so iterating
// retrieval changes (alias expansion, contextual chunks, rerank tuning) is cheap.
//
// Output: evals/results/retrieval-{ISO}.json with recall@5/recall@10/MRR per
// book and overall, plus stability across runs.
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@remarka/db";
import { retrieveBookChatEvidence } from "../src/lib/bookChatService";
import { DEFAULT_ENABLED_BOOK_CHAT_TOOLS, type BookChatToolName } from "../src/lib/bookChatTools";

type GoldenCategory = "factual" | "chain" | "comparison" | "character" | "theme" | "quote";

type GoldenQuestion = {
  id: string;
  bookId: string;
  question: string;
  category: GoldenCategory;
  expectedParagraphIds: string[];
  expectedKeywords: string[];
  minRecallK: number;
  expectedFirstTool?: string;
};

type CliOptions = {
  runs: number;
  outputPath?: string;
  baselinePath?: string;
  maxSearchQueries?: number;
};

const DEFAULT_GOLDEN_SET_DIR = "evals/golden-set";
const DEFAULT_RESULTS_DIR = "evals/results";

function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank] || 0;
}

function parseArgs(argv: string[]): CliOptions {
  let runs = 1;
  let outputPath: string | undefined;
  let baselinePath: string | undefined;
  let maxSearchQueries: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "").trim();
    const next = String(argv[i + 1] || "").trim();
    if (token === "--runs" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) runs = parsed;
      i += 1;
      continue;
    }
    if (token === "--out" && next) {
      outputPath = next;
      i += 1;
      continue;
    }
    if (token === "--baseline" && next) {
      baselinePath = next;
      i += 1;
      continue;
    }
    if (token === "--max-search-queries" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) maxSearchQueries = parsed;
      i += 1;
      continue;
    }
  }
  return { runs, outputPath, baselinePath, maxSearchQueries };
}

function resolvePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function defaultOutputPath(suffix = ""): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${DEFAULT_RESULTS_DIR}/retrieval-${ts}${suffix}.json`;
}

function makeParagraphRef(row: { chapterId: string; paragraphIndex: number }): string {
  return `${String(row.chapterId || "").trim()}:${Math.max(0, Number(row.paragraphIndex || 0))}`;
}

function parseGoldenQuestion(line: string, file: string, lineNumber: number): GoldenQuestion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(`${file}:${lineNumber}: invalid JSON — ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${file}:${lineNumber}: expected JSON object`);
  }
  const row = parsed as Record<string, unknown>;
  const id = String(row.id || "").trim();
  const bookId = String(row.bookId || "").trim();
  const question = String(row.question || "").trim();
  const category = String(row.category || "").trim() as GoldenCategory;
  const expectedParagraphIds = Array.isArray(row.expectedParagraphIds)
    ? (row.expectedParagraphIds as unknown[]).map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const expectedKeywords = Array.isArray(row.expectedKeywords)
    ? (row.expectedKeywords as unknown[]).map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const minRecallK = Math.max(1, Number(row.minRecallK || 5));
  const expectedFirstTool = row.expectedFirstTool ? String(row.expectedFirstTool).trim() : undefined;

  if (!id || !bookId || !question || !category || !expectedParagraphIds.length) {
    throw new Error(`${file}:${lineNumber}: missing required fields`);
  }
  return { id, bookId, question, category, expectedParagraphIds, expectedKeywords, minRecallK, expectedFirstTool };
}

async function loadGoldenQuestions(goldenSetDir: string): Promise<GoldenQuestion[]> {
  const questionsDir = path.join(goldenSetDir, "questions");
  const files = (await readdir(questionsDir))
    .filter((file) => file.endsWith(".jsonl"))
    .sort((left, right) => left.localeCompare(right));
  const questions: GoldenQuestion[] = [];
  for (const file of files) {
    const filePath = path.join(questionsDir, file);
    const raw = await readFile(filePath, "utf-8");
    for (const [index, line] of raw.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      questions.push(parseGoldenQuestion(trimmed, filePath, index + 1));
    }
  }
  if (!questions.length) {
    throw new Error(`No golden questions found in ${questionsDir}`);
  }
  return questions;
}

async function loadExpectedRefs(questions: readonly GoldenQuestion[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(questions.flatMap((q) => q.expectedParagraphIds)));
  const rows = ids.length
    ? await prisma.bookParagraph.findMany({
        where: { id: { in: ids } },
        select: { id: true, chapterId: true, paragraphIndex: true },
      })
    : [];
  const map = new Map<string, string>(rows.map((row) => [row.id, makeParagraphRef(row)]));
  const missing = ids.filter((id) => !map.has(id));
  if (missing.length) {
    throw new Error(`Golden expectedParagraphIds not found in DB: ${missing.join(", ")}`);
  }
  return map;
}

function calculateRecall(expected: readonly string[], retrieved: readonly string[], topK: number): number {
  if (!expected.length) return 0;
  const top = new Set(retrieved.slice(0, Math.max(1, topK)));
  const hits = expected.filter((ref) => top.has(ref)).length;
  return round(hits / expected.length);
}

function calculateMrr(expected: readonly string[], retrieved: readonly string[]): number {
  const set = new Set(expected);
  for (const [index, ref] of retrieved.entries()) {
    if (set.has(ref)) return round(1 / (index + 1));
  }
  return 0;
}

type QuestionResult = {
  id: string;
  bookId: string;
  bookLabel: string;
  category: GoldenCategory;
  question: string;
  expectedRefs: string[];
  retrievedRefs: string[];
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  toolPolicy: string;
  modelTier: string;
  numSearchQueries: number;
  plannerLatencyMs: number;
  searchLatencyMs: number;
  totalLatencyMs: number;
  embeddingInputTokens: number;
  plannerInputTokens: number;
  plannerOutputTokens: number;
};

type Aggregate = {
  questions: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  avgPlannerLatencyMs: number;
  avgSearchLatencyMs: number;
  avgTotalLatencyMs: number;
  p95TotalLatencyMs: number;
  totalEmbeddingInputTokens: number;
  totalPlannerInputTokens: number;
  totalPlannerOutputTokens: number;
  avgSearchQueries: number;
  policyRequiredRate: number;
};

function aggregate(rows: readonly QuestionResult[]): Aggregate {
  const n = rows.length;
  if (!n) {
    return {
      questions: 0,
      recallAt5: 0,
      recallAt10: 0,
      mrr: 0,
      avgPlannerLatencyMs: 0,
      avgSearchLatencyMs: 0,
      avgTotalLatencyMs: 0,
      p95TotalLatencyMs: 0,
      totalEmbeddingInputTokens: 0,
      totalPlannerInputTokens: 0,
      totalPlannerOutputTokens: 0,
      avgSearchQueries: 0,
      policyRequiredRate: 0,
    };
  }
  const sum = (key: keyof QuestionResult) =>
    rows.reduce((acc, row) => acc + (Number(row[key] as number) || 0), 0);
  const totals = rows.map((row) => row.totalLatencyMs);
  return {
    questions: n,
    recallAt5: round(sum("recallAt5") / n),
    recallAt10: round(sum("recallAt10") / n),
    mrr: round(sum("mrr") / n),
    avgPlannerLatencyMs: round(sum("plannerLatencyMs") / n, 2),
    avgSearchLatencyMs: round(sum("searchLatencyMs") / n, 2),
    avgTotalLatencyMs: round(sum("totalLatencyMs") / n, 2),
    p95TotalLatencyMs: percentile(totals, 0.95),
    totalEmbeddingInputTokens: sum("embeddingInputTokens"),
    totalPlannerInputTokens: sum("plannerInputTokens"),
    totalPlannerOutputTokens: sum("plannerOutputTokens"),
    avgSearchQueries: round(sum("numSearchQueries") / n, 3),
    policyRequiredRate: round(rows.filter((row) => row.toolPolicy === "required").length / n),
  };
}

type RetrievalReport = {
  version: "v1";
  generatedAt: string;
  enabledTools: BookChatToolName[];
  questions: QuestionResult[];
  perBook: Array<{ bookId: string; label: string; aggregate: Aggregate }>;
  overall: Aggregate;
  comparison?: {
    baselinePath: string;
    deltas: {
      recallAt5: number;
      recallAt10: number;
      mrr: number;
      avgTotalLatencyMs: number;
    };
  };
};

async function executePass(params: {
  questions: GoldenQuestion[];
  expectedRefById: Map<string, string>;
  bookLabels: Map<string, string>;
  enabledTools: BookChatToolName[];
  maxSearchQueries?: number;
  runLabel: string;
}): Promise<RetrievalReport> {
  const rows: QuestionResult[] = [];
  for (const [index, q] of params.questions.entries()) {
    process.stdout.write(`[${params.runLabel}] q${index + 1}/${params.questions.length} ${q.id}: ${q.question.slice(0, 70)}\n`);
    const result = await retrieveBookChatEvidence({
      bookId: q.bookId,
      userQuestion: q.question,
      enabledTools: params.enabledTools,
      maxSearchQueries: params.maxSearchQueries,
    });
    const expectedRefs = q.expectedParagraphIds.map((id) => params.expectedRefById.get(id) || "").filter(Boolean);
    rows.push({
      id: q.id,
      bookId: q.bookId,
      bookLabel: params.bookLabels.get(q.bookId) || q.bookId,
      category: q.category,
      question: q.question,
      expectedRefs,
      retrievedRefs: result.retrievedParagraphRefs,
      recallAt5: calculateRecall(expectedRefs, result.retrievedParagraphRefs, 5),
      recallAt10: calculateRecall(expectedRefs, result.retrievedParagraphRefs, 10),
      mrr: calculateMrr(expectedRefs, result.retrievedParagraphRefs),
      toolPolicy: result.plannerDecision.toolPolicy,
      modelTier: result.plannerDecision.modelTier,
      numSearchQueries: result.searchQueriesExecuted.length,
      plannerLatencyMs: result.metrics.plannerLatencyMs,
      searchLatencyMs: result.metrics.searchLatencyMs,
      totalLatencyMs: result.metrics.totalLatencyMs,
      embeddingInputTokens: result.metrics.embeddingInputTokens,
      plannerInputTokens: result.metrics.plannerInputTokens,
      plannerOutputTokens: result.metrics.plannerOutputTokens,
    });
  }

  const byBook = new Map<string, QuestionResult[]>();
  for (const row of rows) {
    const arr = byBook.get(row.bookId) || [];
    arr.push(row);
    byBook.set(row.bookId, arr);
  }
  const perBook = Array.from(byBook.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([bookId, bookRows]) => ({
      bookId,
      label: params.bookLabels.get(bookId) || bookId,
      aggregate: aggregate(bookRows),
    }));

  return {
    version: "v1",
    generatedAt: new Date().toISOString(),
    enabledTools: params.enabledTools,
    questions: rows,
    perBook,
    overall: aggregate(rows),
  };
}

const STABILITY_KEYS = [
  "recallAt5",
  "recallAt10",
  "mrr",
  "avgPlannerLatencyMs",
  "avgSearchLatencyMs",
  "avgTotalLatencyMs",
  "p95TotalLatencyMs",
  "policyRequiredRate",
] as const;

type StabilityKey = typeof STABILITY_KEYS[number];

function buildStability(reports: readonly RetrievalReport[]) {
  const out: Record<StabilityKey, { mean: number; min: number; max: number; spread: number; values: number[] }> =
    {} as any;
  for (const key of STABILITY_KEYS) {
    const values = reports.map((report) => Number(report.overall[key] || 0));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
    out[key] = {
      mean: round(mean),
      min: round(min),
      max: round(max),
      spread: round(max - min),
      values: values.map((v) => round(v)),
    };
  }
  return { runs: reports.length, metrics: out };
}

function buildAveragedReport(reports: RetrievalReport[]): RetrievalReport {
  const last = reports[reports.length - 1]!;
  const avg = aggregate(reports.flatMap((report) => report.questions));
  return { ...last, overall: avg, generatedAt: new Date().toISOString() };
}

async function findLatestBaseline(resultsDir: string): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(resultsDir);
  } catch {
    return null;
  }
  const candidates = files.filter(
    (file) =>
      (file.startsWith("retrieval-baseline-") || file.startsWith("retrieval-")) && file.endsWith(".json")
  );
  const stats = await Promise.all(
    candidates.map(async (file) => {
      const filePath = path.join(resultsDir, file);
      const stat0 = await stat(filePath);
      return { filePath, mtime: stat0.mtimeMs };
    })
  );
  stats.sort((left, right) => right.mtime - left.mtime);
  return stats[0]?.filePath || null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const goldenSetDir = resolvePath(DEFAULT_GOLDEN_SET_DIR);

  process.stdout.write(`\nRetrieval eval: runs=${options.runs}\n`);
  const questions = await loadGoldenQuestions(goldenSetDir);
  const expectedRefById = await loadExpectedRefs(questions);

  const bookIds = Array.from(new Set(questions.map((q) => q.bookId)));
  const bookLabels = new Map<string, string>();
  for (const id of bookIds) {
    const row = await prisma.book.findUnique({ where: { id }, select: { id: true, title: true } });
    if (!row) throw new Error(`Book not found: ${id}`);
    bookLabels.set(id, row.title || id);
  }

  const enabledTools = [...DEFAULT_ENABLED_BOOK_CHAT_TOOLS];

  const baselinePath = options.baselinePath
    ? resolvePath(options.baselinePath)
    : await findLatestBaseline(resolvePath(DEFAULT_RESULTS_DIR));

  const reports: RetrievalReport[] = [];
  const reportPaths: string[] = [];
  for (let i = 0; i < options.runs; i += 1) {
    const runLabel = options.runs > 1 ? `run ${i + 1}/${options.runs}` : "retrieval";
    if (options.runs > 1) process.stdout.write(`\n=== ${runLabel} ===\n`);
    const report = await executePass({
      questions,
      expectedRefById,
      bookLabels,
      enabledTools,
      maxSearchQueries: options.maxSearchQueries,
      runLabel,
    });
    reports.push(report);
    const suffix = options.runs > 1 ? `-run-${i + 1}` : "";
    const outFallback = options.outputPath
      ? options.outputPath.replace(/\.json$/i, `${suffix}.json`)
      : defaultOutputPath(suffix);
    const outPath = resolvePath(outFallback);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
    reportPaths.push(outPath);
    process.stdout.write(`  saved: ${outPath}\n`);
  }

  const stability = options.runs > 1 ? buildStability(reports) : null;
  const finalReport = stability ? buildAveragedReport(reports) : reports[0]!;

  if (baselinePath) {
    try {
      const baselineRaw = await readFile(baselinePath, "utf-8");
      const baseline = JSON.parse(baselineRaw) as RetrievalReport;
      if (baseline?.overall) {
        finalReport.comparison = {
          baselinePath,
          deltas: {
            recallAt5: round(finalReport.overall.recallAt5 - baseline.overall.recallAt5),
            recallAt10: round(finalReport.overall.recallAt10 - baseline.overall.recallAt10),
            mrr: round(finalReport.overall.mrr - baseline.overall.mrr),
            avgTotalLatencyMs: round(finalReport.overall.avgTotalLatencyMs - baseline.overall.avgTotalLatencyMs, 2),
          },
        };
      }
    } catch (err) {
      process.stdout.write(`(could not read baseline ${baselinePath}: ${(err as Error).message})\n`);
    }
  }

  let summaryPath: string | null = null;
  if (stability) {
    summaryPath = resolvePath(defaultOutputPath("-averaged"));
    await mkdir(path.dirname(summaryPath), { recursive: true });
    await writeFile(
      summaryPath,
      JSON.stringify({ ...finalReport, stability, runReports: reportPaths }, null, 2),
      "utf-8"
    );
  }

  let baselineCreatedPath: string | null = null;
  if (!baselinePath) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    baselineCreatedPath = resolvePath(`${DEFAULT_RESULTS_DIR}/retrieval-baseline-${ts}.json`);
    await copyFile(summaryPath || reportPaths[0]!, baselineCreatedPath);
  }

  process.stdout.write(`\n=== Retrieval summary ===\n`);
  process.stdout.write(
    `Overall: recall@5=${finalReport.overall.recallAt5}, recall@10=${finalReport.overall.recallAt10}, mrr=${finalReport.overall.mrr}, p95=${finalReport.overall.p95TotalLatencyMs}ms, avg=${finalReport.overall.avgTotalLatencyMs}ms\n`
  );
  for (const book of finalReport.perBook) {
    process.stdout.write(
      `  ${book.label.padEnd(36)} r@5=${book.aggregate.recallAt5} r@10=${book.aggregate.recallAt10} mrr=${book.aggregate.mrr} avgMs=${book.aggregate.avgTotalLatencyMs}\n`
    );
  }
  if (stability) {
    process.stdout.write(`Stability across ${stability.runs} runs:\n`);
    for (const key of STABILITY_KEYS) {
      const stat0 = stability.metrics[key];
      process.stdout.write(`  ${key.padEnd(22)} mean=${stat0.mean} spread=${stat0.spread}\n`);
    }
    if (summaryPath) process.stdout.write(`Saved averaged: ${summaryPath}\n`);
  }
  if (baselineCreatedPath) {
    process.stdout.write(`Saved baseline: ${baselineCreatedPath}\n`);
  }
  if (finalReport.comparison) {
    process.stdout.write(
      `Deltas vs baseline: r@5=${finalReport.comparison.deltas.recallAt5}, r@10=${finalReport.comparison.deltas.recallAt10}, mrr=${finalReport.comparison.deltas.mrr}, avgMs=${finalReport.comparison.deltas.avgTotalLatencyMs}\n`
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {
      // ignore
    }
  });
