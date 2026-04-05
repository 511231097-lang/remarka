"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  IconAlertTriangle,
  IconBrain,
  IconChevronLeft,
  IconCircleCheck,
  IconLayoutSidebarRightExpand,
  IconLoader2,
  IconMapPin,
  IconQuote,
  IconHierarchy2,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import {
  EMPTY_RICH_TEXT_DOCUMENT,
  richTextToPlainText,
  type AnalysisRunPayload,
  type DocumentPayload,
  type EntityType,
  type ProjectImportPayload,
} from "@remarka/contracts";
import { NarrativeEditor } from "@/components/NarrativeEditor";
import {
  fetchProjectDocument,
  fetchProjectCharacterSearch,
  fetchProjectActs,
  fetchProjectEntities,
  fetchProjectEntityDetails,
  fetchProjectImportStatus,
  saveProjectDocument,
  rerunChapterAnalysis,
  subscribeProjectStatus,
  type ProjectDocumentState,
  type ProjectEntityDetails,
  type ProjectEntityListItem,
  type ProjectCharacterSearchResult,
  type ProjectActItem,
} from "@/lib/apiClient";
import { buildSearchWithEntity, getEntityIdFromSearch, getMentionIdFromSearch } from "@/lib/entityDrawerUrl";
import {
  ENTITY_TYPE_LABELS_RU,
  ENTITY_TYPE_OPTIONS,
  ENTITY_TYPE_SHORT_RU,
  formatAnalysisStatusRu,
} from "@/lib/entityLabels";

interface ProjectWorkspaceProps {
  projectId: string;
  chapterId: string;
}

const ACTIVE_ANALYSIS_MODEL_LABEL = "Gemini 3.1 Flash Lite (Vertex AI)";

function serializeRichContent(value: unknown): string {
  return JSON.stringify(value || EMPTY_RICH_TEXT_DOCUMENT);
}

function plainLength(value: unknown): number {
  try {
    return richTextToPlainText(value).length;
  } catch {
    return -1;
  }
}

function formatImportStageRu(stage: ProjectImportPayload["stage"] | null | undefined): string {
  switch (stage) {
    case "loading_source":
      return "чтение файла";
    case "parsing":
      return "разбор книги";
    case "persisting":
      return "сохранение глав";
    case "scheduling_analysis":
      return "постановка анализа";
    case "completed":
      return "завершено";
    case "failed":
      return "ошибка";
    case "queued":
    default:
      return "в очереди";
  }
}

function formatAppearanceScopeRu(scope: "stable" | "temporary" | "scene"): string {
  if (scope === "stable") return "Стабильная черта";
  if (scope === "temporary") return "Временная деталь";
  return "Сценическая деталь";
}

export function ProjectWorkspace({ projectId, chapterId }: ProjectWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeEntityId = useMemo(() => getEntityIdFromSearch(searchParams.toString()), [searchParams]);
  const activeMentionId = useMemo(() => getMentionIdFromSearch(searchParams.toString()), [searchParams]);

  const [document, setDocument] = useState<DocumentPayload | null>(null);
  const [run, setRun] = useState<AnalysisRunPayload | null>(null);
  const [latestImport, setLatestImport] = useState<ProjectImportPayload | null>(null);
  const [draftRichContent, setDraftRichContent] = useState<unknown>(EMPTY_RICH_TEXT_DOCUMENT);
  const [entityFilter, setEntityFilter] = useState<EntityType>("character");
  const [entitySearchQuery, setEntitySearchQuery] = useState("");
  const [entities, setEntities] = useState<ProjectEntityListItem[]>([]);
  const [projectActs, setProjectActs] = useState<ProjectActItem[]>([]);
  const [characterSearch, setCharacterSearch] = useState<ProjectCharacterSearchResult>({ characters: [], mentions: [] });
  const [entityDetails, setEntityDetails] = useState<ProjectEntityDetails | null>(null);
  const [isEntityDetailsLoading, setIsEntityDetailsLoading] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [scrollToMentionRequest, setScrollToMentionRequest] = useState<{ mentionId: string; token: number } | null>(
    null
  );
  const [isRerunSubmitting, setIsRerunSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveRequestVersion = useRef(0);
  const previousServerRichRef = useRef(serializeRichContent(EMPTY_RICH_TEXT_DOCUMENT));
  const draftSnapshotRef = useRef(serializeRichContent(EMPTY_RICH_TEXT_DOCUMENT));
  const hasUnsavedChangesRef = useRef(false);
  const hasUserEditedRef = useRef(false);
  const hasLoadedServerDocumentRef = useRef(false);
  const pendingServerRefreshRef = useRef(false);
  const lastRunningRefreshAtRef = useRef(0);
  const previousImportLockedRef = useRef(false);
  const debugSeqRef = useRef(0);

  const debugLog = useCallback(
    (event: string, payload?: Record<string, unknown>) => {
      debugSeqRef.current += 1;
      console.info(`[remarka][workspace:${projectId}:${chapterId}][${debugSeqRef.current}] ${event}`, payload || {});
    },
    [projectId, chapterId]
  );

  const applyServerDocument = useCallback((loaded: ProjectDocumentState) => {
    const snapshot = loaded.snapshot;
    const loadedServerSnapshot = serializeRichContent(snapshot.richContent);
    const currentSnapshot = draftSnapshotRef.current;
    const shouldReplaceDraft = currentSnapshot === previousServerRichRef.current;
    const nextSnapshot = shouldReplaceDraft ? loadedServerSnapshot : currentSnapshot;

    setDocument(snapshot);
    setRun(loaded.run);
    if (shouldReplaceDraft) {
      setDraftRichContent(snapshot.richContent);
      draftSnapshotRef.current = loadedServerSnapshot;
      hasUserEditedRef.current = false;
    }

    debugLog("applyServerDocument", {
      loadedVersion: snapshot.contentVersion,
      loadedStatus: loaded.run?.state || "none",
      loadedPhase: loaded.run?.phase || "none",
      loadedPlainLength: snapshot.content.length,
      loadedRichPlainLength: plainLength(snapshot.richContent),
      currentDraftSerializedLength: currentSnapshot.length,
      shouldReplaceDraft,
    });

    previousServerRichRef.current = loadedServerSnapshot;
    hasUnsavedChangesRef.current = nextSnapshot !== loadedServerSnapshot;
    hasLoadedServerDocumentRef.current = true;
  }, [debugLog]);

  const loadDocument = useCallback(async () => {
    debugLog("loadDocument:start");
    const loaded = await fetchProjectDocument(projectId, chapterId);
    debugLog("loadDocument:success", {
      loadedVersion: loaded.snapshot.contentVersion,
      loadedStatus: loaded.run?.state || "none",
      loadedPhase: loaded.run?.phase || "none",
      loadedPlainLength: loaded.snapshot.content.length,
      loadedRichPlainLength: plainLength(loaded.snapshot.richContent),
      mentions: loaded.snapshot.mentions.length,
    });
    applyServerDocument(loaded);
  }, [projectId, chapterId, applyServerDocument, debugLog]);

  const loadEntities = useCallback(async () => {
    const loaded = await fetchProjectEntities(projectId, {
      type: entityFilter,
      q: entitySearchQuery.trim() || undefined,
    });
    setEntities(loaded);
  }, [projectId, entityFilter, entitySearchQuery]);

  const loadActs = useCallback(async () => {
    const loaded = await fetchProjectActs(projectId);
    setProjectActs(loaded);
  }, [projectId]);

  const loadImportStatus = useCallback(async () => {
    const status = await fetchProjectImportStatus(projectId);
    setLatestImport(status);
  }, [projectId]);

  const setEntityInUrl = useCallback(
    (entityId: string | null) => {
      const queryString = buildSearchWithEntity(searchParams.toString(), entityId);
      router.replace(`${pathname}${queryString}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  useEffect(() => {
    previousServerRichRef.current = serializeRichContent(EMPTY_RICH_TEXT_DOCUMENT);
    draftSnapshotRef.current = serializeRichContent(EMPTY_RICH_TEXT_DOCUMENT);
    hasUnsavedChangesRef.current = false;
    hasUserEditedRef.current = false;
    hasLoadedServerDocumentRef.current = false;
    pendingServerRefreshRef.current = false;
    previousImportLockedRef.current = false;
    saveRequestVersion.current = 0;
    setDocument(null);
    setRun(null);
    setLatestImport(null);
    setDraftRichContent(EMPTY_RICH_TEXT_DOCUMENT);
    setEntityFilter("character");
    setEntitySearchQuery("");
    setSaveStatus("idle");
    setProjectActs([]);
    setCharacterSearch({ characters: [], mentions: [] });
    setEntityDetails(null);
    setIsEntityDetailsLoading(false);
    setIsInspectorOpen(false);
    setScrollToMentionRequest(null);
    setIsRerunSubmitting(false);
    debugLog("project:reset");
    setError(null);
  }, [projectId, chapterId, debugLog]);

  useEffect(() => {
    if (!activeMentionId) {
      setScrollToMentionRequest(null);
      return;
    }

    setScrollToMentionRequest({
      mentionId: activeMentionId,
      token: Date.now(),
    });
  }, [activeMentionId]);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        debugLog("initialLoad:start");
        const [loadedDocument, loadedEntities, loadedImport, loadedActs] = await Promise.all([
          fetchProjectDocument(projectId, chapterId),
          fetchProjectEntities(projectId, {
            type: entityFilter,
            q: entitySearchQuery.trim() || undefined,
          }),
          fetchProjectImportStatus(projectId),
          fetchProjectActs(projectId),
        ]);
        if (!active) return;
        debugLog("initialLoad:success", {
          loadedVersion: loadedDocument.snapshot.contentVersion,
          loadedStatus: loadedDocument.run?.state || "none",
          loadedPhase: loadedDocument.run?.phase || "none",
          loadedPlainLength: loadedDocument.snapshot.content.length,
          loadedRichPlainLength: plainLength(loadedDocument.snapshot.richContent),
          entities: loadedEntities.length,
          acts: loadedActs.length,
          importState: loadedImport?.state || null,
          importStage: loadedImport?.stage || null,
        });
        applyServerDocument(loadedDocument);
        setEntities(loadedEntities);
        setLatestImport(loadedImport);
        setProjectActs(loadedActs);
      } catch (loadError) {
        if (!active) return;
        debugLog("initialLoad:error", {
          message: loadError instanceof Error ? loadError.message : "unknown",
        });
        setError(loadError instanceof Error ? loadError.message : "Ошибка загрузки проекта");
      }
    })();

    return () => {
      active = false;
    };
  }, [projectId, chapterId, applyServerDocument, debugLog]);

  useEffect(() => {
    void loadEntities().catch((entityError) => {
      setError(entityError instanceof Error ? entityError.message : "Ошибка загрузки сущностей");
    });
  }, [loadEntities]);

  useEffect(() => {
    if (entityFilter !== "character") {
      setCharacterSearch({ characters: [], mentions: [] });
      return;
    }

    const query = entitySearchQuery.trim();
    if (!query) {
      setCharacterSearch({ characters: [], mentions: [] });
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await fetchProjectCharacterSearch(projectId, query, { limit: 50 });
          if (!active) return;
          setCharacterSearch(result);
        } catch (searchError) {
          if (!active) return;
          setError(searchError instanceof Error ? searchError.message : "Ошибка поиска персонажей");
        }
      })();
    }, 220);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [projectId, entityFilter, entitySearchQuery]);

  useEffect(() => {
    const isImportActive = Boolean(latestImport && ["queued", "running"].includes(latestImport.state));
    if (!isImportActive) return;

    const interval = window.setInterval(() => {
      void loadImportStatus().catch((statusError) => {
        setError(statusError instanceof Error ? statusError.message : "Ошибка загрузки импорта");
      });
    }, 1500);

    return () => {
      window.clearInterval(interval);
    };
  }, [latestImport?.id, latestImport?.state, loadImportStatus]);

  useEffect(() => {
    const isLocked = Boolean(latestImport && ["queued", "running"].includes(latestImport.state));
    const wasLocked = previousImportLockedRef.current;
    previousImportLockedRef.current = isLocked;

    if (wasLocked && !isLocked) {
      router.refresh();
      void loadDocument();
      void loadEntities();
      void loadActs();
    }
  }, [latestImport, router, loadDocument, loadEntities, loadActs]);

  useEffect(() => {
    if (!document) return;

    const draftSnapshot = serializeRichContent(draftRichContent);
    const serverSnapshot = serializeRichContent(document.richContent);
    if (draftSnapshot === serverSnapshot) {
      debugLog("autosave:skip_clean", {
        docVersion: document.contentVersion,
        draftPlainLength: plainLength(draftRichContent),
        serverPlainLength: document.content.length,
      });
      return;
    }
    if (!hasUserEditedRef.current) {
      debugLog("autosave:skip_not_user_edited", {
        docVersion: document.contentVersion,
        draftPlainLength: plainLength(draftRichContent),
        serverPlainLength: document.content.length,
      });
      return;
    }

    const ticket = saveRequestVersion.current + 1;
    const snapshotRich = draftRichContent;
    const snapshotSerialized = draftSnapshot;
    saveRequestVersion.current = ticket;
    setSaveStatus("saving");
    debugLog("autosave:scheduled", {
      ticket,
      docVersion: document.contentVersion,
      draftPlainLength: plainLength(snapshotRich),
      serverPlainLength: document.content.length,
    });

    const timeout = setTimeout(() => {
      void (async () => {
        try {
          debugLog("autosave:request", {
            ticket,
            draftPlainLength: plainLength(snapshotRich),
          });
          const saved = await saveProjectDocument(projectId, chapterId, snapshotRich, {
            ifMatchContentVersion: document.contentVersion,
            idempotencyKey: `${projectId}:${chapterId}:${document.contentVersion}:${ticket}`,
          });
          if (ticket !== saveRequestVersion.current) return;

          const savedSnapshot = saved.snapshot;
          if (!savedSnapshot) {
            await loadDocument();
            return;
          }
          const savedSerialized = serializeRichContent(savedSnapshot.richContent);
          debugLog("autosave:response", {
            ticket,
            savedVersion: saved.contentVersion,
            savedRunState: saved.runState,
            savedPlainLength: savedSnapshot.content.length,
            savedRichPlainLength: plainLength(savedSnapshot.richContent),
          });
          setDocument(savedSnapshot);
          previousServerRichRef.current = savedSerialized;
          const currentSerialized = draftSnapshotRef.current;
          const shouldReplaceDraft = currentSerialized === snapshotSerialized;
          if (shouldReplaceDraft) {
            setDraftRichContent(savedSnapshot.richContent);
            draftSnapshotRef.current = savedSerialized;
          }
          hasUnsavedChangesRef.current = (shouldReplaceDraft ? savedSerialized : currentSerialized) !== savedSerialized;
          hasUserEditedRef.current = !shouldReplaceDraft;
          debugLog("autosave:apply", {
            ticket,
            shouldReplaceDraft,
            currentDraftSerializedLength: currentSerialized.length,
            nextDraftSerializedLength: (shouldReplaceDraft ? savedSerialized : currentSerialized).length,
          });
          setSaveStatus("saved");
        } catch (saveError) {
          if (ticket !== saveRequestVersion.current) return;
          debugLog("autosave:error", {
            ticket,
            message: saveError instanceof Error ? saveError.message : "unknown",
          });
          setSaveStatus("error");
          setError(saveError instanceof Error ? saveError.message : "Ошибка сохранения");
        }
      })();
    }, 900);

    return () => clearTimeout(timeout);
  }, [document, draftRichContent, projectId, chapterId, debugLog, loadDocument]);

  useEffect(() => {
    draftSnapshotRef.current = serializeRichContent(draftRichContent);
    const hasUnsavedChanges = draftSnapshotRef.current !== previousServerRichRef.current;
    hasUnsavedChangesRef.current = hasUnsavedChanges;

    if (!hasUnsavedChanges && pendingServerRefreshRef.current) {
      pendingServerRefreshRef.current = false;
      void loadDocument();
    }
  }, [draftRichContent, loadDocument]);

  useEffect(() => {
    return subscribeProjectStatus(projectId, chapterId, {
      onRunStarted: (payload) => {
        if (payload.chapterId !== chapterId) return;
        setRun(payload.run);
      },
      onPhaseChanged: (payload) => {
        if (payload.chapterId !== chapterId) return;
        setRun(payload.run);
      },
      onSnapshotUpdated: (payload) => {
        if (payload.chapterId !== chapterId) return;
        setDocument((previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            contentVersion: payload.contentVersion,
            updatedAt: payload.updatedAt,
          };
        });

        const now = Date.now();
        if (now - lastRunningRefreshAtRef.current < 700) {
          return;
        }
        lastRunningRefreshAtRef.current = now;

        if (hasUnsavedChangesRef.current) {
          pendingServerRefreshRef.current = true;
        } else {
          void loadDocument();
        }
      },
      onCompleted: (payload) => {
        if (payload.chapterId !== chapterId) return;
        setRun(payload.run);
        if (hasUnsavedChangesRef.current) {
          pendingServerRefreshRef.current = true;
        } else {
          void loadDocument();
        }
        void loadEntities();
        void loadActs();
      },
      onFailed: (payload) => {
        if (payload.chapterId !== chapterId) return;
        setRun(payload.run);
        if (hasUnsavedChangesRef.current) {
          pendingServerRefreshRef.current = true;
        } else {
          void loadDocument();
        }
      },
      onSuperseded: (payload) => {
        if (payload.chapterId !== chapterId) return;
        setRun(payload.run);
      },
      onError: (message) => setError(message),
    });
  }, [projectId, chapterId, loadDocument, loadEntities, loadActs]);

  useEffect(() => {
    if (!activeEntityId) {
      setEntityDetails(null);
      return;
    }

    setIsInspectorOpen(true);

    let active = true;
    setIsEntityDetailsLoading(true);
    void (async () => {
      try {
        const details = await fetchProjectEntityDetails(projectId, activeEntityId);
        if (!active) return;
        setEntityDetails(details);
      } catch (entityError) {
        if (!active) return;
        setError(entityError instanceof Error ? entityError.message : "Ошибка загрузки сущности");
      } finally {
        if (!active) return;
        setIsEntityDetailsLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [projectId, activeEntityId]);

  const groupedEntities = useMemo(
    () =>
      ENTITY_TYPE_OPTIONS.filter((option) => option.value === entityFilter).map((option) => ({
        type: option.value,
        label: ENTITY_TYPE_LABELS_RU[option.value],
        items: entities.filter((entity) => entity.type === option.value),
      })),
    [entities, entityFilter]
  );
  const chapterActs = useMemo(
    () =>
      projectActs
        .filter((act) => act.chapterId === chapterId)
        .sort((left, right) => left.orderIndex - right.orderIndex),
    [projectActs, chapterId]
  );
  const orderedBookActs = useMemo(
    () =>
      [...projectActs].sort((left, right) => {
        if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
        return left.orderIndex - right.orderIndex;
      }),
    [projectActs]
  );
  const showCharacterSearchResults = entityFilter === "character" && entitySearchQuery.trim().length > 0;

  const activeEntityName =
    entityDetails?.name || entities.find((entity) => entity.id === activeEntityId)?.name || null;
  const entityMentionsByAct = useMemo(() => {
    if (!entityDetails?.mentions?.length) return [];

    const groups: Array<{
      key: string;
      label: string;
      mentions: typeof entityDetails.mentions;
    }> = [];
    const groupByKey = new Map<string, (typeof groups)[number]>();

    for (const mention of entityDetails.mentions) {
      const key = mention.actId ? `act:${mention.actId}` : `chapter:${mention.chapterId || "none"}:no-act`;
      const label = mention.actTitle
        ? `Акт ${Number(mention.actOrderIndex ?? 0) + 1}: ${mention.actTitle}`
        : mention.chapterTitle
          ? `${mention.chapterTitle} · без акта`
          : "Без акта";

      let group = groupByKey.get(key);
      if (!group) {
        group = {
          key,
          label,
          mentions: [],
        };
        groupByKey.set(key, group);
        groups.push(group);
      }
      group.mentions.push(mention);
    }

    return groups;
  }, [entityDetails]);
  const appearanceTimeline = useMemo(() => {
    if (entityDetails?.type !== "character") return [];
    return [...(entityDetails.appearanceObservations || [])].sort((left, right) => {
      if (left.chapterOrderIndex !== right.chapterOrderIndex) return left.chapterOrderIndex - right.chapterOrderIndex;
      const leftAct = left.actOrderIndex ?? Number.MAX_SAFE_INTEGER;
      const rightAct = right.actOrderIndex ?? Number.MAX_SAFE_INTEGER;
      if (leftAct !== rightAct) return leftAct - rightAct;
      if (left.orderIndex !== right.orderIndex) return left.orderIndex - right.orderIndex;
      return left.attributeLabel.localeCompare(right.attributeLabel, "ru", { sensitivity: "base" });
    });
  }, [entityDetails]);
  const appearanceLatestByAttribute = useMemo(() => {
    if (!appearanceTimeline.length) return [];
    const byAttribute = new Map<string, (typeof appearanceTimeline)[number]>();
    for (const item of appearanceTimeline) {
      byAttribute.set(item.attributeKey, item);
    }
    return [...byAttribute.values()].sort((left, right) =>
      left.attributeLabel.localeCompare(right.attributeLabel, "ru", { sensitivity: "base" })
    );
  }, [appearanceTimeline]);
  const appearanceChanges = useMemo(() => {
    if (!appearanceTimeline.length) return [];
    const groups = new Map<string, { attributeLabel: string; entries: typeof appearanceTimeline }>();
    for (const item of appearanceTimeline) {
      const group = groups.get(item.attributeKey) || {
        attributeLabel: item.attributeLabel,
        entries: [],
      };
      group.entries.push(item);
      groups.set(item.attributeKey, group);
    }

    return [...groups.entries()]
      .map(([attributeKey, group]) => {
        const distinctValues = new Set(group.entries.map((entry) => entry.value.toLowerCase()));
        return {
          attributeKey,
          attributeLabel: group.attributeLabel,
          entries: group.entries,
          distinctValues: distinctValues.size,
        };
      })
      .filter((item) => item.distinctValues > 1)
      .sort((left, right) => left.attributeLabel.localeCompare(right.attributeLabel, "ru", { sensitivity: "base" }));
  }, [appearanceTimeline]);
  const handleEditorMentionOpenEntity = useCallback(
    ({ mentionId, entityId }: { mentionId: string; entityId: string }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("chapter", chapterId);
      params.set("entity", entityId);
      params.set("mention", mentionId);
      const query = params.toString();
      const nextUrl = query ? `${pathname}?${query}` : pathname;
      router.replace(nextUrl, { scroll: false });
      setIsInspectorOpen(true);
    },
    [chapterId, pathname, router, searchParams]
  );
  const handleMentionClick = useCallback(
    (mention: {
      id: string;
      chapterId: string | null;
    }) => {
      const nextChapterId = mention.chapterId || chapterId;
      const params = new URLSearchParams(searchParams.toString());
      params.set("chapter", nextChapterId);
      if (activeEntityId) {
        params.set("entity", activeEntityId);
      } else {
        params.delete("entity");
      }
      params.set("mention", mention.id);

      setScrollToMentionRequest({
        mentionId: mention.id,
        token: Date.now(),
      });

      const query = params.toString();
      const nextUrl = query ? `${pathname}?${query}` : pathname;
      router.push(nextUrl, { scroll: false });
      setIsInspectorOpen(true);
    },
    [activeEntityId, chapterId, pathname, router, searchParams]
  );
  const handleActClick = useCallback(
    (act: ProjectActItem) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("chapter", act.chapterId);
      params.delete("mention");
      const query = params.toString();
      const nextUrl = query ? `${pathname}?${query}` : pathname;
      router.push(nextUrl, { scroll: false });
      setIsInspectorOpen(true);
    },
    [pathname, router, searchParams]
  );
  const saveChipLabel =
    saveStatus === "saving" ? "Сохранение..." : saveStatus === "saved" ? "Сохранено" : "Ошибка сохранения";
  const SaveChipIcon =
    saveStatus === "saving" ? IconLoader2 : saveStatus === "saved" ? IconCircleCheck : IconAlertTriangle;
  const isImportLocked = Boolean(latestImport && ["queued", "running"].includes(latestImport.state));
  const importStageLabel = latestImport ? formatImportStageRu(latestImport.stage) : null;
  const importChipLabel = latestImport
    ? latestImport.state === "failed"
      ? "Импорт: ошибка"
      : latestImport.state === "completed"
        ? "Импорт: готово"
        : `Импорт: ${importStageLabel}`
    : null;
  const ImportChipIcon = latestImport
    ? latestImport.state === "failed"
      ? IconAlertTriangle
      : latestImport.state === "completed"
        ? IconCircleCheck
        : IconLoader2
    : null;
  const importModelChipLabel = `Модель: ${ACTIVE_ANALYSIS_MODEL_LABEL}`;
  const isRunInFlight = Boolean(run && (run.state === "queued" || run.state === "running"));
  const isRerunDisabled = isImportLocked || !document || isRerunSubmitting || isRunInFlight;

  const handleRerun = useCallback(async () => {
    if (isRerunDisabled) return;
    setError(null);
    setIsRerunSubmitting(true);
    try {
      await rerunChapterAnalysis(projectId, chapterId, {
        idempotencyKey: `${projectId}:${chapterId}:manual-rerun:${Date.now()}`,
      });
      await loadDocument();
    } catch (rerunError) {
      setError(rerunError instanceof Error ? rerunError.message : "Не удалось перезапустить анализ");
    } finally {
      setIsRerunSubmitting(false);
    }
  }, [chapterId, isRerunDisabled, loadDocument, projectId]);

  return (
    <div className="workspace-grid">
      <section className="editor-column">
        <header className="workspace-header">
          <div className="workspace-header-actions">
            {latestImport && importChipLabel && ImportChipIcon ? (
              <span className={`status-chip ${latestImport.state === "failed" ? "status-chip-danger" : ""}`}>
                <ImportChipIcon
                  size={14}
                  stroke={1.8}
                  className={latestImport.state === "queued" || latestImport.state === "running" ? "icon-spin" : undefined}
                />
                {importChipLabel}
              </span>
            ) : null}
            {importModelChipLabel ? <span className="status-chip">{importModelChipLabel}</span> : null}
            <span className="status-chip">
              <IconBrain size={14} stroke={1.8} />
              {formatAnalysisStatusRu(run?.state || "queued")}
            </span>
            <span className="save-chip">
              <SaveChipIcon size={14} stroke={1.8} className={saveStatus === "saving" ? "icon-spin" : undefined} />
              {saveChipLabel}
            </span>
            <button
              className="status-chip workspace-rerun-btn"
              type="button"
              onClick={() => {
                void handleRerun();
              }}
              disabled={isRerunDisabled}
              title={isRunInFlight ? "Текущий анализ еще выполняется" : "Перезапустить анализ главы"}
            >
              <IconRefresh size={14} stroke={1.8} className={isRerunSubmitting ? "icon-spin" : undefined} />
              Перезапустить анализ
            </button>
            <button
              className="button ghost mobile-only with-icon"
              type="button"
              onClick={() => setIsInspectorOpen(true)}
            >
              <IconLayoutSidebarRightExpand size={16} stroke={1.8} />
              Сущности
            </button>
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}
        {isImportLocked && latestImport ? (
          <div className="info-banner">
            Импорт книги выполняется ({formatImportStageRu(latestImport.stage)}). Редактор будет доступен после завершения.
          </div>
        ) : null}
        {latestImport?.state === "failed" ? (
          <div className="error-banner">Импорт книги завершился с ошибкой: {latestImport.error || "без деталей"}</div>
        ) : null}

        <div className="editor-canvas">
          {!document ? (
            <div className="editor-loading">Загрузка документа...</div>
          ) : (
            <NarrativeEditor
              richContent={draftRichContent}
              mentions={document.mentions}
              editable={!isImportLocked}
              activeEntityId={activeEntityId}
              activeMentionId={activeMentionId}
              scrollToMentionRequest={scrollToMentionRequest}
              debugTag={`${projectId}:${chapterId}`}
              onMentionOpenEntity={handleEditorMentionOpenEntity}
              onChange={(nextRichContent, meta) => {
                if (!hasLoadedServerDocumentRef.current) {
                  debugLog("editor:onChange_ignored_not_loaded", {
                    userInitiated: meta.userInitiated,
                    nextPlainLength: plainLength(nextRichContent),
                  });
                  return;
                }
                if (!meta.userInitiated) {
                  debugLog("editor:onChange_ignored_non_user", {
                    nextPlainLength: plainLength(nextRichContent),
                  });
                  return;
                }
                if (isImportLocked) {
                  debugLog("editor:onChange_ignored_import_locked", {
                    nextPlainLength: plainLength(nextRichContent),
                  });
                  return;
                }
                hasUserEditedRef.current = true;
                debugLog("editor:onChange_accept", {
                  nextPlainLength: plainLength(nextRichContent),
                });
                draftSnapshotRef.current = serializeRichContent(nextRichContent);
                setDraftRichContent(nextRichContent);
              }}
            />
          )}
        </div>
      </section>

      <aside className={`inspector ${isInspectorOpen ? "open" : ""}`}>
        {activeEntityId ? (
          <div className="inspector-header">
            <button className="button ghost with-icon" type="button" onClick={() => setEntityInUrl(null)}>
              <IconChevronLeft size={16} stroke={1.8} />
              Назад
            </button>
            <button
              className="button ghost mobile-only with-icon"
              type="button"
              onClick={() => setIsInspectorOpen(false)}
            >
              <IconX size={16} stroke={1.8} />
              Закрыть
            </button>
          </div>
        ) : (
          <div className="inspector-mobile-close mobile-only">
            <button className="button ghost with-icon" type="button" onClick={() => setIsInspectorOpen(false)}>
              <IconX size={16} stroke={1.8} />
              Закрыть
            </button>
          </div>
        )}

        {!activeEntityId ? (
          <>
            <div className="inspector-scroll">
              <section className="entity-group">
                <h3>Акты главы</h3>
                {!chapterActs.length ? <p className="muted">Появятся после завершения анализа главы</p> : null}
                {chapterActs.map((act) => (
                  <button
                    key={act.id}
                    className="entity-row-btn"
                    type="button"
                    onClick={() => handleActClick(act)}
                  >
                    <div>
                      <div className="entity-name">{`Акт ${act.orderIndex + 1}. ${act.title}`}</div>
                      <div className="entity-summary">{act.summary || "Краткое описание формируется автоматически"}</div>
                      <div className="muted">
                        Абзацы: {act.paragraphStart + 1} - {act.paragraphEnd + 1}
                      </div>
                    </div>
                    <div className="entity-meta">
                      <div className="entity-type-chip">Персонажи</div>
                      <div className="muted">
                        {act.characters.length
                          ? act.characters
                              .slice(0, 4)
                              .map((character) => `${character.name} (${character.mentionCount})`)
                              .join(", ")
                          : "Нет"}
                      </div>
                    </div>
                  </button>
                ))}
              </section>

              {orderedBookActs.length > chapterActs.length ? (
                <section className="entity-group">
                  <h3>Порядок актов книги</h3>
                  {orderedBookActs.map((act) => (
                    <button
                      key={`book-${act.id}`}
                      className="mention-item mention-item-button"
                      type="button"
                      onClick={() => handleActClick(act)}
                    >
                      <div>{`${act.chapterTitle} · Акт ${act.orderIndex + 1}: ${act.title}`}</div>
                      <div className="muted">{act.summary || "Без описания"}</div>
                    </button>
                  ))}
                </section>
              ) : null}

              <section className="entity-group">
                <div className="entity-filter-tabs">
                  {ENTITY_TYPE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`entity-filter-tab ${entityFilter === option.value ? "active" : ""}`}
                      onClick={() => setEntityFilter(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <input
                  className="entity-search-input"
                  type="search"
                  value={entitySearchQuery}
                  onChange={(event) => setEntitySearchQuery(event.target.value)}
                  placeholder={
                    entityFilter === "character"
                      ? "Поиск по имени, алиасу и упоминаниям"
                      : `Поиск в ${ENTITY_TYPE_LABELS_RU[entityFilter].toLowerCase()}`
                  }
                />
              </section>

              {showCharacterSearchResults ? (
                <>
                  <section className="entity-group">
                    <h3>Персонажи</h3>
                    {!characterSearch.characters.length ? <p className="muted">Нет совпадений</p> : null}
                    {characterSearch.characters.map((character) => (
                      <button
                        key={character.id}
                        className="entity-row-btn"
                        type="button"
                        onClick={() => {
                          setEntityInUrl(character.id);
                          setIsInspectorOpen(true);
                        }}
                      >
                        <div>
                          <div className="entity-name">{character.canonicalName}</div>
                          <div className="entity-summary">
                            {character.shortDescription || "Описание появится после анализа"}
                          </div>
                        </div>
                        <div className="entity-meta">
                          <div className="entity-type-chip">Персонаж</div>
                          <div className="muted">Упоминаний: {character.mentionCount}</div>
                        </div>
                      </button>
                    ))}
                  </section>

                  <section className="entity-group">
                    <h3>Упоминания</h3>
                    {!characterSearch.mentions.length ? <p className="muted">Нет совпадений</p> : null}
                    {characterSearch.mentions.map((mention) => (
                      <button
                        key={mention.id}
                        className={`mention-item mention-item-button ${activeMentionId === mention.id ? "active" : ""}`}
                        type="button"
                        onClick={() => handleMentionClick({ id: mention.id, chapterId: mention.chapterId })}
                        title={mention.sourceText}
                      >
                        <div>{mention.snippet || mention.sourceText}</div>
                        <div className="muted">
                          {mention.canonicalName}
                          {mention.chapterTitle ? ` • ${mention.chapterTitle}` : ""}
                        </div>
                      </button>
                    ))}
                  </section>
                </>
              ) : null}

              {!showCharacterSearchResults
                ? groupedEntities.map((group) => (
                    <section key={group.type} className="entity-group">
                      <h3>{group.label}</h3>
                      {!group.items.length ? <p className="muted">Пока пусто</p> : null}
                      {group.items.map((entity) => (
                        <button
                          key={entity.id}
                          className={`entity-row-btn ${activeEntityId === entity.id ? "active" : ""}`}
                          type="button"
                          onClick={() => {
                            setEntityInUrl(entity.id);
                            setIsInspectorOpen(true);
                          }}
                        >
                          <div>
                            <div className="entity-name">{entity.name}</div>
                            <div className="entity-summary">{entity.summary || "Summary появится после анализа"}</div>
                          </div>
                          <div className="entity-meta">
                            <div className="entity-type-chip">{ENTITY_TYPE_SHORT_RU[entity.type]}</div>
                            <div className="muted">Упоминаний: {entity.mentionCount}</div>
                          </div>
                        </button>
                      ))}
                    </section>
                  ))
                : null}
            </div>
          </>
        ) : (
          <div className="inspector-scroll">
            {isEntityDetailsLoading ? <p className="muted">Загрузка...</p> : null}
            {entityDetails ? (
              <article className="entity-details">
                <h2>{entityDetails.name}</h2>
                <div className="entity-type-chip">{ENTITY_TYPE_SHORT_RU[entityDetails.type]}</div>
                <p className="entity-summary">
                  {entityDetails.shortDescription || entityDetails.summary || "Summary будет добавлен после AI-анализа документа."}
                </p>

                {entityDetails.type === "character" ? (
                  <section>
                    <h4 className="entity-section-title">
                      <IconQuote size={15} stroke={1.8} />
                      Профиль
                    </h4>
                    <p className="muted">Упоминаний: {entityDetails.mentionCount ?? entityDetails.mentions.length}</p>
                    {entityDetails.firstAppearance ? (
                      <p className="muted">
                        Первое появление: {entityDetails.firstAppearance.chapterTitle} (offset {entityDetails.firstAppearance.offset ?? 0})
                      </p>
                    ) : null}
                    {entityDetails.lastAppearance ? (
                      <p className="muted">
                        Последнее появление: {entityDetails.lastAppearance.chapterTitle} (offset {entityDetails.lastAppearance.offset ?? 0})
                      </p>
                    ) : null}
                  </section>
                ) : null}

                {entityDetails.type === "character" ? (
                  <section>
                    <h4 className="entity-section-title">Алиасы</h4>
                    {!entityDetails.aliases?.length ? <p className="muted">Нет</p> : null}
                    {entityDetails.aliases?.map((alias) => (
                      <div key={alias.id} className="muted">
                        {alias.value} ({alias.aliasType})
                      </div>
                    ))}
                  </section>
                ) : null}

                {entityDetails.type === "character" ? (
                  <section>
                    <h4 className="entity-section-title">Присутствие по главам</h4>
                    {!entityDetails.chapters?.length ? <p className="muted">Нет</p> : null}
                    {entityDetails.chapters?.map((chapter) => (
                      <div key={chapter.chapterId} className="muted">
                        {chapter.chapterTitle}: {chapter.mentionCount}
                      </div>
                    ))}
                  </section>
                ) : null}

                {entityDetails.type === "character" ? (
                  <section>
                    <h4 className="entity-section-title">Присутствие по актам</h4>
                    {!entityDetails.acts?.length ? <p className="muted">Нет</p> : null}
                    {entityDetails.acts?.map((act) => (
                      <div key={act.actId} className="muted">
                        {act.chapterTitle} · Акт {act.actOrderIndex + 1} ({act.actTitle}): {act.mentionCount}
                      </div>
                    ))}
                  </section>
                ) : null}

                {entityDetails.type === "character" ? (
                  <section>
                    <h4 className="entity-section-title">Внешность (актуально)</h4>
                    {!appearanceLatestByAttribute.length ? (
                      <p className="muted">Пока нет зафиксированных деталей внешности</p>
                    ) : null}
                    {appearanceLatestByAttribute.map((item) => (
                      <div key={`appearance-latest-${item.id}`} className="mention-item">
                        <div>
                          <strong>{item.attributeLabel}:</strong> {item.value}
                        </div>
                        <div className="muted">
                          {formatAppearanceScopeRu(item.scope)}
                          {item.chapterTitle ? ` • ${item.chapterTitle}` : ""}
                          {item.actOrderIndex !== null ? ` • Акт ${item.actOrderIndex + 1}` : ""}
                        </div>
                        {item.summary ? <div className="muted">{item.summary}</div> : null}
                        {item.evidence.length ? (
                          <div className="muted">
                            Пруфы:{" "}
                            {item.evidence.slice(0, 2).map((evidence) => (
                              <button
                                key={evidence.id}
                                type="button"
                                className={`entity-link-btn ${activeMentionId === evidence.mentionId ? "active" : ""}`}
                                onClick={() =>
                                  handleMentionClick({
                                    id: evidence.mentionId,
                                    chapterId: evidence.chapterId,
                                  })
                                }
                                title={evidence.sourceText}
                              >
                                {`§${evidence.paragraphIndex + 1}`}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </section>
                ) : null}

                {entityDetails.type === "character" ? (
                  <section>
                    <h4 className="entity-section-title">Изменения внешности</h4>
                    {!appearanceChanges.length ? <p className="muted">Явных изменений не найдено</p> : null}
                    {appearanceChanges.map((group) => (
                      <div key={`appearance-change-${group.attributeKey}`} className="mention-item">
                        <div>
                          <strong>{group.attributeLabel}</strong>
                        </div>
                        {group.entries.map((entry) => (
                          <div key={entry.id} className="muted">
                            {entry.chapterTitle}
                            {entry.actOrderIndex !== null ? ` · Акт ${entry.actOrderIndex + 1}` : ""}
                            {`: ${entry.value}`}
                          </div>
                        ))}
                      </div>
                    ))}
                  </section>
                ) : null}

                {entityDetails.type === "character" ? (
                  <section>
                    <h4 className="entity-section-title">Таймлайн внешности</h4>
                    {!appearanceTimeline.length ? <p className="muted">Нет наблюдений</p> : null}
                    {appearanceTimeline.map((item) => (
                      <div key={`appearance-timeline-${item.id}`} className="mention-item">
                        <div>
                          {item.chapterTitle}
                          {item.actOrderIndex !== null ? ` · Акт ${item.actOrderIndex + 1}` : ""}
                        </div>
                        <div>
                          <strong>{item.attributeLabel}:</strong> {item.value}
                        </div>
                        <div className="muted">
                          {formatAppearanceScopeRu(item.scope)}
                          {typeof item.confidence === "number" ? ` • conf ${item.confidence.toFixed(2)}` : ""}
                        </div>
                        {item.summary ? <div className="muted">{item.summary}</div> : null}
                        {item.evidence.length ? (
                          <div className="muted">
                            {item.evidence.map((evidence) => (
                              <button
                                key={evidence.id}
                                className={`mention-item mention-item-button ${activeMentionId === evidence.mentionId ? "active" : ""}`}
                                type="button"
                                onClick={() =>
                                  handleMentionClick({
                                    id: evidence.mentionId,
                                    chapterId: evidence.chapterId,
                                  })
                                }
                                title={evidence.sourceText}
                              >
                                <div>{evidence.snippet || evidence.sourceText}</div>
                                <div className="muted">
                                  {evidence.chapterTitle ? `${evidence.chapterTitle} • ` : ""}
                                  абзац {evidence.paragraphIndex + 1}
                                </div>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </section>
                ) : null}

                <section>
                  <h4 className="entity-section-title">
                    <IconHierarchy2 size={15} stroke={1.8} />
                    Контейнеры
                  </h4>
                  {!entityDetails.containers.length ? <p className="muted">Нет</p> : null}
                  {entityDetails.containers.map((container) => (
                    <button
                      className="entity-link-btn"
                      key={container.id}
                      type="button"
                      onClick={() => setEntityInUrl(container.id)}
                    >
                      {container.name}
                    </button>
                  ))}
                </section>

                <section>
                  <h4 className="entity-section-title">
                    <IconMapPin size={15} stroke={1.8} />
                    Вложенные локации
                  </h4>
                  {!entityDetails.containedLocations.length ? <p className="muted">Нет</p> : null}
                  {entityDetails.containedLocations.map((child) => (
                    <button
                      className="entity-link-btn"
                      key={child.id}
                      type="button"
                      onClick={() => setEntityInUrl(child.id)}
                    >
                      {child.name}
                    </button>
                  ))}
                </section>

                <section>
                  <h4 className="entity-section-title">
                    <IconQuote size={15} stroke={1.8} />
                    Упоминания
                  </h4>
                  {!entityMentionsByAct.length ? <p className="muted">Нет упоминаний</p> : null}
                  {entityMentionsByAct.map((group) => (
                    <div key={group.key}>
                      <div className="muted">{group.label}</div>
                      {group.mentions.map((mention) => (
                        <button
                          key={mention.id}
                          className={`mention-item mention-item-button ${activeMentionId === mention.id ? "active" : ""}`}
                          type="button"
                          onClick={() => handleMentionClick(mention)}
                          title={mention.sourceText}
                        >
                          <div>{mention.snippet || mention.sourceText}</div>
                          <div className="muted">
                            {mention.mentionType || "alias"}
                            {typeof mention.confidence === "number" ? ` • conf ${mention.confidence.toFixed(2)}` : ""}
                            {mention.chapterTitle ? ` • ${mention.chapterTitle}` : ""}
                          </div>
                        </button>
                      ))}
                    </div>
                  ))}
                </section>
              </article>
            ) : (
              <p className="muted">{activeEntityName ? `Загрузка ${activeEntityName}...` : "Сущность не найдена"}</p>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
