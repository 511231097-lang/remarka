import { prisma } from "@remarka/db";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";
import type { SidebarProjectItem } from "@/lib/apiClient";
import { createProjectChapter } from "@/lib/projectState";
import { serializeLatestImportForProject } from "@/lib/projectImportState";

interface ProjectPageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ chapter?: string; entity?: string; mention?: string }>;
}

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params, searchParams }: ProjectPageProps) {
  const { projectId } = await Promise.resolve(params);
  const query = await Promise.resolve(searchParams);
  const requestedChapterId = String(query.chapter || "").trim() || null;
  const requestedEntityId = String(query.entity || "").trim() || null;
  const requestedMentionId = String(query.mention || "").trim() || null;
  const [project, projects] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: {
        chapters: {
          orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
        },
        projectImports: {
          orderBy: [{ createdAt: "desc" }],
          take: 1,
        },
      },
    }),
    prisma.project.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        chapters: {
          orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
        },
        projectImports: {
          orderBy: [{ createdAt: "desc" }],
          take: 1,
        },
      },
    }),
  ]);

  if (!project) {
    notFound();
  }

  let projectChapters = project.chapters;
  if (!projectChapters.length) {
    const firstChapter = await createProjectChapter(project.id, { title: "Новая глава" });
    const params = new URLSearchParams();
    params.set("chapter", firstChapter.id);
    if (requestedEntityId) params.set("entity", requestedEntityId);
    if (requestedMentionId) params.set("mention", requestedMentionId);
    redirect(`/projects/${project.id}?${params.toString()}`);
  }

  const selectedChapter =
    (requestedChapterId && projectChapters.find((chapter: any) => chapter.id === requestedChapterId)) ||
    projectChapters[0];

  if (!requestedChapterId || !selectedChapter || selectedChapter.id !== requestedChapterId) {
    const params = new URLSearchParams();
    params.set("chapter", selectedChapter.id);
    if (requestedEntityId) params.set("entity", requestedEntityId);
    if (requestedMentionId) params.set("mention", requestedMentionId);
    redirect(`/projects/${project.id}?${params.toString()}`);
  }

  const sidebarProjects: SidebarProjectItem[] = projects.map((item: any) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    chapters: item.chapters.map((chapter: any) => ({
      id: chapter.id,
      projectId: chapter.projectId,
      title: chapter.title,
      orderIndex: chapter.orderIndex,
      createdAt: chapter.createdAt.toISOString(),
      updatedAt: chapter.updatedAt.toISOString(),
    })),
    latestImport: serializeLatestImportForProject(item),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }));

  return (
    <AppShell projects={sidebarProjects} activeProjectId={project.id} activeChapterId={selectedChapter.id}>
      <ProjectWorkspace key={`${project.id}:${selectedChapter.id}`} projectId={project.id} chapterId={selectedChapter.id} />
    </AppShell>
  );
}
