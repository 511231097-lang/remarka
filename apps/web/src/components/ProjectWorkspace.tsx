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
  IconX,
} from "@tabler/icons-react";
import {
  EMPTY_RICH_TEXT_DOCUMENT,
  richTextToPlainText,
  type DocumentPayload,
} from "@remarka/contracts";
import { NarrativeEditor } from "@/components/NarrativeEditor";
import {
  fetchProjectDocument,
  fetchProjectEntities,
  fetchProjectEntityDetails,
  saveProjectDocument,
  subscribeProjectStatus,
  type ProjectEntityDetails,
  type ProjectEntityListItem,
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

export function ProjectWorkspace({ projectId, chapterId }: ProjectWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeEntityId = useMemo(() => getEntityIdFromSearch(searchParams.toString()), [searchParams]);
  const activeMentionId = useMemo(() => getMentionIdFromSearch(searchParams.toString()), [searchParams]);

  const [document, setDocument] = useState<DocumentPayload | null>(null);
  const [draftRichContent, setDraftRichContent] = useState<unknown>(EMPTY_RICH_TEXT_DOCUMENT);
  const [entities, setEntities] = useState<ProjectEntityListItem[]>([]);
  const [entityDetails, setEntityDetails] = useState<ProjectEntityDetails | null>(null);
  const [isEntityDetailsLoading, setIsEntityDetailsLoading] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [scrollToMentionRequest, setScrollToMentionRequest] = useState<{ mentionId: string; token: number } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const saveRequestVersion = useRef(0);
  const previousServerRichRef = useRef(serializeRichContent(EMPTY_RICH_TEXT_DOCUMENT));
  const draftSnapshotRef = useRef(serializeRichContent(EMPTY_RICH_TEXT_DOCUMENT));
  const hasUnsavedChangesRef = useRef(false);
  const hasUserEditedRef = useRef(false);
  const hasLoadedServerDocumentRef = useRef(false);
  const pendingServerRefreshRef = useRef(false);
  const debugSeqRef = useRef(0);

  const debugLog = useCallback(
    (event: string, payload?: Record<string, unknown>) => {
      debugSeqRef.current += 1;
      console.info(`[remarka][workspace:${projectId}:${chapterId}][${debugSeqRef.current}] ${event}`, payload || {});
    },
    [projectId, chapterId]
  );

  const applyServerDocument = useCallback((loaded: DocumentPayload) => {
    const loadedServerSnapshot = serializeRichContent(loaded.richContent);
    const currentSnapshot = draftSnapshotRef.current;
    const shouldReplaceDraft = currentSnapshot === previousServerRichRef.current;
    const nextSnapshot = shouldReplaceDraft ? loadedServerSnapshot : currentSnapshot;

    setDocument(loaded);
    if (shouldReplaceDraft) {
      setDraftRichContent(loaded.richContent);
      draftSnapshotRef.current = loadedServerSnapshot;
      hasUserEditedRef.current = false;
    }

    debugLog("applyServerDocument", {
      loadedVersion: loaded.contentVersion,
      loadedStatus: loaded.analysisStatus,
      loadedPlainLength: loaded.content.length,
      loadedRichPlainLength: plainLength(loaded.richContent),
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
      loadedVersion: loaded.contentVersion,
      loadedStatus: loaded.analysisStatus,
      loadedPlainLength: loaded.content.length,
      loadedRichPlainLength: plainLength(loaded.richContent),
      mentions: loaded.mentions.length,
    });
    applyServerDocument(loaded);
  }, [projectId, chapterId, applyServerDocument, debugLog]);

  const loadEntities = useCallback(async () => {
    const loaded = await fetchProjectEntities(projectId);
    setEntities(loaded);
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
    saveRequestVersion.current = 0;
    setDocument(null);
    setDraftRichContent(EMPTY_RICH_TEXT_DOCUMENT);
    setSaveStatus("idle");
    setEntityDetails(null);
    setIsEntityDetailsLoading(false);
    setIsInspectorOpen(false);
    setScrollToMentionRequest(null);
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
        const [loadedDocument, loadedEntities] = await Promise.all([
          fetchProjectDocument(projectId, chapterId),
          fetchProjectEntities(projectId),
        ]);
        if (!active) return;
        debugLog("initialLoad:success", {
          loadedVersion: loadedDocument.contentVersion,
          loadedStatus: loadedDocument.analysisStatus,
          loadedPlainLength: loadedDocument.content.length,
          loadedRichPlainLength: plainLength(loadedDocument.richContent),
          entities: loadedEntities.length,
        });
        applyServerDocument(loadedDocument);
        setEntities(loadedEntities);
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
          const saved = await saveProjectDocument(projectId, chapterId, snapshotRich);
          if (ticket !== saveRequestVersion.current) return;

          const savedSerialized = serializeRichContent(saved.richContent);
          debugLog("autosave:response", {
            ticket,
            savedVersion: saved.contentVersion,
            savedPlainLength: saved.content.length,
            savedRichPlainLength: plainLength(saved.richContent),
          });
          setDocument(saved);
          previousServerRichRef.current = savedSerialized;
          const currentSerialized = draftSnapshotRef.current;
          const shouldReplaceDraft = currentSerialized === snapshotSerialized;
          if (shouldReplaceDraft) {
            setDraftRichContent(saved.richContent);
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
  }, [document, draftRichContent, projectId, chapterId, debugLog]);

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
      onStatus: (payload) => {
        if (payload.chapterId && payload.chapterId !== chapterId) return;
        setDocument((previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            analysisStatus: payload.analysisStatus as DocumentPayload["analysisStatus"],
            contentVersion: payload.contentVersion,
            lastAnalyzedVersion: payload.lastAnalyzedVersion,
          };
        });

        if (payload.analysisStatus === "completed" || payload.analysisStatus === "failed") {
          if (hasUnsavedChangesRef.current) {
            pendingServerRefreshRef.current = true;
          } else {
            void loadDocument();
          }
          void loadEntities();
        }
      },
      onError: (message) => setError(message),
    });
  }, [projectId, chapterId, loadDocument, loadEntities]);

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
      ENTITY_TYPE_OPTIONS.map((option) => ({
        type: option.value,
        label: ENTITY_TYPE_LABELS_RU[option.value],
        items: entities.filter((entity) => entity.type === option.value),
      })),
    [entities]
  );

  const activeEntityName =
    entityDetails?.name || entities.find((entity) => entity.id === activeEntityId)?.name || null;
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
  const saveChipLabel =
    saveStatus === "saving" ? "Сохранение..." : saveStatus === "saved" ? "Сохранено" : "Ошибка сохранения";
  const SaveChipIcon =
    saveStatus === "saving" ? IconLoader2 : saveStatus === "saved" ? IconCircleCheck : IconAlertTriangle;

  return (
    <div className="workspace-grid">
      <section className="editor-column">
        <header className="workspace-header">
          <div className="workspace-header-actions">
            <span className="status-chip">
              <IconBrain size={14} stroke={1.8} />
              {formatAnalysisStatusRu(document?.analysisStatus || "idle")}
            </span>
            <span className="save-chip">
              <SaveChipIcon size={14} stroke={1.8} className={saveStatus === "saving" ? "icon-spin" : undefined} />
              {saveChipLabel}
            </span>
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

        <div className="editor-canvas">
          {!document ? (
            <div className="editor-loading">Загрузка документа...</div>
          ) : (
            <NarrativeEditor
              richContent={draftRichContent}
              mentions={document.mentions}
              activeEntityId={activeEntityId}
              activeMentionId={activeMentionId}
              scrollToMentionRequest={scrollToMentionRequest}
              debugTag={`${projectId}:${chapterId}`}
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
              {groupedEntities.map((group) => (
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
              ))}
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
                  {entityDetails.summary || "Summary будет добавлен после AI-анализа документа."}
                </p>

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
                  {!entityDetails.mentions.length ? <p className="muted">Нет упоминаний</p> : null}
                  {entityDetails.mentions.map((mention) => (
                    <button
                      key={mention.id}
                      className={`mention-item mention-item-button ${activeMentionId === mention.id ? "active" : ""}`}
                      type="button"
                      onClick={() => handleMentionClick(mention)}
                      title={mention.sourceText}
                    >
                      {mention.snippet || mention.sourceText}
                    </button>
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
