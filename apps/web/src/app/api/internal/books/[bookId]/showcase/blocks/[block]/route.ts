import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { answerBookChatQuestion, BookChatError, runBookChatToolboxTool } from "@/lib/bookChatService";
import { INTERNAL_WORKER_TOKEN } from "@/lib/runtimeEnv";

export const runtime = "nodejs";

const INTERNAL_TOKEN = INTERNAL_WORKER_TOKEN;

type ShowcaseBlockName = "summary" | "themes" | "characters" | "events" | "quotes";

type RouteContext = {
  params: Promise<{
    bookId: string;
    block: string;
  }>;
};

const BLOCK_TOOLSET: Record<
  ShowcaseBlockName,
  readonly ["search_scenes" | "search_paragraphs_hybrid" | "get_scene_context", ...Array<"search_scenes" | "search_paragraphs_hybrid" | "get_scene_context">]
> = {
  summary: ["search_scenes", "get_scene_context"],
  themes: ["search_paragraphs_hybrid"],
  characters: ["search_paragraphs_hybrid"],
  events: ["search_scenes", "get_scene_context"],
  quotes: ["search_paragraphs_hybrid"],
};

const BLOCK_LEXICAL_QUERY: Partial<Record<ShowcaseBlockName, string>> = {
  themes: "основные темы и идеи книги",
  characters: "главные персонажи и их роль",
  quotes: "самые важные и популярные цитаты книги",
};

const summarySchema = z.object({
  shortSummary: z.string().trim().min(20).max(420),
  mainIdea: z.string().trim().min(20).max(420),
});

const themesSchema = z.object({
  themes: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().trim().min(12).max(320),
      })
    )
    .min(2)
    .max(6),
});

const charactersSchema = z.object({
  characters: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(140),
        description: z.string().trim().min(12).max(320),
        rank: z.coerce.number().int().min(1).max(32).optional(),
      })
    )
    .min(2)
    .max(8),
});

const eventsSchema = z.object({
  keyEvents: z
    .array(
      z.object({
        title: z.string().trim().min(3).max(140),
        description: z.string().trim().min(12).max(320),
        importance: z.enum(["critical", "high", "medium"]),
      })
    )
    .min(2)
    .max(8),
});

const quotesSchema = z.object({
  quotes: z
    .array(
      z.object({
        text: z.string().trim().min(10).max(360),
        chapterOrderIndex: z.coerce.number().int().positive().optional(),
        chapterTitle: z.string().trim().min(1).max(180).optional(),
      })
    )
    .min(2)
    .max(8),
});

function parseBlockName(value: string): ShowcaseBlockName {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized !== "summary" &&
    normalized !== "themes" &&
    normalized !== "characters" &&
    normalized !== "events" &&
    normalized !== "quotes"
  ) {
    throw new BookChatError("INVALID_BLOCK", 400, "Unsupported showcase block");
  }
  return normalized;
}

function parseJsonFromAnswer(answer: string): unknown {
  const text = String(answer || "").trim();
  if (!text) {
    throw new Error("Empty model answer");
  }

  try {
    return JSON.parse(text);
  } catch {
    // noop
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fencedMatch?.[1]) {
    const fenced = fencedMatch[1].trim();
    if (fenced) {
      return JSON.parse(fenced);
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }

  throw new Error("Model answer does not contain valid JSON object");
}

function sanitizeToken(value: unknown): string {
  return String(value || "").trim();
}

function buildPrompt(params: {
  block: ShowcaseBlockName;
  bookTitle: string;
  lexicalHints: Array<{ chapterOrderIndex: number; chapterTitle: string; paragraphIndex: number; text: string }>;
}): string {
  const lexicalSection = params.lexicalHints.length
    ? `\nДополнительные лексические подсказки (не выдумывай сверх них и tool-результатов):\n${JSON.stringify(
        params.lexicalHints
      )}`
    : "";

  if (params.block === "summary") {
    return `Сформируй блок витрины книги «${params.bookTitle}». Используй доступные инструменты поиска по книге.\nВерни ТОЛЬКО JSON без markdown.\nСхема:\n{"shortSummary":"1-2 предложения","mainIdea":"1-2 предложения"}\nТребования: факты только из книги, русский язык, без воды.`;
  }

  if (params.block === "themes") {
    return `Сформируй блок «Темы и идеи» для книги «${params.bookTitle}».\nИспользуй инструменты поиска, опирайся на найденные фрагменты.\nВерни ТОЛЬКО JSON:\n{"themes":[{"name":"...","description":"..."}]}\nОграничения: 4-6 тем, коротко, фактически, без повторов.${lexicalSection}`;
  }

  if (params.block === "characters") {
    return `Сформируй блок «Персонажи» для книги «${params.bookTitle}».\nИспользуй инструменты поиска, ранжируй от главных к второстепенным.\nВерни ТОЛЬКО JSON:\n{"characters":[{"name":"...","description":"...","rank":1}]}\nОграничения: 4-8 персонажей, rank начинается с 1, без дублей и без выдумки.${lexicalSection}`;
  }

  if (params.block === "events") {
    return `Сформируй блок «Ключевые события» для книги «${params.bookTitle}».\nИспользуй инструменты поиска сцен и контекста.\nВерни ТОЛЬКО JSON:\n{"keyEvents":[{"title":"...","description":"...","importance":"critical|high|medium"}]}\nОграничения: 4-8 событий, только доказуемые из текста.`;
  }

  return `Сформируй блок «Популярные цитаты» для книги «${params.bookTitle}».\nИспользуй инструменты поиска по абзацам.\nВерни ТОЛЬКО JSON:\n{"quotes":[{"text":"...","chapterOrderIndex":1,"chapterTitle":"..."}]}\nОграничения: 4-8 цитат, text должен быть дословным фрагментом из книги, без выдумки и без повторов.${lexicalSection}`;
}

async function loadLexicalHints(params: { block: ShowcaseBlockName; bookId: string }) {
  const query = BLOCK_LEXICAL_QUERY[params.block];
  if (!query) return [];

  try {
    const lexical = await runBookChatToolboxTool({
      bookId: params.bookId,
      tool: "search_paragraphs_lexical",
      args: {
        query,
        topK: 8,
      },
    });

    const hits = Array.isArray(lexical.output.hits) ? lexical.output.hits : [];
    return hits
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const item = row as Record<string, unknown>;
        return {
          chapterOrderIndex: Number(item.chapterOrderIndex || 0),
          chapterTitle: String(item.chapterTitle || "").trim(),
          paragraphIndex: Number(item.paragraphIndex || 0),
          text: String(item.text || "").trim(),
        };
      })
      .filter(
        (row): row is { chapterOrderIndex: number; chapterTitle: string; paragraphIndex: number; text: string } =>
          Boolean(row && row.chapterOrderIndex > 0 && row.paragraphIndex > 0 && row.text)
      )
      .slice(0, 8);
  } catch {
    return [];
  }
}

export async function POST(request: Request, context: RouteContext) {
  const token = sanitizeToken(request.headers.get("x-internal-token"));
  if (!token) {
    return NextResponse.json({ error: "Unauthorized", code: "INTERNAL_TOKEN_MISSING" }, { status: 401 });
  }
  if (!INTERNAL_TOKEN || token !== INTERNAL_TOKEN) {
    return NextResponse.json({ error: "Forbidden", code: "INTERNAL_TOKEN_INVALID" }, { status: 403 });
  }

  try {
    const params = await context.params;
    const bookId = String(params.bookId || "").trim();
    const block = parseBlockName(params.block);

    if (!bookId) {
      return NextResponse.json({ error: "bookId is required", code: "BOOK_ID_REQUIRED" }, { status: 400 });
    }

    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        title: true,
        analysisStatus: true,
      },
    });

    if (!book) {
      return NextResponse.json({ error: "Book not found", code: "BOOK_NOT_FOUND" }, { status: 404 });
    }

    if (book.analysisStatus !== "completed") {
      return NextResponse.json(
        {
          error: "Book analysis is not completed",
          code: "ANALYSIS_NOT_COMPLETED",
          analysisStatus: book.analysisStatus,
        },
        { status: 409 }
      );
    }

    const lexicalHints = await loadLexicalHints({ block, bookId: book.id });
    const prompt = buildPrompt({
      block,
      bookTitle: book.title,
      lexicalHints,
    });

    const result = await answerBookChatQuestion({
      bookId: book.id,
      enabledTools: [...BLOCK_TOOLSET[block]],
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const payload = parseJsonFromAnswer(result.answer);

    let item: unknown;
    if (block === "summary") {
      item = summarySchema.parse(payload);
    } else if (block === "themes") {
      item = themesSchema.parse(payload);
    } else if (block === "characters") {
      item = charactersSchema.parse(payload);
    } else if (block === "events") {
      item = eventsSchema.parse(payload);
    } else {
      item = quotesSchema.parse(payload);
    }

    return NextResponse.json({
      block,
      item,
      metrics: result.metrics,
      toolRuns: result.toolRuns,
      citations: result.citations,
    });
  } catch (error) {
    if (error instanceof BookChatError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "Invalid block payload from model",
          code: "INVALID_BLOCK_PAYLOAD",
          issues: error.issues,
        },
        { status: 502 }
      );
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to build showcase block",
        code: "SHOWCASE_BLOCK_FAILED",
      },
      { status: 500 }
    );
  }
}
