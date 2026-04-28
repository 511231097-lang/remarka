import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@remarka/db";
import { workerConfig } from "./config";

export interface ShowcaseLogger {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

type ShowcaseBlockName = "summary" | "themes" | "characters" | "events" | "quotes";

type ShowcaseSummary = {
  shortSummary: string;
  mainIdea: string;
};

type ShowcaseTheme = {
  name: string;
  description: string;
};

type ShowcaseCharacter = {
  name: string;
  description: string;
  rank: number;
};

type ShowcaseEvent = {
  title: string;
  importance: "critical" | "high" | "medium";
  description: string;
};

type ShowcaseQuote = {
  text: string;
  chapterOrderIndex: number | null;
  chapterTitle: string | null;
};

type ShowcaseV2 = {
  summary: ShowcaseSummary;
  themes: ShowcaseTheme[];
  characters: ShowcaseCharacter[];
  keyEvents: ShowcaseEvent[];
  quotes: ShowcaseQuote[];
};

type BlockStats = {
  ok: boolean;
  usedFallback: boolean;
  attempts: number;
  elapsedMs: number;
  modelInputTokens: number;
  modelOutputTokens: number;
  modelTotalTokens: number;
  embeddingInputTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
};

const SHOWCASE_ARTIFACT_KEY = "showcase_v2";
const LEGACY_SHOWCASE_ARTIFACT_KEY = "showcase_v1";
const SHOWCASE_ARTIFACT_TITLE = "Book Showcase v2";
const BLOCK_ORDER: ShowcaseBlockName[] = ["summary", "themes", "characters", "events", "quotes"];

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return String(value || "").trim();
}

function asPositiveInt(value: unknown): number | null {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function clampText(value: unknown, maxChars: number): string {
  const text = asString(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function createOpaqueId(): string {
  return `c${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toImportanceLabel(value: ShowcaseEvent["importance"]): string {
  if (value === "critical") return "Критический";
  if (value === "high") return "Высокий";
  return "Средний";
}

function toBodyMarkdown(showcase: ShowcaseV2): string {
  const lines: string[] = [];
  lines.push("## Краткая сводка");
  lines.push(showcase.summary.shortSummary);
  lines.push("");
  lines.push("## Основная идея");
  lines.push(showcase.summary.mainIdea);
  lines.push("");
  lines.push("## Темы и идеи");
  for (const theme of showcase.themes) {
    lines.push(`- **${theme.name}**: ${theme.description}`);
  }
  lines.push("");
  lines.push("## Персонажи");
  for (const character of showcase.characters) {
    lines.push(`- **${character.name}** [#${character.rank}]: ${character.description}`);
  }
  lines.push("");
  lines.push("## Ключевые события");
  for (const event of showcase.keyEvents) {
    lines.push(`- **${event.title}** [${toImportanceLabel(event.importance)}]: ${event.description}`);
  }
  lines.push("");
  lines.push("## Популярные цитаты");
  for (const quote of showcase.quotes) {
    const location = quote.chapterOrderIndex ? ` (глава ${quote.chapterOrderIndex}${quote.chapterTitle ? `: ${quote.chapterTitle}` : ""})` : "";
    lines.push(`> ${quote.text}${location}`);
  }

  return lines.join("\n");
}

function uniqueBy<T>(rows: T[], keyOf: (item: T) => string): T[] {
  const dedupe = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (!key || dedupe.has(key)) continue;
    dedupe.add(key);
    out.push(row);
  }
  return out;
}

function normalizeSummary(value: unknown, fallback: ShowcaseSummary): ShowcaseSummary {
  const row = asRecord(value);
  const shortSummary = clampText(row.shortSummary, 420) || fallback.shortSummary;
  const mainIdea = clampText(row.mainIdea, 420) || fallback.mainIdea;
  return {
    shortSummary,
    mainIdea,
  };
}

function normalizeThemes(value: unknown, fallback: ShowcaseTheme[]): ShowcaseTheme[] {
  const out = asArray(value)
    .map((row) => {
      const item = asRecord(row);
      const name = clampText(item.name, 120);
      const description = clampText(item.description, 320);
      if (!name || !description) return null;
      return { name, description } satisfies ShowcaseTheme;
    })
    .filter((row): row is ShowcaseTheme => Boolean(row));

  const unique = uniqueBy(out, (item) => item.name.toLocaleLowerCase("ru"));
  if (unique.length > 0) return unique.slice(0, 6);
  return fallback;
}

function normalizeCharacters(value: unknown, fallback: ShowcaseCharacter[]): ShowcaseCharacter[] {
  const out = asArray(value)
    .map((row, index) => {
      const item = asRecord(row);
      const name = clampText(item.name, 140);
      const description = clampText(item.description, 320);
      const rank = Math.max(1, Math.min(32, asPositiveInt(item.rank) || index + 1));
      if (!name || !description) return null;
      return { name, description, rank } satisfies ShowcaseCharacter;
    })
    .filter((row): row is ShowcaseCharacter => Boolean(row));

  const unique = uniqueBy(
    out.sort((left, right) => left.rank - right.rank),
    (item) => item.name.toLocaleLowerCase("ru")
  ).map((row, index) => ({ ...row, rank: index + 1 }));

  if (unique.length > 0) return unique.slice(0, 8);
  return fallback;
}

function normalizeEvents(value: unknown, fallback: ShowcaseEvent[]): ShowcaseEvent[] {
  const out = asArray(value)
    .map((row) => {
      const item = asRecord(row);
      const title = clampText(item.title, 140);
      const description = clampText(item.description, 320);
      const importanceRaw = asString(item.importance).toLowerCase();
      const importance =
        importanceRaw === "critical" || importanceRaw === "high" || importanceRaw === "medium"
          ? (importanceRaw as ShowcaseEvent["importance"])
          : null;
      if (!title || !description || !importance) return null;
      return {
        title,
        description,
        importance,
      } satisfies ShowcaseEvent;
    })
    .filter((row): row is ShowcaseEvent => Boolean(row));

  const unique = uniqueBy(out, (item) => item.title.toLocaleLowerCase("ru"));
  if (unique.length > 0) return unique.slice(0, 8);
  return fallback;
}

function normalizeQuotes(value: unknown): ShowcaseQuote[] {
  const out = asArray(value)
    .map((row) => {
      const item = asRecord(row);
      const text = clampText(item.text, 360);
      const chapterOrderIndex = asPositiveInt(item.chapterOrderIndex);
      const chapterTitle = clampText(item.chapterTitle, 180) || null;
      if (!text || text.length < 10) return null;
      return {
        text,
        chapterOrderIndex,
        chapterTitle,
      } satisfies ShowcaseQuote;
    })
    .filter((row): row is ShowcaseQuote => Boolean(row));

  return uniqueBy(out, (item) => item.text.toLocaleLowerCase("ru")).slice(0, 8);
}

function fallbackSummary(bookTitle: string, sourceSummary: string): ShowcaseSummary {
  return {
    shortSummary:
      clampText(sourceSummary, 420) ||
      `Книга «${bookTitle}» раскрывает несколько взаимосвязанных сюжетных линий и ключевых персонажей.`,
    mainIdea: "Главная идея произведения раскрывается через последствия выборов героев и развитие центральных конфликтов.",
  };
}

function emptyBlockStats(params?: Partial<BlockStats>): BlockStats {
  return {
    ok: Boolean(params?.ok),
    usedFallback: Boolean(params?.usedFallback),
    attempts: Math.max(0, Math.floor(asNumber(params?.attempts, 0))),
    elapsedMs: Math.max(0, Math.round(asNumber(params?.elapsedMs, 0))),
    modelInputTokens: Math.max(0, Math.round(asNumber(params?.modelInputTokens, 0))),
    modelOutputTokens: Math.max(0, Math.round(asNumber(params?.modelOutputTokens, 0))),
    modelTotalTokens: Math.max(0, Math.round(asNumber(params?.modelTotalTokens, 0))),
    embeddingInputTokens: Math.max(0, Math.round(asNumber(params?.embeddingInputTokens, 0))),
    totalCostUsd: Math.max(0, Number(asNumber(params?.totalCostUsd, 0).toFixed(8))),
    totalLatencyMs: Math.max(0, Math.round(asNumber(params?.totalLatencyMs, 0))),
  };
}

type InternalBlockResponse = {
  item: unknown;
  metrics: unknown;
};

async function requestShowcaseBlock(params: {
  bookId: string;
  block: ShowcaseBlockName;
  logger: ShowcaseLogger;
}): Promise<{ response: InternalBlockResponse; elapsedMs: number }> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5_000, workerConfig.showcaseInternalApi.timeoutMs));

  try {
    const response = await fetch(
      `${workerConfig.showcaseInternalApi.baseUrl}/api/internal/books/${encodeURIComponent(params.bookId)}/showcase/blocks/${params.block}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": workerConfig.showcaseInternalApi.token,
        },
        body: "{}",
        signal: controller.signal,
      }
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const body = asRecord(payload);
      const message = asString(body.error) || `Internal showcase block request failed (${response.status})`;
      throw new Error(message);
    }

    const body = asRecord(payload);
    return {
      response: {
        item: body.item,
        metrics: body.metrics,
      },
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function blockMetricsToStats(metricsValue: unknown, base: { elapsedMs: number; attempts: number; ok: boolean; usedFallback: boolean }): BlockStats {
  const metrics = asRecord(metricsValue);
  return emptyBlockStats({
    ok: base.ok,
    usedFallback: base.usedFallback,
    attempts: base.attempts,
    elapsedMs: base.elapsedMs,
    modelInputTokens: asNumber(metrics.modelInputTokens, 0),
    modelOutputTokens: asNumber(metrics.modelOutputTokens, 0),
    modelTotalTokens: asNumber(metrics.modelTotalTokens, 0),
    embeddingInputTokens: asNumber(metrics.embeddingInputTokens, 0),
    totalCostUsd: asNumber(metrics.totalCostUsd, 0),
    totalLatencyMs: asNumber(metrics.totalLatencyMs, base.elapsedMs),
  });
}

async function runBlockWithRetry(params: {
  bookId: string;
  block: ShowcaseBlockName;
  logger: ShowcaseLogger;
}): Promise<{ ok: boolean; usedFallback: boolean; item: unknown; stats: BlockStats }> {
  const maxAttempts = Math.max(1, workerConfig.showcaseInternalApi.maxRetries + 1);
  let totalElapsedMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const run = await requestShowcaseBlock({
        bookId: params.bookId,
        block: params.block,
        logger: params.logger,
      });
      totalElapsedMs += run.elapsedMs;

      return {
        ok: true,
        usedFallback: false,
        item: run.response.item,
        stats: blockMetricsToStats(run.response.metrics, {
          attempts: attempt,
          elapsedMs: totalElapsedMs,
          ok: true,
          usedFallback: false,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.logger.warn("Showcase block request failed", {
        bookId: params.bookId,
        block: params.block,
        attempt,
        maxAttempts,
        error: message,
      });

      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
      }
    }
  }

  return {
    ok: false,
    usedFallback: true,
    item: null,
    stats: emptyBlockStats({
      ok: false,
      usedFallback: true,
      attempts: maxAttempts,
      elapsedMs: totalElapsedMs,
    }),
  };
}

export async function runBookShowcaseBuild(params: { bookId: string; logger: ShowcaseLogger }) {
  const startedAt = Date.now();
  const book = await prisma.book.findUnique({
    where: { id: params.bookId },
    select: {
      id: true,
      title: true,
      summary: true,
      chapterCount: true,
      analysisStatus: true,
    },
  });

  if (!book) {
    throw new Error("Book not found");
  }

  if (book.analysisStatus !== "completed") {
    throw new Error(`Book is not ready for showcase build: ${book.analysisStatus}`);
  }

  const summaryFallback = fallbackSummary(book.title, asString(book.summary));
  const themeFallback: ShowcaseTheme[] = [
    {
      name: "Основные конфликты",
      description: "Ключевые темы формируются через столкновение ценностей, целей и последствий решений героев.",
    },
  ];
  const characterFallback: ShowcaseCharacter[] = [];
  const eventFallback: ShowcaseEvent[] = [];

  const blockResults = {
    summary: await runBlockWithRetry({ bookId: book.id, block: "summary", logger: params.logger }),
    themes: await runBlockWithRetry({ bookId: book.id, block: "themes", logger: params.logger }),
    characters: await runBlockWithRetry({ bookId: book.id, block: "characters", logger: params.logger }),
    events: await runBlockWithRetry({ bookId: book.id, block: "events", logger: params.logger }),
    quotes: await runBlockWithRetry({ bookId: book.id, block: "quotes", logger: params.logger }),
  } as const;

  const showcase: ShowcaseV2 = {
    summary: normalizeSummary(blockResults.summary.item, summaryFallback),
    themes: normalizeThemes(asRecord(blockResults.themes.item).themes, themeFallback),
    characters: normalizeCharacters(asRecord(blockResults.characters.item).characters, characterFallback),
    keyEvents: normalizeEvents(asRecord(blockResults.events.item).keyEvents, eventFallback),
    quotes: normalizeQuotes(asRecord(blockResults.quotes.item).quotes),
  };

  const fallbackBlocks = BLOCK_ORDER.filter((block) => blockResults[block].usedFallback);
  const generationMode = fallbackBlocks.length > 0 ? "fallback" : "chat_blocks";

  const bodyMarkdown = toBodyMarkdown(showcase);
  const metadataJson = {
    schemaVersion: SHOWCASE_ARTIFACT_KEY,
    generatedAt: new Date().toISOString(),
    generationMode,
    showcase,
    stats: {
      chapterCount: Math.max(0, Number(book.chapterCount || 0)),
      totalElapsedMs: Date.now() - startedAt,
      fallbackBlocks,
      blocks: {
        summary: blockResults.summary.stats,
        themes: blockResults.themes.stats,
        characters: blockResults.characters.stats,
        events: blockResults.events.stats,
        quotes: blockResults.quotes.stats,
      },
    },
  } as const;

  await prisma.$transaction(async (tx) => {
    await tx.bookSummaryArtifact.deleteMany({
      where: {
        bookId: book.id,
        kind: "book_brief",
        key: LEGACY_SHOWCASE_ARTIFACT_KEY,
      },
    });

    await tx.bookSummaryArtifact.upsert({
      where: {
        bookId_kind_key: {
          bookId: book.id,
          kind: "book_brief",
          key: SHOWCASE_ARTIFACT_KEY,
        },
      },
      update: {
        title: SHOWCASE_ARTIFACT_TITLE,
        summary: showcase.summary.shortSummary,
        bodyMarkdown,
        metadataJson: metadataJson as unknown as Prisma.InputJsonValue,
        confidence: generationMode === "chat_blocks" ? 0.84 : 0.62,
      },
      create: {
        id: createOpaqueId(),
        bookId: book.id,
        kind: "book_brief",
        key: SHOWCASE_ARTIFACT_KEY,
        title: SHOWCASE_ARTIFACT_TITLE,
        summary: showcase.summary.shortSummary,
        bodyMarkdown,
        metadataJson: metadataJson as unknown as Prisma.InputJsonValue,
        confidence: generationMode === "chat_blocks" ? 0.84 : 0.62,
      },
    });
  });

  params.logger.info("Book showcase built", {
    bookId: book.id,
    generationMode,
    fallbackBlocks,
    themeCount: showcase.themes.length,
    characterCount: showcase.characters.length,
    eventCount: showcase.keyEvents.length,
    quoteCount: showcase.quotes.length,
  });
}
