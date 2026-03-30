import { prisma } from "@remarka/db";
import { EntityTypeSchema } from "@remarka/contracts";

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
  const q = url.searchParams.get("q")?.trim() || "";
  const typeValue = url.searchParams.get("type")?.trim() || "";

  const parsedType = typeValue ? EntityTypeSchema.safeParse(typeValue) : null;
  if (typeValue && !parsedType?.success) {
    return Response.json({ error: "INVALID_TYPE" }, { status: 400 });
  }

  const entities = await prisma.entity.findMany({
    where: {
      projectId,
      ...(parsedType?.success ? { type: parsedType.data } : {}),
      ...(q
        ? {
            name: {
              contains: q,
              mode: "insensitive",
            },
          }
        : {}),
    },
    include: {
      _count: {
        select: {
          mentions: true,
        },
      },
    },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  const locationIds = entities.filter((entity: any) => entity.type === "location").map((entity: any) => entity.id);
  const containments = locationIds.length
    ? await prisma.locationContainment.findMany({
        where: {
          projectId,
          childEntityId: {
            in: locationIds,
          },
        },
        select: {
          childEntityId: true,
          parentEntityId: true,
        },
      })
    : [];
  const containerByChildId = new Map<string, string>();
  for (const containment of containments) {
    containerByChildId.set(containment.childEntityId, containment.parentEntityId);
  }

  return Response.json({
    entities: entities.map((entity: any) => ({
      id: entity.id,
      projectId: entity.projectId,
      type: entity.type,
      name: entity.name,
      containerEntityId: entity.type === "location" ? containerByChildId.get(entity.id) || null : null,
      summary: entity.summary,
      mentionCount: entity._count.mentions,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    })),
  });
}
