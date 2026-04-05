import { prisma } from "@remarka/db";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

function buildMentionSnippet(content: string, startOffset: number, endOffset: number, sourceText: string): string {
  const fullText = String(content || "");
  if (!fullText) return sourceText;

  const safeStart = Math.max(0, Math.min(startOffset, fullText.length));
  const safeEnd = Math.max(safeStart, Math.min(endOffset, fullText.length));
  const radius = 96;

  let from = Math.max(0, safeStart - radius);
  let to = Math.min(fullText.length, safeEnd + radius);

  const leftSpace = fullText.lastIndexOf(" ", from);
  if (leftSpace >= 0 && safeStart - leftSpace <= 28) {
    from = leftSpace + 1;
  }

  const rightSpace = fullText.indexOf(" ", to);
  if (rightSpace >= 0 && rightSpace - safeEnd <= 28) {
    to = rightSpace;
  }

  const body = fullText.slice(from, to).replace(/\s+/g, " ").trim();
  if (!body) return sourceText;

  return `${from > 0 ? "… " : ""}${body}${to < fullText.length ? " …" : ""}`;
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
  const q = url.searchParams.get("q")?.trim() || "";
  const limitRaw = Number.parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;

  if (!q) {
    return Response.json({ characters: [], mentions: [] });
  }

  const [characters, mentionRows] = await Promise.all([
    prisma.entity.findMany({
      where: {
        projectId,
        type: "character",
        mergedIntoEntityId: null,
        mentionCount: {
          gt: 0,
        },
        OR: [
          {
            canonicalName: {
              contains: q,
              mode: "insensitive",
            },
          },
          {
            aliases: {
              some: {
                alias: {
                  contains: q,
                  mode: "insensitive",
                },
              },
            },
          },
        ],
      },
      include: {
        aliases: {
          orderBy: [{ createdAt: "asc" }],
        },
      },
      orderBy: [{ mentionCount: "desc" }, { canonicalName: "asc" }],
      take: limit,
    }),
    prisma.mention.findMany({
      where: {
        entity: {
          projectId,
          type: "character",
          mergedIntoEntityId: null,
        },
        sourceText: {
          contains: q,
          mode: "insensitive",
        },
      },
      include: {
        entity: {
          select: {
            id: true,
            canonicalName: true,
            mentionCount: true,
          },
        },
        document: {
          select: {
            id: true,
            chapterId: true,
            contentVersion: true,
            content: true,
            chapter: {
              select: {
                title: true,
                orderIndex: true,
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }],
      take: limit * 4,
    }),
  ]);

  const mentions = mentionRows
    .filter((item) => Number(item.contentVersion) === Number(item.document?.contentVersion))
    .sort((a, b) => {
      const chapterOrderA = Number(a.document?.chapter?.orderIndex ?? 0);
      const chapterOrderB = Number(b.document?.chapter?.orderIndex ?? 0);
      if (chapterOrderA !== chapterOrderB) return chapterOrderA - chapterOrderB;
      if (a.paragraphIndex !== b.paragraphIndex) return a.paragraphIndex - b.paragraphIndex;
      return a.startOffset - b.startOffset;
    })
    .slice(0, limit)
    .map((mention) => ({
      id: mention.id,
      entityId: mention.entityId,
      canonicalName: mention.entity.canonicalName,
      chapterId: mention.document?.chapterId || null,
      chapterTitle: mention.document?.chapter?.title || null,
      mentionType: mention.mentionType,
      startOffset: mention.startOffset,
      endOffset: mention.endOffset,
      confidence: mention.confidence,
      sourceText: mention.sourceText,
      snippet: buildMentionSnippet(String(mention.document?.content || ""), mention.startOffset, mention.endOffset, mention.sourceText),
    }));

  return Response.json({
    characters: characters.map((character) => ({
      id: character.id,
      canonicalName: character.canonicalName,
      shortDescription: character.summary,
      mentionCount: character.mentionCount,
      aliases: character.aliases
        .map((alias) => ({
          id: alias.id,
          value: alias.alias,
          aliasType: alias.aliasType,
        }))
        .sort((a, b) => String(a.value).localeCompare(String(b.value), "ru", { sensitivity: "base" })),
    })),
    mentions,
  });
}
