import { prisma } from "@remarka/db";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectId: string }>;
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
  const chapterId = url.searchParams.get("chapter")?.trim() || null;

  const acts = await prisma.act.findMany({
    where: {
      projectId,
      ...(chapterId
        ? {
            chapterId,
          }
        : {}),
    },
    include: {
      chapter: {
        select: {
          id: true,
          title: true,
          orderIndex: true,
        },
      },
      document: {
        select: {
          id: true,
          contentVersion: true,
        },
      },
    },
    orderBy: [
      { chapter: { orderIndex: "asc" } },
      { orderIndex: "asc" },
      { createdAt: "asc" },
    ],
  });

  const currentActs = acts.filter((act) => Number(act.contentVersion) === Number(act.document?.contentVersion));
  const actIds = currentActs.map((act) => act.id);

  const characterStats = actIds.length
    ? await prisma.characterActStat.findMany({
        where: {
          actId: {
            in: actIds,
          },
        },
        include: {
          character: {
            select: {
              id: true,
              canonicalName: true,
              mergedIntoEntityId: true,
            },
          },
          act: {
            select: {
              chapter: {
                select: {
                  orderIndex: true,
                },
              },
            },
          },
        },
        orderBy: [{ mentionCount: "desc" }, { character: { canonicalName: "asc" } }],
      })
    : [];

  const charactersByActId = new Map<
    string,
    Array<{ id: string; name: string; mentionCount: number }>
  >();

  for (const stat of characterStats) {
    if (!stat.character || stat.character.mergedIntoEntityId) continue;
    const bucket = charactersByActId.get(stat.actId) || [];
    bucket.push({
      id: stat.character.id,
      name: stat.character.canonicalName,
      mentionCount: stat.mentionCount,
    });
    charactersByActId.set(stat.actId, bucket);
  }

  return Response.json({
    acts: currentActs.map((act) => ({
      id: act.id,
      projectId: act.projectId,
      chapterId: act.chapterId,
      chapterTitle: act.chapter.title,
      chapterOrderIndex: act.chapter.orderIndex,
      documentId: act.documentId,
      contentVersion: act.contentVersion,
      orderIndex: act.orderIndex,
      title: act.title,
      summary: act.summary,
      paragraphStart: act.paragraphStart,
      paragraphEnd: act.paragraphEnd,
      characters: charactersByActId.get(act.id) || [],
    })),
  });
}
