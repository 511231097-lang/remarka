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
      actStats: {
        include: {
          act: {
            select: {
              id: true,
              title: true,
              orderIndex: true,
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
      appearanceObservations: {
        include: {
          chapter: {
            select: {
              id: true,
              title: true,
              orderIndex: true,
            },
          },
          act: {
            select: {
              id: true,
              title: true,
              orderIndex: true,
            },
          },
          document: {
            select: {
              contentVersion: true,
            },
          },
          evidence: {
            include: {
              mention: {
                select: {
                  id: true,
                  paragraphIndex: true,
                  startOffset: true,
                  endOffset: true,
                  sourceText: true,
                  document: {
                    select: {
                      chapterId: true,
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
            orderBy: [{ evidenceOrder: "asc" }],
          },
        },
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
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
          act: {
            select: {
              id: true,
              title: true,
              orderIndex: true,
            },
          },
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
    const actOrderA = Number(a.act?.orderIndex ?? Number.MAX_SAFE_INTEGER);
    const actOrderB = Number(b.act?.orderIndex ?? Number.MAX_SAFE_INTEGER);
    if (actOrderA !== actOrderB) return actOrderA - actOrderB;
    if (a.paragraphIndex !== b.paragraphIndex) return a.paragraphIndex - b.paragraphIndex;
    return a.startOffset - b.startOffset;
  });

  const snapshotMentions = sortedMentions.filter(
    (mention: any) => Number(mention.contentVersion) === Number(mention.document?.contentVersion)
  );

  const chapterPresence = [...entity.chapterStats]
    .filter((item: any) => item.chapter)
    .sort((a: any, b: any) => Number(a.chapter?.orderIndex ?? 0) - Number(b.chapter?.orderIndex ?? 0));
  const actPresence = [...entity.actStats]
    .filter((item: any) => item.act?.chapter)
    .sort((a: any, b: any) => {
      const chapterOrderA = Number(a.act?.chapter?.orderIndex ?? 0);
      const chapterOrderB = Number(b.act?.chapter?.orderIndex ?? 0);
      if (chapterOrderA !== chapterOrderB) return chapterOrderA - chapterOrderB;
      return Number(a.act?.orderIndex ?? 0) - Number(b.act?.orderIndex ?? 0);
    });
  const appearanceTimeline = [...entity.appearanceObservations]
    .filter((item: any) => Number(item.contentVersion) === Number(item.document?.contentVersion))
    .sort((a: any, b: any) => {
      const chapterOrderA = Number(a.chapter?.orderIndex ?? 0);
      const chapterOrderB = Number(b.chapter?.orderIndex ?? 0);
      if (chapterOrderA !== chapterOrderB) return chapterOrderA - chapterOrderB;
      const actOrderA = Number(a.act?.orderIndex ?? Number.MAX_SAFE_INTEGER);
      const actOrderB = Number(b.act?.orderIndex ?? Number.MAX_SAFE_INTEGER);
      if (actOrderA !== actOrderB) return actOrderA - actOrderB;
      if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
      return Number(new Date(a.createdAt).getTime()) - Number(new Date(b.createdAt).getTime());
    });

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
      acts:
        entity.type === "character"
          ? actPresence.map((item: any) => ({
              actId: item.act.id,
              chapterId: item.act.chapter.id,
              chapterTitle: item.act.chapter.title,
              chapterOrderIndex: item.act.chapter.orderIndex,
              actOrderIndex: item.act.orderIndex,
              actTitle: item.act.title,
              mentionCount: item.mentionCount,
            }))
          : [],
      appearanceObservations:
        entity.type === "character"
          ? appearanceTimeline.map((item: any) => ({
              id: item.id,
              characterId: item.characterId,
              chapterId: item.chapter.id,
              chapterTitle: item.chapter.title,
              chapterOrderIndex: item.chapter.orderIndex,
              actId: item.act?.id || null,
              actTitle: item.act?.title || null,
              actOrderIndex: item.act?.orderIndex ?? null,
              orderIndex: item.orderIndex,
              attributeKey: item.attributeKey,
              attributeLabel: item.attributeLabel,
              value: item.valueText,
              summary: item.summary,
              scope: item.scope,
              confidence: item.confidence,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              evidence: item.evidence.map((evidence: any) => ({
                id: evidence.id,
                mentionId: evidence.mentionId,
                chapterId: evidence.mention?.document?.chapterId || null,
                chapterTitle: evidence.mention?.document?.chapter?.title || null,
                chapterOrderIndex: evidence.mention?.document?.chapter?.orderIndex ?? null,
                paragraphIndex: evidence.paragraphIndex,
                startOffset: evidence.startOffset,
                endOffset: evidence.endOffset,
                sourceText: evidence.sourceText,
                snippet: evidence.snippet,
              })),
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
        actId: mention.act?.id || null,
        actTitle: mention.act?.title || null,
        actOrderIndex: mention.act?.orderIndex ?? null,
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
