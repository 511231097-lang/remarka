import { NextResponse } from "next/server";
import {
  BookChatError,
  runBookChatToolboxTool,
  type BookChatToolboxToolName,
} from "@/lib/bookChatService";
import { resolveAuthUser } from "@/lib/authUser";
import { resolveAccessibleBook } from "@/lib/chatAccess";

export const runtime = "nodejs";

type ToolBody = {
  tool?: unknown;
  args?: unknown;
};

const TOOL_DESCRIPTIONS: Record<BookChatToolboxToolName, string> = {
  search_scenes: "Гибридный поиск сцен по книге (семантика + лексика, объединённые ранжированием).",
  search_paragraphs_hybrid: "Гибридный backend-поиск по абзацам (семантика + лексика, объединённые ранжированием).",
  get_scene_context: "Контекст по сценам и соседним сценам.",
  get_paragraph_slice: "Точный срез абзацев по chapterId и диапазону.",
  search_paragraphs_lexical: "Лексический backend-поиск по абзацам с детерминированным скорингом.",
};

function parseToolName(value: unknown): BookChatToolboxToolName {
  const tool = String(value || "").trim();
  if (
    tool !== "search_scenes" &&
    tool !== "search_paragraphs_hybrid" &&
    tool !== "get_scene_context" &&
    tool !== "get_paragraph_slice" &&
    tool !== "search_paragraphs_lexical"
  ) {
    throw new BookChatError("INVALID_TOOL", 400, "Unsupported tool");
  }
  return tool;
}

export async function GET() {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tools = (Object.keys(TOOL_DESCRIPTIONS) as BookChatToolboxToolName[]).map((tool) => ({
    name: tool,
    description: TOOL_DESCRIPTIONS[tool],
  }));

  return NextResponse.json({
    tools,
  });
}

export async function POST(
  request: Request,
  context: {
    params: Promise<{
      bookId: string;
    }>;
  }
) {
  const authUser = await resolveAuthUser();
  if (!authUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = (await request.json().catch(() => null)) as ToolBody | null;
    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body", code: "INVALID_JSON" }, { status: 400 });
    }

    const params = await context.params;
    const bookId = String(params.bookId || "").trim();
    const book = await resolveAccessibleBook({ bookId, userId: authUser.id });
    if (!book) return NextResponse.json({ error: "Book not found" }, { status: 404 });

    const tool = parseToolName(body.tool);
    const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};

    const startedAt = Date.now();
    const result = await runBookChatToolboxTool({
      bookId,
      tool,
      args: args as Record<string, unknown>,
    });

    return NextResponse.json({
      ...result,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (error instanceof BookChatError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    return NextResponse.json({ error: "Failed to run tool", code: "TOOL_RUN_FAILED" }, { status: 500 });
  }
}
