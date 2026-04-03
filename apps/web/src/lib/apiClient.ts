import type { DocumentPayload, EntityType } from "@remarka/contracts";

export interface SidebarChapterItem {
  id: string;
  projectId: string;
  title: string;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectEntityListItem {
  id: string;
  projectId: string;
  type: EntityType;
  name: string;
  containerEntityId: string | null;
  summary: string;
  mentionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectEntityDetails {
  id: string;
  projectId: string;
  type: EntityType;
  name: string;
  containerEntityId: string | null;
  summary: string;
  createdAt: string;
  updatedAt: string;
  containers: Array<{
    id: string;
    type: EntityType;
    name: string;
  }>;
  containedLocations: Array<{
    id: string;
    type: EntityType;
    name: string;
  }>;
  mentions: Array<{
    id: string;
    documentId: string;
    chapterId: string | null;
    paragraphIndex: number;
    startOffset: number;
    endOffset: number;
    sourceText: string;
    snippet: string;
  }>;
}

export interface SidebarProjectItem {
  id: string;
  title: string;
  description: string | null;
  chapters: SidebarChapterItem[];
  createdAt: string;
  updatedAt: string;
}

export type ChapterMoveDirection = "up" | "down";

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    cache: "no-store",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    if (text) {
      let payload: { message?: string; error?: string } | null = null;
      try {
        payload = JSON.parse(text) as { message?: string; error?: string };
      } catch {
        payload = null;
      }

      if (payload?.message) {
        throw new Error(payload.message);
      }

      if (payload?.error) {
        throw new Error(payload.error);
      }

      throw new Error(text);
    }

    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

function buildChapterQuery(chapterId: string | null | undefined): string {
  if (!chapterId) return "";
  return `?chapter=${encodeURIComponent(chapterId)}`;
}

export async function fetchProjectDocument(projectId: string, chapterId?: string | null): Promise<DocumentPayload> {
  const result = await requestJson<{ document: DocumentPayload }>(
    `/api/projects/${projectId}/document${buildChapterQuery(chapterId)}`
  );
  return result.document;
}

export async function saveProjectDocument(
  projectId: string,
  chapterId: string,
  richContent: unknown
): Promise<DocumentPayload> {
  const result = await requestJson<{ document: DocumentPayload }>(
    `/api/projects/${projectId}/document${buildChapterQuery(chapterId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ richContent }),
    }
  );
  return result.document;
}

export async function fetchProjectEntities(
  projectId: string,
  options: { q?: string; type?: EntityType | "" } = {}
): Promise<ProjectEntityListItem[]> {
  const params = new URLSearchParams();
  if (options.q?.trim()) params.set("q", options.q.trim());
  if (options.type) params.set("type", options.type);

  const query = params.toString();
  const endpoint = `/api/projects/${projectId}/entities${query ? `?${query}` : ""}`;
  const result = await requestJson<{ entities: ProjectEntityListItem[] }>(endpoint);
  return result.entities;
}

export async function fetchProjectEntityDetails(projectId: string, entityId: string): Promise<ProjectEntityDetails> {
  const result = await requestJson<{ entity: ProjectEntityDetails }>(
    `/api/projects/${projectId}/entities/${entityId}`
  );
  return result.entity;
}

export async function createProjectRequest(input: { title: string; description?: string | null }) {
  const result = await requestJson<{ project: SidebarProjectItem & { firstChapterId: string | null } }>(`/api/projects`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.project;
}

export async function createProjectChapterRequest(projectId: string, input?: { title?: string | null }) {
  const result = await requestJson<{ chapter: SidebarChapterItem }>(`/api/projects/${projectId}/chapters`, {
    method: "POST",
    body: JSON.stringify(input || {}),
  });
  return result.chapter;
}

export async function updateProjectChapterRequest(
  projectId: string,
  chapterId: string,
  input: { title?: string | null; move?: ChapterMoveDirection | null }
) {
  const result = await requestJson<{ chapter: SidebarChapterItem }>(
    `/api/projects/${projectId}/chapters/${chapterId}`,
    {
      method: "PATCH",
      body: JSON.stringify(input || {}),
    }
  );
  return result.chapter;
}

export async function deleteProjectChapterRequest(projectId: string, chapterId: string) {
  return requestJson<{ deletedChapterId: string; fallbackChapterId: string }>(
    `/api/projects/${projectId}/chapters/${chapterId}`,
    {
      method: "DELETE",
    }
  );
}

export function subscribeProjectStatus(
  projectId: string,
  chapterId: string,
  handlers: {
    onStatus: (payload: {
      chapterId: string | null;
      analysisStatus: string;
      contentVersion: number;
      lastAnalyzedVersion: number | null;
      updatedAt: string | null;
    }) => void;
    onError?: (message: string) => void;
  }
) {
  const eventSource = new EventSource(`/api/projects/${projectId}/stream${buildChapterQuery(chapterId)}`);

  const statusListener = (event: MessageEvent) => {
    try {
      const payload = JSON.parse(event.data) as {
        chapterId: string | null;
        analysisStatus: string;
        contentVersion: number;
        lastAnalyzedVersion: number | null;
        updatedAt: string | null;
      };
      handlers.onStatus(payload);
    } catch (error) {
      handlers.onError?.(error instanceof Error ? error.message : "SSE parse error");
    }
  };

  const errorListener = (event: MessageEvent) => {
    try {
      const payload = JSON.parse(event.data) as { message?: string };
      handlers.onError?.(payload.message || "SSE error");
    } catch {
      handlers.onError?.("SSE error");
    }
  };

  eventSource.addEventListener("status", statusListener as EventListener);
  eventSource.addEventListener("error", errorListener as EventListener);

  return () => {
    eventSource.close();
  };
}
