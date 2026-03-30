import Link from "next/link";
import { prisma } from "@remarka/db";
import { AppShell } from "@/components/AppShell";
import type { SidebarProjectItem } from "@/lib/apiClient";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const projects = await prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      chapters: {
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  const sidebarProjects: SidebarProjectItem[] = projects.map((project: any) => ({
    id: project.id,
    title: project.title,
    description: project.description,
    chapters: project.chapters.map((chapter: any) => ({
      id: chapter.id,
      projectId: chapter.projectId,
      title: chapter.title,
      orderIndex: chapter.orderIndex,
      createdAt: chapter.createdAt.toISOString(),
      updatedAt: chapter.updatedAt.toISOString(),
    })),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  }));

  return (
    <AppShell projects={sidebarProjects} activeProjectId={null}>
      <div className="home-empty">
        <h1>Remarka Workspace</h1>
        <p>Выбери проект в левом сайдбаре или создай новый через кнопку +.</p>
        {sidebarProjects[0] ? (
          <Link
            href={
              sidebarProjects[0].chapters[0]
                ? `/projects/${sidebarProjects[0].id}?chapter=${sidebarProjects[0].chapters[0].id}`
                : `/projects/${sidebarProjects[0].id}`
            }
            className="button primary"
          >
            Открыть последний проект
          </Link>
        ) : null}
      </div>
    </AppShell>
  );
}
