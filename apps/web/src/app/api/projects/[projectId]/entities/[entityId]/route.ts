import { prisma } from "@remarka/db";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string; entityId: string }>;
}

function buildMentionSnippet(
  content: string,
  startOffset: number,
  endOffset: number,
  sourceText: string
): string {
  const fullText = String(content || "");
  if (!fullText) {
    return sourceText;
  }

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
  if (!body) {
    return sourceText;
  }

  return `${from > 0 ? "… " : ""}${body}${to < fullText.length ? " …" : ""}`;
}

export async function GET(_request: Request, context: RouteContext) {
  const { projectId, entityId } = await Promise.resolve(context.params);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });

  if (!project) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const entity = await prisma.entity.findFirst({
    where: {
      id: entityId,
      projectId,
    },
    include: {
      aliases: {
        orderBy: [{ createdAt: "asc" }],
      },
      firstAppearanceChapter: {
        select: {
          id: true,
          title: true,
          orderIndex: true,
        },
      },
      lastAppearanceChapter: {
        select: {
          id: true,
          title: true,
          orderIndex: true,
        },
      },
      chapterStats: {
        include: {
          chapter: {
            select: {
              id: true,
              title: true,
              orderIndex: true,
            },
          },
        },
      },
      containedByLinks: {
        select: {
          parentEntity: {
            select: {
              id: true,
              type: true,
              canonicalName: true,
            },
          },
        },
      },
      containerLinks: {
        select: {
          childEntity: {
            select: {
              id: true,
              type: true,
              canonicalName: true,
            },
          },
        },
      },
      mentions: {
        include: {
          document: {
            select: {
              chapterId: true,
              contentVersion: true,
              content: true,
              chapter: {
                select: {
                  id: true,
                  title: true,
                  orderIndex: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!entity) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const containers = entity.containedByLinks
    .map((link: any) => link.parentEntity)
    .filter((value: any) => Boolean(value));
  const containedLocations = entity.containerLinks
    .map((link: any) => link.childEntity)
    .filter((value: any) => Boolean(value))
    .sort((a: any, b: any) => {
      const byType = String(a.type).localeCompare(String(b.type), "ru", { sensitivity: "base" });
      if (byType !== 0) return byType;
      return String(a.canonicalName).localeCompare(String(b.canonicalName), "ru", { sensitivity: "base" });
    });

  const sortedMentions = [...entity.mentions].sort((a: any, b: any) => {
    const chapterOrderA = Number(a.document?.chapter?.orderIndex ?? 0);
    const chapterOrderB = Number(b.document?.chapter?.orderIndex ?? 0);
    if (chapterOrderA !== chapterOrderB) return chapterOrderA - chapterOrderB;
    if (a.paragraphIndex !== b.paragraphIndex) return a.paragraphIndex - b.paragraphIndex;
    return a.startOffset - b.startOffset;
  });

  const snapshotMentions = sortedMentions.filter(
    (mention: any) => Number(mention.contentVersion) === Number(mention.document?.contentVersion)
  );

  const chapterPresence = [...entity.chapterStats]
    .filter((item: any) => item.chapter)
    .sort((a: any, b: any) => Number(a.chapter?.orderIndex ?? 0) - Number(b.chapter?.orderIndex ?? 0));

  return Response.json({
    entity: {
      id: entity.id,
      projectId: entity.projectId,
      type: entity.type,
      name: entity.canonicalName,
      canonicalName: entity.canonicalName,
      containerEntityId: containers[0]?.id || null,
      summary: entity.summary,
      shortDescription: entity.summary,
      mentionCount: entity.type === "character" ? Number(entity.mentionCount || 0) : snapshotMentions.length,
      firstAppearance:
        entity.type === "character" && entity.firstAppearanceChapter
          ? {
              chapterId: entity.firstAppearanceChapter.id,
              chapterTitle: entity.firstAppearanceChapter.title,
              chapterOrderIndex: entity.firstAppearanceChapter.orderIndex,
              offset: entity.firstAppearanceOffset,
            }
          : null,
      lastAppearance:
        entity.type === "character" && entity.lastAppearanceChapter
          ? {
              chapterId: entity.lastAppearanceChapter.id,
              chapterTitle: entity.lastAppearanceChapter.title,
              chapterOrderIndex: entity.lastAppearanceChapter.orderIndex,
              offset: entity.lastAppearanceOffset,
            }
          : null,
      chapters:
        entity.type === "character"
          ? chapterPresence.map((item: any) => ({
              chapterId: item.chapter.id,
              chapterTitle: item.chapter.title,
              chapterOrderIndex: item.chapter.orderIndex,
              mentionCount: item.mentionCount,
            }))
          : [],
      aliases:
        entity.type === "character"
          ? entity.aliases
              .map((alias: any) => ({
                id: alias.id,
                value: alias.alias,
                normalizedValue: alias.normalizedAlias,
                aliasType: alias.aliasType,
                confidence: alias.confidence,
              }))
              .sort((a: any, b: any) => String(a.value).localeCompare(String(b.value), "ru", { sensitivity: "base" }))
          : [],
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      containers: containers.map((container: any) => ({
        id: container.id,
        type: container.type,
        name: container.canonicalName,
      })),
      containedLocations: containedLocations.map((child: any) => ({
        id: child.id,
        type: child.type,
        name: child.canonicalName,
      })),
      mentions: snapshotMentions.map((mention: any) => ({
        id: mention.id,
        documentId: mention.documentId,
        chapterId: mention.document?.chapterId || null,
        chapterTitle: mention.document?.chapter?.title || null,
        mentionType: mention.mentionType,
        paragraphIndex: mention.paragraphIndex,
        startOffset: mention.startOffset,
        endOffset: mention.endOffset,
        sourceText: mention.sourceText,
        confidence: mention.confidence,
        snippet: buildMentionSnippet(
          String(mention.document?.content || ""),
          mention.startOffset,
          mention.endOffset,
          mention.sourceText
        ),
      })),
    },
  });
}
