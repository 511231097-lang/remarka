import { createProject, listProjects } from "@/lib/projectState";
import { z } from "zod";

export const runtime = "nodejs";

const CreateProjectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
});

export async function GET() {
  const projects = await listProjects();

  return Response.json({
    projects: projects.map((project) => ({
      id: project.id,
      title: project.title,
      description: project.description,
      chapters: project.chapters.map((chapter) => ({
        id: chapter.id,
        projectId: chapter.projectId,
        title: chapter.title,
        orderIndex: chapter.orderIndex,
        createdAt: chapter.createdAt.toISOString(),
        updatedAt: chapter.updatedAt.toISOString(),
      })),
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    })),
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const input = CreateProjectSchema.parse(body);

    const project = await createProject(input);

    return Response.json(
      {
        project: {
          id: project.id,
          title: project.title,
          description: project.description,
          chapters: project.chapters.map((chapter) => ({
            id: chapter.id,
            projectId: chapter.projectId,
            title: chapter.title,
            orderIndex: chapter.orderIndex,
            createdAt: chapter.createdAt.toISOString(),
            updatedAt: chapter.updatedAt.toISOString(),
          })),
          firstChapterId: project.chapters[0]?.id ?? null,
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString(),
        },
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          error: "VALIDATION_ERROR",
          issues: error.issues,
        },
        { status: 400 }
      );
    }

    return Response.json(
      {
        error: "INTERNAL_ERROR",
      },
      { status: 500 }
    );
  }
}
