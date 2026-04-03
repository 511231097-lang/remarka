"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconMenu2,
  IconMoonStars,
  IconPencil,
  IconPlus,
  IconSunHigh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import {
  createProjectChapterRequest,
  createProjectRequest,
  deleteProjectChapterRequest,
  updateProjectChapterRequest,
  type ChapterMoveDirection,
  type SidebarProjectItem,
} from "@/lib/apiClient";

interface AppShellProps {
  projects: SidebarProjectItem[];
  activeProjectId: string | null;
  activeChapterId?: string | null;
  children: React.ReactNode;
}

type ThemeMode = "light" | "dark";

function applyTheme(theme: ThemeMode) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("remarka-theme", theme);
}

function resolveInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";

  const stored = localStorage.getItem("remarka-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function buildProjectHref(projectId: string, chapterId: string | null | undefined): string {
  return chapterId ? `/projects/${projectId}?chapter=${encodeURIComponent(chapterId)}` : `/projects/${projectId}`;
}

export function AppShell({ projects, activeProjectId, activeChapterId = null, children }: AppShellProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [creatingChapterProjectId, setCreatingChapterProjectId] = useState<string | null>(null);
  const [chapterBusyKey, setChapterBusyKey] = useState<string | null>(null);
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [editingChapterTitle, setEditingChapterTitle] = useState("");
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [chapterError, setChapterError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [isThemeReady, setIsThemeReady] = useState(false);

  useEffect(() => {
    setTheme(resolveInitialTheme());
    setIsThemeReady(true);
  }, []);

  useEffect(() => {
    if (!isThemeReady) return;
    applyTheme(theme);
  }, [theme, isThemeReady]);

  const sortedProjects = useMemo(() => {
    return [...projects]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((project) => ({
        ...project,
        chapters: [...project.chapters].sort((a, b) => {
          if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        }),
      }));
  }, [projects]);

  const chapterFromUrl = useMemo(() => searchParams.get("chapter")?.trim() || null, [searchParams]);
  const resolvedActiveChapterId = chapterFromUrl || activeChapterId;

  useEffect(() => {
    if (!activeProjectId) return;
    setCollapsedProjects((current) => {
      if (Object.prototype.hasOwnProperty.call(current, activeProjectId)) {
        return current;
      }
      return { ...current, [activeProjectId]: false };
    });
  }, [activeProjectId]);

  const activeProjectTitle = useMemo(() => {
    const byActiveId = activeProjectId ? projects.find((project) => project.id === activeProjectId) : null;

    const pathMatch = pathname.match(/^\/projects\/([^/?#]+)/);
    const projectIdFromPath = pathMatch?.[1] || null;
    const byPath = projectIdFromPath ? projects.find((project) => project.id === projectIdFromPath) : null;

    const activeProject = byActiveId || byPath;
    if (!activeProject?.title) return "Remarka";

    const chapterIds = [chapterFromUrl, activeChapterId].filter((value): value is string => Boolean(value));
    const activeChapter =
      chapterIds
        .map((chapterId) => activeProject.chapters.find((chapter) => chapter.id === chapterId))
        .find((chapter): chapter is NonNullable<typeof chapter> => Boolean(chapter)) || activeProject.chapters[0] || null;

    if (activeChapter?.title) {
      return `${activeProject.title}. ${activeChapter.title}`;
    }

    return activeProject.title;
  }, [activeProjectId, activeChapterId, chapterFromUrl, pathname, projects]);

  async function handleCreateProject(formData: FormData) {
    const title = String(formData.get("title") || "").trim();
    const description = String(formData.get("description") || "").trim();

    if (!title) {
      setCreateError("Введите название проекта");
      return;
    }

    setCreateError(null);
    setIsSavingProject(true);
    try {
      const project = await createProjectRequest({
        title,
        description: description || null,
      });
      setIsCreateOpen(false);
      setIsSidebarOpen(false);
      router.push(buildProjectHref(project.id, project.firstChapterId));
      router.refresh();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Не удалось создать проект");
    } finally {
      setIsSavingProject(false);
    }
  }

  async function handleCreateChapter(projectId: string) {
    setChapterError(null);
    setCreatingChapterProjectId(projectId);
    try {
      const chapter = await createProjectChapterRequest(projectId, {
        title: "Новая глава",
      });
      setCollapsedProjects((current) => ({ ...current, [projectId]: false }));
      setIsSidebarOpen(false);
      router.push(buildProjectHref(projectId, chapter.id));
      router.refresh();
    } catch (error) {
      setChapterError(error instanceof Error ? error.message : "Не удалось создать главу");
    } finally {
      setCreatingChapterProjectId(null);
    }
  }

  function handleStartChapterRename(chapterId: string, currentTitle: string) {
    setChapterError(null);
    setEditingChapterId(chapterId);
    setEditingChapterTitle(currentTitle);
  }

  function handleCancelChapterRename() {
    setEditingChapterId(null);
    setEditingChapterTitle("");
  }

  async function handleRenameChapter(projectId: string, chapterId: string) {
    const title = editingChapterTitle.trim();
    if (!title) {
      setChapterError("Название главы не может быть пустым");
      return;
    }

    setChapterError(null);
    setChapterBusyKey(`${projectId}:${chapterId}:rename`);
    try {
      await updateProjectChapterRequest(projectId, chapterId, { title });
      setEditingChapterId(null);
      setEditingChapterTitle("");
      router.refresh();
    } catch (error) {
      setChapterError(error instanceof Error ? error.message : "Не удалось переименовать главу");
    } finally {
      setChapterBusyKey(null);
    }
  }

  async function handleMoveChapter(projectId: string, chapterId: string, direction: ChapterMoveDirection) {
    setChapterError(null);
    setChapterBusyKey(`${projectId}:${chapterId}:move:${direction}`);
    try {
      await updateProjectChapterRequest(projectId, chapterId, { move: direction });
      router.refresh();
    } catch (error) {
      setChapterError(error instanceof Error ? error.message : "Не удалось изменить порядок глав");
    } finally {
      setChapterBusyKey(null);
    }
  }

  async function handleDeleteChapter(projectId: string, chapterId: string, isActiveChapter: boolean) {
    const confirmed = window.confirm("Удалить главу?");
    if (!confirmed) return;

    setChapterError(null);
    setChapterBusyKey(`${projectId}:${chapterId}:delete`);
    try {
      const result = await deleteProjectChapterRequest(projectId, chapterId);

      if (editingChapterId === chapterId) {
        setEditingChapterId(null);
        setEditingChapterTitle("");
      }

      if (isActiveChapter) {
        const nextParams = new URLSearchParams(searchParams.toString());
        nextParams.set("chapter", result.fallbackChapterId);
        nextParams.delete("mention");
        const query = nextParams.toString();
        router.push(`/projects/${projectId}${query ? `?${query}` : ""}`);
      }

      router.refresh();
    } catch (error) {
      setChapterError(error instanceof Error ? error.message : "Не удалось удалить главу");
    } finally {
      setChapterBusyKey(null);
    }
  }

  const toggleTheme = () => {
    setTheme((current) => {
      return current === "light" ? "dark" : "light";
    });
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link href="/" className="brand app-header-logo">
          Remarka
        </Link>
        <div className="app-header-center" title={activeProjectTitle}>
          {activeProjectTitle}
        </div>
        <div className="app-header-actions">
          <button
            className="icon-btn"
            type="button"
            onClick={toggleTheme}
            aria-label="Переключить тему"
            title="Переключить тему"
          >
            {theme === "light" ? <IconMoonStars size={16} stroke={1.8} /> : <IconSunHigh size={16} stroke={1.8} />}
          </button>
          <button className="avatar-placeholder" type="button" aria-label="Текущий пользователь" title="Текущий пользователь">
            U
          </button>
        </div>
      </header>

      <div className="mobile-topbar">
        <button
          className="icon-btn"
          type="button"
          onClick={() => setIsSidebarOpen(true)}
          aria-label="Открыть список проектов"
          title="Открыть список проектов"
        >
          <IconMenu2 size={16} stroke={1.8} />
        </button>
        <div className="mobile-title" title={activeProjectTitle}>
          {activeProjectTitle}
        </div>
        <div className="mobile-actions">
          <button
            className="icon-btn"
            type="button"
            onClick={toggleTheme}
            aria-label="Переключить тему"
            title="Переключить тему"
          >
            {theme === "light" ? <IconMoonStars size={16} stroke={1.8} /> : <IconSunHigh size={16} stroke={1.8} />}
          </button>
          <button className="avatar-placeholder mobile-avatar" type="button" aria-label="Текущий пользователь">
            U
          </button>
        </div>
      </div>

      <div className="app-body">
        <aside className={`left-sidebar ${isSidebarOpen ? "open" : ""}`}>
          <div className="left-sidebar-header">
            <div className="sidebar-section-title">
              <IconFolder size={14} stroke={1.8} />
              Проекты
            </div>
            <button
              className="icon-btn"
              type="button"
              onClick={() => setIsCreateOpen(true)}
              aria-label="Создать проект"
              title="Создать проект"
            >
              <IconPlus size={16} stroke={1.8} />
            </button>
          </div>

          {chapterError ? <div className="error-text">{chapterError}</div> : null}

          <nav className="project-nav">
            {!sortedProjects.length ? <div className="empty-state">Проектов пока нет</div> : null}
            {sortedProjects.map((project) => {
              const isActive = activeProjectId === project.id || pathname === `/projects/${project.id}`;
              const firstChapterId = project.chapters[0]?.id || null;
              const isCollapsed = collapsedProjects[project.id] ?? !isActive;
              return (
                <div key={project.id} className="project-tree-item">
                  <div className={`project-nav-item ${isActive ? "active" : ""}`}>
                    <button
                      className="project-collapse-btn"
                      type="button"
                      aria-label={isCollapsed ? "Развернуть проект" : "Свернуть проект"}
                      onClick={() =>
                        setCollapsedProjects((current) => ({
                          ...current,
                          [project.id]: !isCollapsed,
                        }))
                      }
                    >
                      {isCollapsed ? <IconChevronRight size={14} stroke={1.8} /> : <IconChevronDown size={14} stroke={1.8} />}
                    </button>
                    <Link
                      href={buildProjectHref(project.id, firstChapterId)}
                      className="project-nav-link"
                      onClick={() => setIsSidebarOpen(false)}
                    >
                      <div className="project-nav-title">{project.title}</div>
                    </Link>
                    <button
                      className="project-add-chapter-btn"
                      type="button"
                      aria-label="Создать главу"
                      title="Создать главу"
                      disabled={creatingChapterProjectId === project.id}
                      onClick={() => void handleCreateChapter(project.id)}
                    >
                      <IconPlus size={14} stroke={1.8} />
                    </button>
                  </div>

                  {!isCollapsed ? (
                    <div className="chapter-nav">
                      {!project.chapters.length ? <div className="chapter-empty">Глав пока нет</div> : null}
                      {project.chapters.map((chapter, chapterIndex) => {
                        const isActiveChapter = isActive && resolvedActiveChapterId === chapter.id;
                        const isEditingChapter = editingChapterId === chapter.id;
                        const isBusyChapter = (chapterBusyKey || "").startsWith(`${project.id}:${chapter.id}:`);
                        const canMoveUp = chapterIndex > 0;
                        const canMoveDown = chapterIndex < project.chapters.length - 1;
                        const isOnlyChapter = project.chapters.length <= 1;
                        return (
                          <div key={chapter.id} className={`chapter-nav-item ${isActiveChapter ? "active" : ""}`}>
                            {isEditingChapter ? (
                              <form
                                className="chapter-rename-form"
                                onSubmit={async (event) => {
                                  event.preventDefault();
                                  await handleRenameChapter(project.id, chapter.id);
                                }}
                              >
                                <input
                                  className="chapter-rename-input"
                                  value={editingChapterTitle}
                                  onChange={(event) => setEditingChapterTitle(event.target.value)}
                                  maxLength={160}
                                  autoFocus
                                />
                                <button className="chapter-action-btn" type="submit" aria-label="Сохранить" disabled={isBusyChapter}>
                                  <IconCheck size={12} stroke={1.9} />
                                </button>
                                <button
                                  className="chapter-action-btn"
                                  type="button"
                                  aria-label="Отменить"
                                  onClick={handleCancelChapterRename}
                                  disabled={isBusyChapter}
                                >
                                  <IconX size={12} stroke={1.9} />
                                </button>
                              </form>
                            ) : (
                              <>
                                <Link
                                  href={buildProjectHref(project.id, chapter.id)}
                                  className="chapter-nav-link"
                                  onClick={() => setIsSidebarOpen(false)}
                                >
                                  <IconFileText size={13} stroke={1.8} />
                                  <span className="chapter-nav-title">{chapter.title}</span>
                                </Link>
                                <div className="chapter-actions">
                                  <button
                                    className="chapter-action-btn"
                                    type="button"
                                    aria-label="Переименовать главу"
                                    title="Переименовать"
                                    onClick={() => handleStartChapterRename(chapter.id, chapter.title)}
                                    disabled={isBusyChapter}
                                  >
                                    <IconPencil size={12} stroke={1.9} />
                                  </button>
                                  <button
                                    className="chapter-action-btn"
                                    type="button"
                                    aria-label="Переместить выше"
                                    title="Выше"
                                    onClick={() => void handleMoveChapter(project.id, chapter.id, "up")}
                                    disabled={isBusyChapter || !canMoveUp}
                                  >
                                    <IconArrowUp size={12} stroke={1.9} />
                                  </button>
                                  <button
                                    className="chapter-action-btn"
                                    type="button"
                                    aria-label="Переместить ниже"
                                    title="Ниже"
                                    onClick={() => void handleMoveChapter(project.id, chapter.id, "down")}
                                    disabled={isBusyChapter || !canMoveDown}
                                  >
                                    <IconArrowDown size={12} stroke={1.9} />
                                  </button>
                                  <button
                                    className="chapter-action-btn danger"
                                    type="button"
                                    aria-label="Удалить главу"
                                    title={isOnlyChapter ? "Нельзя удалить последнюю главу" : "Удалить"}
                                    onClick={() => void handleDeleteChapter(project.id, chapter.id, isActiveChapter)}
                                    disabled={isBusyChapter || isOnlyChapter}
                                  >
                                    <IconTrash size={12} stroke={1.9} />
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </nav>
        </aside>

        <div
          className={`left-sidebar-backdrop ${isSidebarOpen ? "open" : ""}`}
          onClick={() => setIsSidebarOpen(false)}
          aria-hidden
        />

        <div className="app-main">{children}</div>
      </div>

      {isCreateOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modal-title">Новый проект</div>
            <form
              className="modal-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const formData = new FormData(event.currentTarget);
                await handleCreateProject(formData);
              }}
            >
              <input className="input" name="title" placeholder="Название проекта" maxLength={120} required />
              <textarea
                className="textarea"
                name="description"
                placeholder="Описание (опционально)"
                maxLength={500}
                rows={4}
              />
              {createError ? <div className="error-text">{createError}</div> : null}
              <div className="modal-actions">
                <button className="button ghost" type="button" onClick={() => setIsCreateOpen(false)}>
                  Отмена
                </button>
                <button className="button primary" type="submit" disabled={isSavingProject}>
                  {isSavingProject ? "Создание..." : "Создать"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
