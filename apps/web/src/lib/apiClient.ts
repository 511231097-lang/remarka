import type {
  AnalysisRunPayload,
  DocumentSnapshot,
  DocumentViewResponse,
  EntityType,
  ProjectImportPayload,
  PutDocumentResponse,
  QualityFlags,
} from "@remarka/contracts";

export interface SidebarChapterItem {
  id: string;
  projectId: string;
  title: string;
  orderIndex: number;
  latestRun?: {
    id: string;
    state: AnalysisRunPayload["state"];
    phase: AnalysisRunPayload["phase"];
    error: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
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
  canonicalName?: string;
  containerEntityId: string | null;
  summary: string;
  shortDescription?: string;
  mentionCount?: number;
  firstAppearance?: {
    chapterId: string;
    chapterTitle: string;
    chapterOrderIndex: number;
    offset: number | null;
  } | null;
  lastAppearance?: {
    chapterId: string;
    chapterTitle: string;
    chapterOrderIndex: number;
    offset: number | null;
  } | null;
  aliases?: Array<{
    id: string;
    value: string;
    normalizedValue: string;
    aliasType: "name" | "nickname" | "title" | "descriptor";
    confidence: number;
  }>;
  chapters?: Array<{
    chapterId: string;
    chapterTitle: string;
    chapterOrderIndex: number;
    mentionCount: number;
  }>;
  acts?: Array<{
    actId: string;
    chapterId: string;
    chapterTitle: string;
    chapterOrderIndex: number;
    actOrderIndex: number;
    actTitle: string;
    mentionCount: number;
  }>;
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
    chapterTitle?: string | null;
    actId?: string | null;
    actTitle?: string | null;
    actOrderIndex?: number | null;
    mentionType?: "named" | "alias" | "descriptor" | "pronoun";
    paragraphIndex: number;
    startOffset: number;
    endOffset: number;
    sourceText: string;
    confidence?: number;
    snippet: string;
  }>;
}

export interface ProjectCharacterSearchResult {
  characters: Array<{
    id: string;
    canonicalName: string;
    shortDescription: string;
    mentionCount: number;
    aliases: Array<{
      id: string;
      value: string;
      aliasType: "name" | "nickname" | "title" | "descriptor";
    }>;
  }>;
  mentions: Array<{
    id: string;
    entityId: string;
    canonicalName: string;
    chapterId: string | null;
    chapterTitle: string | null;
    mentionType: "named" | "alias" | "descriptor" | "pronoun";
    startOffset: number;
    endOffset: number;
    confidence: number;
    sourceText: string;
    snippet: string;
  }>;
}

export interface ProjectActItem {
  id: string;
  projectId: string;
  chapterId: string;
  chapterTitle: string;
  chapterOrderIndex: number;
  documentId: string;
  contentVersion: number;
  orderIndex: number;
  title: string;
  summary: string;
  paragraphStart: number;
  paragraphEnd: number;
  characters: Array<{
    id: string;
    name: string;
    mentionCount: number;
  }>;
}

export interface SidebarProjectItem {
  id: string;
  title: string;
  description: string | null;
  chapters: SidebarChapterItem[];
  latestImport: ProjectImportPayload | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDocumentState extends DocumentViewResponse {}

export interface SaveDocumentResult extends PutDocumentResponse {}

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

export async function fetchProjectDocument(projectId: string, chapterId?: string | null): Promise<ProjectDocumentState> {
  return requestJson<ProjectDocumentState>(`/api/projects/${projectId}/document${buildChapterQuery(chapterId)}`);
}

export async function fetchSidebarProjects(): Promise<SidebarProjectItem[]> {
  const result = await requestJson<{ projects: SidebarProjectItem[] }>(`/api/projects`);
  return result.projects;
}

export async function saveProjectDocument(
  projectId: string,
  chapterId: string,
  richContent: unknown,
  options?: {
    ifMatchContentVersion?: number | null;
    idempotencyKey?: string | null;
  }
): Promise<SaveDocumentResult> {
  const headers: Record<string, string> = {};
  if (typeof options?.ifMatchContentVersion === "number" && Number.isInteger(options.ifMatchContentVersion)) {
    headers["If-Match"] = String(options.ifMatchContentVersion);
  }
  if (options?.idempotencyKey?.trim()) {
    headers["Idempotency-Key"] = options.idempotencyKey.trim();
  }

  return requestJson<SaveDocumentResult>(`/api/projects/${projectId}/document${buildChapterQuery(chapterId)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ richContent }),
  });
}

export async function rerunChapterAnalysis(
  projectId: string,
  chapterId: string,
  options?: {
    idempotencyKey?: string | null;
  }
): Promise<SaveDocumentResult> {
  const headers: Record<string, string> = {};
  if (options?.idempotencyKey?.trim()) {
    headers["Idempotency-Key"] = options.idempotencyKey.trim();
  }

  return requestJson<SaveDocumentResult>(`/api/projects/${projectId}/chapters/${chapterId}/analysis/rerun`, {
    method: "POST",
    headers,
  });
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

export async function fetchProjectCharacterSearch(
  projectId: string,
  query: string,
  options: { limit?: number } = {}
): Promise<ProjectCharacterSearchResult> {
  const q = String(query || "").trim();
  if (!q) {
    return {
      characters: [],
      mentions: [],
    };
  }

  const params = new URLSearchParams();
  params.set("q", q);
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    params.set("limit", String(Math.max(1, Math.min(100, Math.floor(options.limit)))));
  }

  return requestJson<ProjectCharacterSearchResult>(`/api/projects/${projectId}/characters/search?${params.toString()}`);
}

export async function createProjectRequest(input: { title: string; description?: string | null }) {
  const result = await requestJson<{ project: SidebarProjectItem & { firstChapterId: string | null } }>(`/api/projects`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.project;
}

export async function deleteProjectRequest(projectId: string) {
  return requestJson<{
    deletedProjectId: string;
    fallbackProjectId: string | null;
    fallbackChapterId: string | null;
  }>(`/api/projects/${projectId}`, {
    method: "DELETE",
  });
}

export async function createProjectImportRequest(input: {
  file: File;
  title?: string | null;
  description?: string | null;
}) {
  const formData = new FormData();
  formData.set("file", input.file);
  if (input.title?.trim()) {
    formData.set("title", input.title.trim());
  }
  if (input.description?.trim()) {
    formData.set("description", input.description.trim());
  }

  const response = await fetch(`/api/projects/import`, {
    method: "POST",
    body: formData,
    cache: "no-store",
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

  return (await response.json()) as {
    project: SidebarProjectItem & { firstChapterId: string | null };
    import: ProjectImportPayload;
  };
}

export async function fetchProjectImportStatus(projectId: string): Promise<ProjectImportPayload | null> {
  const response = await requestJson<{ import: ProjectImportPayload | null }>(`/api/projects/${projectId}/import`);
  return response.import;
}

export async function fetchProjectActs(
  projectId: string,
  options: { chapterId?: string | null } = {}
): Promise<ProjectActItem[]> {
  const params = new URLSearchParams();
  if (options.chapterId?.trim()) {
    params.set("chapter", options.chapterId.trim());
  }

  const query = params.toString();
  const endpoint = `/api/projects/${projectId}/acts${query ? `?${query}` : ""}`;
  const result = await requestJson<{ acts: ProjectActItem[] }>(endpoint);
  return result.acts;
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
    onRunStarted?: (payload: { chapterId: string; run: AnalysisRunPayload | null }) => void;
    onPhaseChanged?: (payload: { chapterId: string; run: AnalysisRunPayload | null }) => void;
    onSnapshotUpdated?: (payload: {
      chapterId: string;
      runId: string | null;
      contentVersion: number;
      updatedAt: string;
    }) => void;
    onCompleted?: (payload: { chapterId: string; run: AnalysisRunPayload | null }) => void;
    onFailed?: (payload: { chapterId: string; run: AnalysisRunPayload | null }) => void;
    onSuperseded?: (payload: { chapterId: string; run: AnalysisRunPayload | null }) => void;
    onError?: (message: string) => void;
  }
) {
  const eventSource = new EventSource(`/api/projects/${projectId}/stream${buildChapterQuery(chapterId)}`);

  const parsePayload = <T>(event: MessageEvent, cb?: (payload: T) => void) => {
    if (!cb) return;
    try {
      const payload = JSON.parse(event.data) as T;
      cb(payload);
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

  eventSource.addEventListener("run_started", ((event: MessageEvent) =>
    parsePayload<{ chapterId: string; run: AnalysisRunPayload | null }>(event, handlers.onRunStarted)) as EventListener);
  eventSource.addEventListener("phase_changed", ((event: MessageEvent) =>
    parsePayload<{ chapterId: string; run: AnalysisRunPayload | null }>(event, handlers.onPhaseChanged)) as EventListener);
  eventSource.addEventListener("snapshot_updated", ((event: MessageEvent) =>
    parsePayload<{ chapterId: string; runId: string | null; contentVersion: number; updatedAt: string }>(
      event,
      handlers.onSnapshotUpdated
    )) as EventListener);
  eventSource.addEventListener("completed", ((event: MessageEvent) =>
    parsePayload<{ chapterId: string; run: AnalysisRunPayload | null }>(event, handlers.onCompleted)) as EventListener);
  eventSource.addEventListener("failed", ((event: MessageEvent) =>
    parsePayload<{ chapterId: string; run: AnalysisRunPayload | null }>(event, handlers.onFailed)) as EventListener);
  eventSource.addEventListener("superseded", ((event: MessageEvent) =>
    parsePayload<{ chapterId: string; run: AnalysisRunPayload | null }>(event, handlers.onSuperseded)) as EventListener);
  eventSource.addEventListener("error", errorListener as EventListener);

  return () => {
    eventSource.close();
  };
}
