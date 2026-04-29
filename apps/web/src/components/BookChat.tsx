"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Bookmark,
  Brain,
  ChevronRight,
  Filter,
  Library,
  MessageSquare,
  Pencil,
  Plus,
  Quote,
  Search,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { BookPreviewStage } from "./BookGalleryCard";
import { BookSettings } from "./BookSettings";
import { ChatModePill, ChatReadinessGate } from "./BookChatReadiness";
import { ChatMessageMarkdown } from "./ChatMessageMarkdown";
import { ChatSidebarLegal } from "./SiteFooter";
import {
  createBookChatSession,
  deleteBookChatSession,
  getBook,
  getBookChatMessages,
  listBookChatSessions,
  streamBookChatMessage,
} from "@/lib/booksClient";
import {
  appendBookDetailSource,
  resolveBookDetailSource,
  type BookDetailSource,
} from "@/lib/bookDetailNavigation";
import {
  type BookChatEvidenceDTO,
  type BookChatMessageDTO,
  type BookChatSessionDTO,
  type BookChatStreamFinalEventDTO,
  type BookCoreDTO,
} from "@/lib/books";
import { useBookChatReadiness } from "@/lib/useBookChatReadiness";

interface UiMessage extends BookChatMessageDTO {
  pending?: boolean;
}

interface ActiveCite {
  label: string;
  chapterOrderIndex: number | null;
  snippet: string;
  kind: string;
}

const MAX_STREAM_REASONING_CHARS = 480;
const RUSSIAN_REASONING_PLACEHOLDER = "Анализирую запрос, сверяю факты по книге и подбираю релевантные фрагменты.";

const SUGGESTED_PROMPTS_BOOK = [
  "О чём эта книга в одном абзаце?",
  "Какие конфликты движут сюжетом?",
  "Что меняет главного героя?",
];

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSessionTime(value: string | null, fallback: string): string {
  const date = new Date(value || fallback);
  if (Number.isNaN(date.getTime())) return "Недавно";

  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return new Intl.DateTimeFormat("ru-RU", {
    day: isSameDay ? undefined : "2-digit",
    month: isSameDay ? undefined : "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function decl(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

function normalizeReasoningDeltaForDisplay(delta: string): string {
  const normalized = String(delta || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const hasCyrillic = /[а-яё]/i.test(normalized);
  const hasLatin = /[a-z]/i.test(normalized);
  if (hasCyrillic || !hasLatin) return normalized;
  return RUSSIAN_REASONING_PLACEHOLDER;
}

function appendReasoningPreview(current: string | null, delta: string): string {
  const normalizedDelta = normalizeReasoningDeltaForDisplay(delta);
  if (!normalizedDelta) return String(current || "");

  const currentNormalized = String(current || "").trim();
  if (currentNormalized.endsWith(normalizedDelta)) return currentNormalized;
  const merged = `${currentNormalized} ${normalizedDelta}`.trim();
  if (merged.length <= MAX_STREAM_REASONING_CHARS) return merged;
  return `...${merged.slice(-MAX_STREAM_REASONING_CHARS)}`;
}

function toAssistantMessageFromFinal(final: BookChatStreamFinalEventDTO): UiMessage {
  return {
    id: final.messageId || `local:assistant:${Date.now()}`,
    role: "assistant",
    content: final.answer || "",
    rawAnswer: final.rawAnswer || null,
    evidence: Array.isArray(final.evidence) ? final.evidence : [],
    usedSources: Array.isArray(final.usedSources) ? final.usedSources : [],
    confidence: final.confidence || null,
    mode: final.mode || null,
    citations: Array.isArray(final.citations) ? final.citations : [],
    inlineCitations: Array.isArray(final.inlineCitations) ? final.inlineCitations : [],
    answerItems: Array.isArray(final.answerItems) ? final.answerItems : [],
    referenceResolution: final.referenceResolution || null,
    createdAt: new Date().toISOString(),
  };
}

function resolveSourceWithFallback(source: BookDetailSource | null, canManage: boolean | undefined): BookDetailSource {
  return source || (canManage ? "library" : "explore");
}

function evidenceToActiveCite(item: BookChatEvidenceDTO): ActiveCite {
  return {
    label: item.label || "Фрагмент",
    chapterOrderIndex: typeof item.chapterOrderIndex === "number" ? item.chapterOrderIndex : null,
    snippet: item.snippet || "",
    kind: String(item.kind || ""),
  };
}

function evidenceKindLabel(kind: string): string {
  switch (kind) {
    case "scene":
      return "Сцена";
    case "event":
      return "Событие";
    case "quote":
      return "Цитата";
    case "relation":
      return "Связь";
    case "summary_artifact":
      return "Сводка";
    case "chapter_span":
      return "Глава";
    case "character":
      return "Герой";
    case "theme":
      return "Тема";
    case "location":
      return "Место";
    case "literary_section":
      return "Раздел";
    default:
      return "Источник";
  }
}

function groupSessions(sessions: BookChatSessionDTO[]) {
  const groups = { today: [] as BookChatSessionDTO[], week: [] as BookChatSessionDTO[], earlier: [] as BookChatSessionDTO[] };
  const now = Date.now();
  const day = 86400000;
  for (const session of sessions) {
    const ref = session.lastMessageAt || session.updatedAt || session.createdAt;
    const ts = new Date(ref).getTime();
    const age = Number.isFinite(ts) ? now - ts : Number.POSITIVE_INFINITY;
    if (age < day) groups.today.push(session);
    else if (age < 7 * day) groups.week.push(session);
    else groups.earlier.push(session);
  }
  return groups;
}

export function BookChat() {
  const params = useParams<{ bookId: string; sessionId?: string }>();
  const searchParams = useSearchParams();
  const bookId = String(params.bookId || "");
  const routeSessionId = String(params.sessionId || "").trim() || null;
  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const isSendingRef = useRef(false);
  const activeStreamAbortRef = useRef<AbortController | null>(null);

  const [book, setBook] = useState<BookCoreDTO | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<BookChatSessionDTO[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(routeSessionId);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [streamReasoning, setStreamReasoning] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeCite, setActiveCite] = useState<ActiveCite | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement | null>(null);

  const { readiness, loading: readinessLoading, error: readinessError } = useBookChatReadiness(bookId);
  const activeSessionId = routeSessionId || currentSessionId;

  const source = resolveBookDetailSource(searchParams.get("from"));
  const resolvedSource = resolveSourceWithFallback(source, book?.canManage);
  const readinessUnavailable = !readinessLoading && !readiness;

  const buildBookPath = (path: string) => appendBookDetailSource(path, resolvedSource);

  useEffect(() => {
    return () => {
      activeStreamAbortRef.current?.abort();
      activeStreamAbortRef.current = null;
      isSendingRef.current = false;
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    setActiveCite(null);
    setInputValue("");
  }, [activeSessionId]);

  useEffect(() => {
    if (!scopeOpen) return;
    const onClickOutside = (event: MouseEvent) => {
      if (scopeRef.current && !scopeRef.current.contains(event.target as Node)) setScopeOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [scopeOpen]);

  useEffect(() => {
    if (!bookId) return;
    let active = true;

    async function loadBookData() {
      try {
        const nextBook = await getBook(bookId);
        if (!active) return;
        setBook(nextBook);
        setBookError(null);
      } catch (error) {
        if (!active) return;
        setBook(null);
        setBookError(error instanceof Error ? error.message : "Не удалось загрузить книгу");
      }
    }

    void loadBookData();
    return () => {
      active = false;
    };
  }, [bookId]);

  const refreshSessions = async (preferredSessionId?: string | null): Promise<string | null> => {
    if (!bookId) return null;

    const nextSessions = await listBookChatSessions(bookId);
    setSessions(nextSessions);

    const requested = String(preferredSessionId || "").trim();
    if (requested && nextSessions.some((session) => session.id === requested)) {
      setCurrentSessionId(requested);
      return requested;
    }

    if (routeSessionId && nextSessions.some((session) => session.id === routeSessionId)) {
      setCurrentSessionId(routeSessionId);
      return routeSessionId;
    }

    if (currentSessionId && nextSessions.some((session) => session.id === currentSessionId)) {
      return currentSessionId;
    }

    const fallbackSessionId = nextSessions[0]?.id || null;
    setCurrentSessionId(fallbackSessionId);
    return fallbackSessionId;
  };

  const loadMessages = async (sessionId: string) => {
    if (!bookId || !sessionId) return;
    const nextMessages = await getBookChatMessages(bookId, sessionId);
    setMessages(nextMessages);
  };

  useEffect(() => {
    if (!bookId || !readiness?.canChat) {
      setSessions([]);
      setCurrentSessionId(null);
      return;
    }

    let active = true;

    async function loadInitialSessions() {
      try {
        let nextSessions = await listBookChatSessions(bookId);
        if (!active) return;

        if (nextSessions.length === 0) {
          const created = await createBookChatSession(bookId, {
            title: "Новый чат",
          });
          nextSessions = [created];
        }

        if (!active) return;
        setSessions(nextSessions);
        setCurrentSessionId(() => {
          if (routeSessionId && nextSessions.some((session) => session.id === routeSessionId)) {
            return routeSessionId;
          }
          return nextSessions[0]?.id || null;
        });
      } catch (error) {
        if (!active) return;
        setBookError(error instanceof Error ? error.message : "Не удалось загрузить чат");
      }
    }

    void loadInitialSessions();
    return () => {
      active = false;
    };
  }, [bookId, readiness?.canChat, routeSessionId]);

  useEffect(() => {
    if (!routeSessionId) return;
    if (!sessions.some((session) => session.id === routeSessionId)) return;
    setCurrentSessionId((current) => (current === routeSessionId ? current : routeSessionId));
  }, [routeSessionId, sessions]);

  useEffect(() => {
    if (!bookId || !readiness?.canChat) return;

    if (!routeSessionId) {
      if (currentSessionId) {
        router.replace(buildBookPath(`/book/${bookId}/chat/${currentSessionId}`));
      }
      return;
    }

    if (sessions.length === 0) return;
    if (sessions.some((session) => session.id === routeSessionId)) return;

    const fallbackSessionId =
      (currentSessionId && sessions.some((session) => session.id === currentSessionId) ? currentSessionId : null) ||
      sessions[0]?.id ||
      null;

    if (fallbackSessionId) {
      router.replace(buildBookPath(`/book/${bookId}/chat/${fallbackSessionId}`));
      return;
    }

    if (routeSessionId) {
      router.replace(buildBookPath(`/book/${bookId}/chat`));
    }
  }, [bookId, currentSessionId, routeSessionId, readiness?.canChat, router, resolvedSource, sessions]);

  useEffect(() => {
    if (!activeSessionId || !readiness?.canChat) return;
    let active = true;
    const nextActiveSessionId = activeSessionId;

    async function loadCurrentMessages() {
      try {
        const nextMessages = await getBookChatMessages(bookId, nextActiveSessionId);
        if (!active) return;
        setMessages(nextMessages);
      } catch (error) {
        if (!active) return;
        setMessages([
          {
            id: `local:error:${Date.now()}`,
            role: "assistant",
            content: `Ошибка загрузки сообщений: ${error instanceof Error ? error.message : "unknown"}`,
            rawAnswer: null,
            evidence: [],
            usedSources: [],
            confidence: null,
            mode: null,
            citations: [],
            inlineCitations: [],
            answerItems: [],
            referenceResolution: null,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    }

    void loadCurrentMessages();
    return () => {
      active = false;
    };
  }, [activeSessionId, book?.title, bookId, readiness?.canChat]);

  const ensureActiveSession = async (): Promise<string> => {
    if (!readiness?.canChat) {
      throw new Error("Чат ещё не готов");
    }
    if (activeSessionId) return activeSessionId;

    const created = await createBookChatSession(bookId, {
      title: "Новый чат",
    });
    await refreshSessions(created.id);
    router.replace(buildBookPath(`/book/${bookId}/chat/${created.id}`));
    return created.id;
  };

  const createSession = async () => {
    if (!bookId || isLoading || !readiness?.canChat) return;
    const created = await createBookChatSession(bookId, {
      title: "Новый чат",
    });
    await refreshSessions(created.id);
    setMessages([]);
    router.push(buildBookPath(`/book/${bookId}/chat/${created.id}`));
  };

  const removeSession = async (sessionId: string) => {
    if (!bookId || isLoading || !readiness?.canChat) return;
    await deleteBookChatSession(bookId, sessionId);
    const nextSessionId = await refreshSessions();

    if (nextSessionId) {
      router.replace(buildBookPath(`/book/${bookId}/chat/${nextSessionId}`));
      return;
    }

    router.replace(buildBookPath(`/book/${bookId}/chat`));
  };

  const sendMessage = async (questionRaw: string) => {
    if (!bookId || !readiness?.canChat) return;
    const question = String(questionRaw || "").trim();
    if (!question || isLoading || isSendingRef.current) return;

    isSendingRef.current = true;
    const streamAbortController = new AbortController();
    activeStreamAbortRef.current?.abort();
    activeStreamAbortRef.current = streamAbortController;
    setInputValue("");
    setIsLoading(true);
    setStreamStatus("Разбираю вопрос и подбираю опоры в тексте");
    setStreamReasoning(null);

    try {
      const sessionId = await ensureActiveSession();
      const optimisticUserMessage: UiMessage = {
        id: `local:user:${Date.now()}`,
        role: "user",
        content: question,
        rawAnswer: null,
        evidence: [],
        usedSources: [],
        confidence: null,
        mode: null,
        citations: [],
        inlineCitations: [],
        answerItems: [],
        referenceResolution: null,
        createdAt: new Date().toISOString(),
      };
      const assistantDraftId = `local:assistant:${Date.now() + 1}`;
      let assistantStarted = false;

      setMessages((current) => [...current.filter((message) => !message.pending), optimisticUserMessage]);

      await streamBookChatMessage({
        bookId,
        sessionId,
        signal: streamAbortController.signal,
        input: {
          message: question,
          entryContext: "full_chat",
        },
        onEvent: (event) => {
          if (streamAbortController.signal.aborted) return;
          if (event.type === "status") {
            if (assistantStarted) return;
            const text = String(event.text || "").trim();
            if (text) setStreamStatus(text);
            return;
          }

          if (event.type === "reasoning") {
            if (assistantStarted) return;
            const text = String(event.text || "");
            if (!text) return;
            setStreamReasoning((current) => appendReasoningPreview(current, text));
            return;
          }

          if (event.type === "token") {
            const token = String(event.text || "");
            if (!token) return;
            assistantStarted = true;
            setStreamStatus(null);
            setStreamReasoning(null);
            setMessages((current) =>
              current.some((message) => message.id === assistantDraftId)
                ? current.map((message) =>
                    message.id === assistantDraftId
                      ? {
                          ...message,
                          content: `${message.content}${token}`,
                        }
                      : message
                  )
                : [
                    ...current,
                    {
                      id: assistantDraftId,
                      role: "assistant",
                      content: token,
                      rawAnswer: null,
                      evidence: [],
                      usedSources: [],
                      confidence: null,
                      mode: null,
                      citations: [],
                      inlineCitations: [],
                      answerItems: [],
                      referenceResolution: null,
                      createdAt: new Date().toISOString(),
                      pending: true,
                    },
                  ]
            );
            return;
          }

          if (event.type === "final" && event.final) {
            setStreamStatus(null);
            setStreamReasoning(null);
            const finalMessage = toAssistantMessageFromFinal(event.final);
            setMessages((current) =>
              assistantStarted && current.some((message) => message.id === assistantDraftId)
                ? current.map((message) => (message.id === assistantDraftId ? finalMessage : message))
                : [...current, finalMessage]
            );
          }
        },
      });

      await Promise.all([refreshSessions(sessionId), loadMessages(sessionId)]);
    } catch (error) {
      if (streamAbortController.signal.aborted) return;
      const errorMessage = error instanceof Error ? error.message : "Не удалось получить ответ";
      setStreamStatus(null);
      setStreamReasoning(null);
      setMessages((current) => [
        ...current.filter((message) => !message.pending),
        {
          id: `local:error:${Date.now()}`,
          role: "assistant",
          content: `Ошибка: ${errorMessage}`,
          rawAnswer: null,
          evidence: [],
          usedSources: [],
          confidence: null,
          mode: null,
          citations: [],
          inlineCitations: [],
          answerItems: [],
          referenceResolution: null,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      if (activeStreamAbortRef.current === streamAbortController) {
        activeStreamAbortRef.current = null;
      }
      isSendingRef.current = false;
      setIsLoading(false);
      setStreamStatus(null);
      setStreamReasoning(null);
    }
  };

  const filteredSessions = useMemo(() => {
    if (!search.trim()) return sessions;
    const needle = search.toLowerCase();
    return sessions.filter((session) => session.title.toLowerCase().includes(needle));
  }, [sessions, search]);

  const groupedSessions = useMemo(() => groupSessions(filteredSessions), [filteredSessions]);

  if (bookError) {
    return (
      <div className="container" style={{ paddingBottom: 72, paddingTop: 40 }}>
        <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", padding: 18 }}>
          {bookError}
        </div>
      </div>
    );
  }

  const groupLabels: Array<[keyof typeof groupedSessions, string]> = [
    ["today", "Сегодня"],
    ["week", "На неделе"],
    ["earlier", "Раньше"],
  ];

  const showSuggestions = readiness?.canChat && messages.length < 2 && !isLoading;
  const placeholderTitle = book ? `Спросите о «${book.title}»…` : "Спросите о книге…";

  return (
    <div
      className="screen-fade book-chat-shell"
      style={{
        borderTop: "1px solid var(--rule)",
        display: "grid",
        gridTemplateColumns: "288px minmax(0,1fr) 340px",
        height: "calc(100svh - 64px)",
      }}
    >
      {/* Left — sessions */}
      <aside
        style={{
          background: "var(--paper-2)",
          borderRight: "1px solid var(--rule)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div style={{ padding: "18px 18px 12px" }}>
          <button
            className="btn btn-mark btn-block"
            onClick={() => void createSession()}
            disabled={isLoading || !readiness?.canChat}
          >
            <Plus size={16} /> Новый чат
          </button>
        </div>
        <div style={{ padding: "0 18px 12px" }}>
          <div style={{ position: "relative" }}>
            <Search
              size={16}
              style={{
                color: "var(--ink-faint)",
                left: 12,
                position: "absolute",
                top: "50%",
                transform: "translateY(-50%)",
              }}
            />
            <input
              className="input"
              placeholder="Поиск по чатам"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ fontSize: 13, height: 36, paddingLeft: 36 }}
            />
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 8px 18px" }}>
          {readinessLoading && !readiness ? (
            <div className="muted" style={{ fontSize: 13, padding: 12 }}>Проверяем готовность чата...</div>
          ) : null}
          {readinessUnavailable ? (
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.55, padding: 12 }}>
              Не удалось проверить готовность чата.
            </div>
          ) : null}
          {!readinessLoading && readiness && !readiness.canChat ? (
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.55, padding: 12 }}>
              Список чатов появится, когда книга станет доступна для диалога.
            </div>
          ) : null}

          {readiness?.canChat
            ? groupLabels.map(([key, label]) => {
                const list = groupedSessions[key];
                if (!list.length) return null;
                return (
                  <div key={key} style={{ marginBottom: 18 }}>
                    <div className="mono" style={{ color: "var(--ink-faint)", padding: "8px 12px 6px" }}>{label}</div>
                    <div>
                      {list.map((session) => {
                        const isActive = activeSessionId === session.id;
                        const messageCountText = `${session.lastMessageAt ? "обновлён " : "создан "}${formatSessionTime(session.lastMessageAt, session.updatedAt)}`;
                        const canDelete = sessions.length > 1 && !isLoading;
                        return (
                          <div
                            key={session.id}
                            className={`bc-session-item ${isActive ? "active" : ""}`}
                            onClick={() => {
                              if (session.id !== activeSessionId) {
                                router.push(buildBookPath(`/book/${bookId}/chat/${session.id}`));
                              }
                            }}
                          >
                            <div className="bc-session-icon">
                              {book ? (
                                <BookPreviewStage book={book} size="sm" />
                              ) : (
                                <div
                                  style={{
                                    aspectRatio: "2/3",
                                    background: "var(--ink)",
                                    borderRadius: 3,
                                    color: "var(--paper)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: "100%",
                                  }}
                                >
                                  <Library size={14} />
                                </div>
                              )}
                            </div>
                            <div className="bc-session-main">
                              <div className="bc-session-title">{session.title}</div>
                              <div className="bc-session-sub">{messageCountText}</div>
                            </div>
                            <div className="bc-session-actions">
                              <button
                                title="Удалить чат"
                                disabled={!canDelete}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!canDelete) return;
                                  if (confirm("Удалить чат?")) void removeSession(session.id);
                                }}
                                style={{ opacity: canDelete ? 1 : 0.3 }}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            : null}

          {readiness?.canChat && filteredSessions.length === 0 ? (
            <div className="soft" style={{ fontSize: 13, padding: "24px 12px", textAlign: "center" }}>
              Чатов не найдено
            </div>
          ) : null}
        </div>
        <ChatSidebarLegal />
      </aside>

      {/* Center — dialog */}
      <main style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div
          style={{
            alignItems: "center",
            borderBottom: "1px solid var(--rule)",
            display: "flex",
            gap: 16,
            justifyContent: "space-between",
            padding: "14px 32px",
          }}
        >
          <div className="row-sm" style={{ minWidth: 0 }}>
            {book ? (
              <>
                <div style={{ flexShrink: 0, width: 28 }}><BookPreviewStage book={book} size="sm" /></div>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-serif)",
                      fontSize: 15,
                      lineHeight: 1.2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {book.title}
                  </div>
                  <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>
                    По книге · {book.author || "Автор не указан"}
                  </div>
                </div>
              </>
            ) : (
              <div className="muted">Книга</div>
            )}
          </div>
          <div className="row-sm" style={{ position: "relative" }} ref={scopeRef}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setScopeOpen((current) => !current)}
              title="Область чата (пока доступна только текущая книга)"
            >
              <Filter size={14} /> Область
            </button>
            {scopeOpen ? (
              <div
                style={{
                  background: "var(--cream)",
                  border: "1px solid var(--rule)",
                  borderRadius: "var(--r-lg)",
                  boxShadow: "var(--shadow-lg)",
                  padding: 8,
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 6px)",
                  width: 280,
                  zIndex: 50,
                }}
              >
                <div className="mono" style={{ color: "var(--ink-faint)", padding: "6px 10px" }}>Переключить контекст</div>
                <div className="bc-scope-item active">
                  {book ? (
                    <div style={{ flexShrink: 0, width: 20 }}><BookPreviewStage book={book} size="sm" /></div>
                  ) : (
                    <Library size={16} />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div>{book?.title || "Текущая книга"}</div>
                    <div className="bc-scope-hint">Активный режим</div>
                  </div>
                </div>
                <div className="bc-scope-item disabled" title="Чат по всей библиотеке появится позже">
                  <Library size={16} />
                  <div style={{ minWidth: 0 }}>
                    <div>Вся библиотека</div>
                    <div className="bc-scope-hint">Скоро</div>
                  </div>
                </div>
                <div className="bc-scope-item disabled" title="Подборки книг появятся позже">
                  <Sparkles size={16} />
                  <div style={{ minWidth: 0 }}>
                    <div>Подборка книг…</div>
                    <div className="bc-scope-hint">Скоро</div>
                  </div>
                  <ChevronRight size={12} style={{ color: "var(--ink-faint)", marginLeft: "auto" }} />
                </div>
              </div>
            ) : null}
            <Link className="btn btn-plain btn-sm" href={buildBookPath(`/book/${bookId}`)} title="Сохранить / открыть разбор">
              <Bookmark size={14} />
            </Link>
          </div>
        </div>

        {readinessError && !readiness && !readinessLoading ? (
          <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", margin: 24, padding: 14 }}>
            {readinessError}
          </div>
        ) : null}

        {readinessLoading && !readiness ? (
          <div className="muted" style={{ margin: "auto" }}>Проверяем готовность чата...</div>
        ) : null}
        {readinessUnavailable ? (
          <div className="muted" style={{ margin: "auto" }}>Не удалось получить состояние чата. Попробуйте обновить страницу.</div>
        ) : null}
        {!readinessLoading && readiness && !readiness.canChat ? (
          <div style={{ margin: "auto", maxWidth: 720, padding: 24 }}>
            <ChatReadinessGate readiness={readiness} compact={false} />
          </div>
        ) : null}

        {readiness?.canChat ? (
          <>
            <div ref={scrollAreaRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "32px 48px" }}>
              <div className="stack-xl" style={{ margin: "0 auto", maxWidth: 760 }}>
                {messages.length === 0 && book ? (
                  <ChatWelcome book={book} />
                ) : null}

                {messages.map((message) =>
                  message.role === "user" ? (
                    <UserMessage key={message.id} content={message.content} createdAt={message.createdAt} />
                  ) : (
                    <AssistantMessage
                      key={message.id}
                      message={message}
                      onCite={(cite) => setActiveCite(cite)}
                    />
                  )
                )}

                {isLoading ? (
                  <Typing
                    streamStatus={streamStatus}
                    streamReasoning={streamReasoning}
                  />
                ) : null}
                <div ref={messagesEndRef} />
              </div>
            </div>

            <div style={{ padding: "20px 48px 28px" }}>
              <div style={{ margin: "0 auto", maxWidth: 760 }}>
                {showSuggestions ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                    {SUGGESTED_PROMPTS_BOOK.map((prompt) => (
                      <button
                        key={prompt}
                        className="sug"
                        onClick={() => void sendMessage(prompt)}
                        disabled={isLoading}
                      >
                        <span className="k">вопрос</span>
                        {prompt}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div
                  style={{
                    background: "var(--cream)",
                    border: "1px solid var(--rule)",
                    borderRadius: "var(--r-lg)",
                    boxShadow: "var(--shadow-sm)",
                    padding: "14px 18px",
                  }}
                >
                  <textarea
                    className="textarea"
                    rows={2}
                    value={inputValue}
                    onChange={(event) => setInputValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage(inputValue);
                      }
                    }}
                    placeholder={placeholderTitle}
                    disabled={isLoading || !readiness?.canChat}
                    style={{ background: "transparent", border: "none", boxShadow: "none", padding: 0 }}
                  />
                  <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
                    <div className="mono" style={{ color: "var(--ink-faint)" }}>↵ отправить · ⇧↵ перенос</div>
                    <button
                      className="btn btn-mark btn-sm"
                      onClick={() => void sendMessage(inputValue)}
                      disabled={!inputValue.trim() || isLoading || !readiness?.canChat}
                      style={{ opacity: inputValue.trim() ? 1 : 0.5 }}
                    >
                      <Send size={16} /> Отправить
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </main>

      {/* Right — context */}
      <aside
        style={{
          background: "var(--paper-2)",
          borderLeft: "1px solid var(--rule)",
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {activeCite ? (
          <ActiveCitePanel cite={activeCite} onClose={() => setActiveCite(null)} />
        ) : (
          <ContextPanel
            book={book}
            buildBookPath={buildBookPath}
            bookId={bookId}
          />
        )}
      </aside>

      <style jsx>{`
        .bc-session-item {
          align-items: center;
          border-radius: var(--r);
          cursor: pointer;
          display: grid;
          gap: 10px;
          grid-template-columns: 32px 1fr auto;
          padding: 10px 12px;
          position: relative;
          transition: background 0.15s ease;
        }
        .bc-session-item:hover {
          background: var(--cream);
        }
        .bc-session-item.active {
          background: var(--cream);
          box-shadow: inset 0 0 0 1px var(--rule);
        }
        .bc-session-icon {
          width: 32px;
        }
        .bc-session-main {
          min-width: 0;
        }
        .bc-session-title {
          color: var(--ink);
          font-size: 13px;
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .bc-session-sub {
          color: var(--ink-muted);
          font-size: 11px;
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .bc-session-actions {
          display: flex;
          gap: 2px;
          opacity: 0;
          transition: opacity 0.15s ease;
        }
        .bc-session-item:hover .bc-session-actions,
        .bc-session-item.active .bc-session-actions {
          opacity: 1;
        }
        .bc-session-actions button {
          align-items: center;
          background: transparent;
          border: none;
          border-radius: 4px;
          color: var(--ink-muted);
          cursor: pointer;
          display: flex;
          height: 24px;
          justify-content: center;
          width: 24px;
        }
        .bc-session-actions button:hover {
          background: var(--paper-2);
          color: var(--ink);
        }
        .bc-scope-item {
          align-items: center;
          background: transparent;
          border: none;
          border-radius: var(--r-sm);
          color: var(--ink);
          cursor: pointer;
          display: flex;
          font-size: 13px;
          gap: 10px;
          padding: 8px 10px;
          text-align: left;
          width: 100%;
        }
        .bc-scope-item:hover {
          background: var(--paper-2);
        }
        .bc-scope-item.active {
          background: var(--paper-2);
        }
        .bc-scope-item.disabled {
          color: var(--ink-muted);
          cursor: not-allowed;
          opacity: 0.7;
        }
        .bc-scope-hint {
          color: var(--ink-muted);
          font-size: 11px;
          margin-top: 1px;
        }
        @keyframes bc-dot {
          0%, 80%, 100% {
            opacity: 0.3;
            transform: translateY(0);
          }
          40% {
            opacity: 1;
            transform: translateY(-3px);
          }
        }
        @media (max-width: 1100px) {
          :global(div.book-chat-shell) {
            grid-template-columns: 240px minmax(0, 1fr) !important;
          }
          :global(div.book-chat-shell > aside:last-of-type) {
            display: none !important;
          }
        }
        @media (max-width: 760px) {
          :global(div.book-chat-shell) {
            display: flex !important;
            flex-direction: column;
            height: auto !important;
            min-height: calc(100svh - 64px);
          }
          :global(div.book-chat-shell > aside:first-of-type) {
            max-height: 260px;
          }
        }
      `}</style>
    </div>
  );
}

function ChatWelcome({ book }: { book: BookCoreDTO }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      style={{ paddingTop: 40, textAlign: "center" }}
    >
      <div style={{ margin: "0 auto", width: 120 }}>
        <BookPreviewStage book={book} />
      </div>
      <h2 style={{ fontSize: 28, letterSpacing: "-0.015em", marginTop: 24 }}>{book.title}</h2>
      <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 6 }}>
        {book.author || "Автор не указан"}
        {book.chapterCount ? ` · ${book.chapterCount} ${decl(book.chapterCount, ["глава", "главы", "глав"])}` : ""}
      </div>
      <p
        className="soft"
        style={{
          fontSize: 15,
          lineHeight: 1.6,
          margin: "20px auto 0",
          maxWidth: 460,
        }}
      >
        Спросите о сюжете, героях, мотивах или стиле. Ремарка ответит с цитатой и точной главой.
      </p>
    </motion.div>
  );
}

function UserMessage({ content, createdAt }: { content: string; createdAt: string }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div className="mono" style={{ color: "var(--ink-faint)", marginBottom: 6 }}>Вы</div>
      <div
        style={{
          background: "var(--ink)",
          borderRadius: "var(--r-lg)",
          borderTopRightRadius: 4,
          color: "var(--paper)",
          display: "inline-block",
          fontSize: 15,
          lineHeight: 1.5,
          maxWidth: "85%",
          padding: "14px 18px",
          textAlign: "left",
        }}
      >
        <ChatMessageMarkdown content={content} className="text-primary-foreground" />
        <span
          style={{
            display: "block",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            marginTop: 8,
            opacity: 0.55,
          }}
        >
          {formatTime(createdAt)}
        </span>
      </div>
    </div>
  );
}

function AssistantMessage({ message, onCite }: { message: UiMessage; onCite: (cite: ActiveCite) => void }) {
  const evidence = Array.isArray(message.evidence) ? message.evidence : [];
  const usedSources = Array.isArray(message.usedSources) ? message.usedSources : [];

  // Build distinct citation badges from evidence (preferred) — fallback to citations
  const citeBadges: ActiveCite[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    const key = `${item.kind}:${item.label}:${item.chapterOrderIndex ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citeBadges.push(evidenceToActiveCite(item));
    if (citeBadges.length >= 6) break;
  }

  if (citeBadges.length === 0 && Array.isArray(message.citations)) {
    for (const item of message.citations) {
      const key = `chunk:${item.chunkId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citeBadges.push({
        label: `Глава ${item.chapterOrderIndex}`,
        chapterOrderIndex: item.chapterOrderIndex,
        snippet: item.text || "",
        kind: "chunk",
      });
      if (citeBadges.length >= 6) break;
    }
  }

  // Tool / search activity row — derive from evidence kind counts
  const toolCounts = new Map<string, number>();
  for (const item of evidence) {
    toolCounts.set(item.kind, (toolCounts.get(item.kind) ?? 0) + 1);
  }
  const toolEntries = Array.from(toolCounts.entries()).slice(0, 4);

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "36px 1fr" }}>
      <div
        style={{
          alignItems: "center",
          background: "var(--mark-soft)",
          borderRadius: "50%",
          color: "var(--mark)",
          display: "flex",
          height: 36,
          justifyContent: "center",
          width: 36,
        }}
      >
        <Sparkles size={16} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>Ремарка</div>

        {toolEntries.length > 0 ? (
          <div
            style={{
              alignItems: "center",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 12,
            }}
          >
            {toolEntries.map(([kind, count]) => (
              <span
                key={kind}
                className="mono"
                style={{
                  alignItems: "center",
                  background: "var(--paper-2)",
                  border: "1px solid var(--rule)",
                  borderRadius: 999,
                  color: "var(--ink-muted)",
                  display: "inline-flex",
                  fontSize: 10,
                  gap: 6,
                  padding: "3px 9px",
                }}
              >
                <Search size={10} /> {evidenceKindLabel(kind)} · {count}
              </span>
            ))}
            {usedSources.length > 0 ? (
              <span
                className="mono"
                style={{
                  color: "var(--ink-faint)",
                  fontSize: 10,
                }}
              >
                {usedSources.length} {decl(usedSources.length, ["источник", "источника", "источников"])}
              </span>
            ) : null}
          </div>
        ) : null}

        <div
          style={{
            color: "var(--ink)",
            fontFamily: "var(--font-serif)",
            fontSize: 17,
            lineHeight: 1.6,
          }}
        >
          <ChatMessageMarkdown
            content={message.content}
            inlineCitations={message.inlineCitations}
            className="text-foreground"
          />
        </div>

        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 12,
          }}
        >
          <ChatModePill mode={message.mode} confidence={message.confidence} />
          <span className="mono" style={{ color: "var(--ink-faint)", fontSize: 10 }}>
            {formatTime(message.createdAt)}
          </span>
        </div>

        {citeBadges.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
            {citeBadges.map((cite, index) => (
              <button
                key={`${cite.kind}-${cite.label}-${index}`}
                className="badge"
                onClick={() => onCite(cite)}
                style={{ cursor: "pointer" }}
                title={cite.snippet || cite.label}
              >
                <Quote size={12} />
                {cite.chapterOrderIndex !== null ? `Глава ${cite.chapterOrderIndex} · ` : ""}
                {evidenceKindLabel(cite.kind)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActiveCitePanel({ cite, onClose }: { cite: ActiveCite; onClose: () => void }) {
  return (
    <div style={{ padding: 28 }}>
      <div className="mono" style={{ color: "var(--mark)", marginBottom: 10 }}>Источник</div>
      <div style={{ fontFamily: "var(--font-serif)", fontSize: 18 }}>
        {evidenceKindLabel(cite.kind)}
        {cite.chapterOrderIndex !== null ? ` · Глава ${cite.chapterOrderIndex}` : ""}
      </div>
      <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>{cite.label}</div>
      {cite.snippet ? (
        <div
          style={{
            background: "var(--cream)",
            border: "1px solid var(--rule)",
            borderRadius: "var(--r)",
            fontFamily: "var(--font-serif)",
            fontSize: 15,
            lineHeight: 1.65,
            marginTop: 20,
            padding: 18,
          }}
        >
          <span
            style={{
              color: "var(--mark)",
              fontSize: 28,
              lineHeight: 0,
              marginRight: 4,
              position: "relative",
              top: 10,
            }}
          >
            «
          </span>
          {cite.snippet}
          <span
            style={{
              color: "var(--mark)",
              fontSize: 28,
              lineHeight: 0,
              marginLeft: 2,
              position: "relative",
              top: 10,
            }}
          >
            »
          </span>
        </div>
      ) : (
        <p className="soft" style={{ fontSize: 13, lineHeight: 1.55, marginTop: 16 }}>
          Развернутого фрагмента нет — это упоминание из карточки сущности.
        </p>
      )}
      <button className="btn btn-plain btn-sm btn-block" onClick={onClose} style={{ marginTop: 16 }}>
        Скрыть
      </button>
    </div>
  );
}

function ContextPanel({
  book,
  buildBookPath,
  bookId,
}: {
  book: BookCoreDTO | null;
  buildBookPath: (path: string) => string;
  bookId: string;
}) {
  return (
    <div style={{ padding: 28 }}>
      <div className="mono" style={{ color: "var(--mark)", marginBottom: 14 }}>Контекст разговора</div>
      {book ? (
        <>
          <div style={{ margin: "0 auto", width: 140 }}>
            <BookPreviewStage book={book} />
          </div>
          <div style={{ marginTop: 16, textAlign: "center" }}>
            <div style={{ fontFamily: "var(--font-serif)", fontSize: 17, lineHeight: 1.25 }}>{book.title}</div>
            <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 6 }}>{book.author || "Автор не указан"}</div>
          </div>
          <div className="hr" style={{ margin: "20px 0" }} />
          <Link
            className="btn btn-ghost btn-sm btn-block"
            href={buildBookPath(`/book/${bookId}`)}
            style={{ justifyContent: "center" }}
          >
            <Pencil size={14} /> Открыть разбор
          </Link>
          <div className="mono" style={{ color: "var(--ink-faint)", marginBottom: 10, marginTop: 24 }}>Подсказка</div>
          <p className="soft" style={{ fontSize: 13, lineHeight: 1.55 }}>
            Нажмите на бейдж под ответом — здесь откроется фрагмент-источник с цитатой.
          </p>
          {book.canManage ? (
            <div style={{ marginTop: 18 }}>
              <BookSettings book={book} />
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted">Загружаем книгу...</p>
      )}
    </div>
  );
}

function Typing({
  streamStatus,
  streamReasoning,
}: {
  streamStatus: string | null;
  streamReasoning: string | null;
}) {
  const heading = streamStatus || "Ремарка ищет в тексте…";
  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "36px 1fr" }}>
      <div
        style={{
          alignItems: "center",
          background: "var(--mark-soft)",
          borderRadius: "50%",
          color: "var(--mark)",
          display: "flex",
          height: 36,
          justifyContent: "center",
          width: 36,
        }}
      >
        <Sparkles size={16} />
      </div>
      <div style={{ paddingTop: 6 }}>
        <div className="row-sm mono" style={{ color: "var(--mark)", marginBottom: 8 }}>
          <MessageSquare size={12} /> {heading}
        </div>
        <div style={{ display: "inline-flex", gap: 4 }}>
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              style={{
                animation: `bc-dot 1.2s ${index * 0.15}s infinite ease-in-out`,
                background: "var(--mark)",
                borderRadius: "50%",
                display: "inline-block",
                height: 6,
                width: 6,
              }}
            />
          ))}
        </div>
        {streamReasoning ? (
          <div
            className="row-sm"
            style={{
              alignItems: "flex-start",
              color: "var(--ink-muted)",
              fontSize: 12,
              lineHeight: 1.5,
              marginTop: 10,
              maxWidth: 560,
            }}
          >
            <Brain size={12} style={{ flexShrink: 0, marginTop: 3 }} />
            <span>Мысли модели: {streamReasoning}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
