"use client";

import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Bot, Brain, MessageSquare, Plus, Send, Trash2, User } from "lucide-react";
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
  type BookChatMessageDTO,
  type BookChatSessionDTO,
  type BookChatStreamFinalEventDTO,
  type BookCoreDTO,
} from "@/lib/books";
import { useBookChatReadiness } from "@/lib/useBookChatReadiness";

interface UiMessage extends BookChatMessageDTO {
  pending?: boolean;
}

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

const MAX_STREAM_REASONING_CHARS = 480;
const RUSSIAN_REASONING_PLACEHOLDER = "Анализирую запрос, сверяю факты по книге и подбираю релевантные фрагменты.";

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

export function BookChat() {
  const params = useParams<{ bookId: string; sessionId?: string }>();
  const searchParams = useSearchParams();
  const bookId = String(params.bookId || "");
  const routeSessionId = String(params.sessionId || "").trim() || null;
  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);
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

  if (bookError) {
    return (
      <div className="container" style={{ paddingBottom: 72, paddingTop: 40 }}>
        <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", padding: 18 }}>
          {bookError}
        </div>
      </div>
    );
  }

  return (
    <div className="screen-fade" style={{ borderTop: "1px solid var(--rule)", display: "grid", gridTemplateColumns: "288px minmax(0,1fr) 320px", height: "calc(100svh - 64px)" }}>
      <aside style={{ background: "var(--paper-2)", borderRight: "1px solid var(--rule)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "18px 18px 12px" }}>
          <button className="btn btn-mark btn-block" onClick={() => void createSession()} disabled={isLoading || !readiness?.canChat}>
            <Plus size={16} /> Новый чат
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 8px 18px" }}>
          <div className="mono" style={{ color: "var(--ink-faint)", padding: "8px 12px 6px" }}>Чаты по книге</div>
          {readinessLoading && !readiness ? <div className="muted" style={{ fontSize: 13, padding: 12 }}>Проверяем готовность чата...</div> : null}
          {readinessUnavailable ? <div className="muted" style={{ fontSize: 13, lineHeight: 1.55, padding: 12 }}>Не удалось проверить готовность чата.</div> : null}
          {!readinessLoading && readiness && !readiness.canChat ? (
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.55, padding: 12 }}>
              Список чатов появится, когда книга станет доступна для диалога.
            </div>
          ) : null}
          {readiness?.canChat && sessions.map((session) => {
            const isActive = activeSessionId === session.id;
            return (
              <div key={session.id} style={{ alignItems: "flex-start", background: isActive ? "var(--cream)" : "transparent", borderRadius: "var(--r)", display: "flex", gap: 6, padding: "9px 10px" }}>
                <button
                  onClick={() => {
                    if (session.id !== activeSessionId) router.push(buildBookPath(`/book/${bookId}/chat/${session.id}`));
                  }}
                  style={{ flex: 1, minWidth: 0, textAlign: "left" }}
                >
                  <div style={{ color: isActive ? "var(--ink)" : "var(--ink-soft)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.title}</div>
                  <div className="mono" style={{ color: "var(--ink-faint)", fontSize: 9, marginTop: 3 }}>{formatSessionTime(session.lastMessageAt, session.updatedAt)}</div>
                </button>
                <button className="btn-plain" disabled={isLoading || sessions.length <= 1} onClick={() => void removeSession(session.id)} title="Удалить чат" style={{ opacity: sessions.length <= 1 ? 0.3 : 1, padding: 4 }}>
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <ChatSidebarLegal />
      </aside>

      <main style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ alignItems: "center", borderBottom: "1px solid var(--rule)", display: "flex", gap: 16, justifyContent: "space-between", padding: "14px 32px" }}>
          <div className="row-sm" style={{ minWidth: 0 }}>
            {book ? (
              <>
                <div style={{ flexShrink: 0, width: 28 }}><BookPreviewStage book={book} size="sm" /></div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-serif)", fontSize: 15, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{book.title}</div>
                  <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>По книге · {book.author || "Автор не указан"}</div>
                </div>
              </>
            ) : (
              <div className="muted">Книга</div>
            )}
          </div>
          <div className="row-sm">
            <button className="btn btn-ghost btn-sm" title="UI-заглушка: общий чат по библиотеке пока не подключён">Вся библиотека</button>
            <Link className="btn btn-plain btn-sm" href={buildBookPath(`/book/${bookId}`)}>Разбор</Link>
          </div>
        </div>

        {readinessError && !readiness && !readinessLoading ? (
          <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", margin: 24, padding: 14 }}>{readinessError}</div>
        ) : null}

        {readinessLoading && !readiness ? <div className="muted" style={{ margin: "auto" }}>Проверяем готовность чата...</div> : null}
        {readinessUnavailable ? <div className="muted" style={{ margin: "auto" }}>Не удалось получить состояние чата. Попробуйте обновить страницу.</div> : null}
        {!readinessLoading && readiness && !readiness.canChat ? (
          <div style={{ margin: "auto", maxWidth: 720, padding: 24 }}><ChatReadinessGate readiness={readiness} compact={false} /></div>
        ) : null}

        {readiness?.canChat ? (
          <>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "32px 48px" }}>
              <div className="stack-xl" style={{ margin: "0 auto", maxWidth: 760 }}>
                {messages.map((message) => (
                  <div key={message.id} style={{ textAlign: message.role === "user" ? "right" : "left" }}>
                    <div className="mono" style={{ color: "var(--ink-faint)", marginBottom: 6 }}>{message.role === "user" ? "Вы" : "Ремарка"}</div>
                    <div
                      style={{
                        background: message.role === "user" ? "var(--ink)" : "transparent",
                        borderLeft: message.role === "assistant" ? "2px solid var(--mark)" : "none",
                        borderRadius: message.role === "user" ? "var(--r-lg)" : 0,
                        borderTopRightRadius: message.role === "user" ? 4 : 0,
                        color: message.role === "user" ? "var(--paper)" : "var(--ink)",
                        display: "inline-block",
                        fontFamily: message.role === "assistant" ? "var(--font-serif)" : "var(--font-sans)",
                        fontSize: 15,
                        lineHeight: 1.6,
                        maxWidth: "85%",
                        padding: message.role === "user" ? "14px 18px" : "0 0 0 18px",
                        textAlign: "left",
                      }}
                    >
                      <ChatMessageMarkdown content={message.content} inlineCitations={message.inlineCitations} className={message.role === "user" ? "text-primary-foreground" : "text-foreground"} />
                      {message.role === "assistant" ? <ChatModePill mode={message.mode} confidence={message.confidence} /> : null}
                      <span style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 10, marginTop: 10, opacity: 0.55 }}>{formatTime(message.createdAt)}</span>
                    </div>
                  </div>
                ))}

                {isLoading && (streamStatus || streamReasoning) ? (
                  <div className="card muted" style={{ fontSize: 12, padding: 14 }}>
                    {streamStatus ? <div className="row-sm"><MessageSquare size={14} /> {streamStatus}</div> : null}
                    {streamReasoning ? <div className="row-sm" style={{ alignItems: "flex-start", marginTop: 8 }}><Brain size={14} /> <span>Мысли модели: {streamReasoning}</span></div> : null}
                  </div>
                ) : null}
                <div ref={messagesEndRef} />
              </div>
            </div>

            <div style={{ padding: "20px 48px 28px" }}>
              <div style={{ margin: "0 auto", maxWidth: 760 }}>
                <div style={{ background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-sm)", padding: "14px 18px" }}>
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
                    placeholder={book ? `Спросите о «${book.title}»...` : "Спросите о книге..."}
                    disabled={isLoading || !readiness?.canChat}
                    style={{ background: "transparent", border: "none", boxShadow: "none", padding: 0 }}
                  />
                  <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
                    <div className="mono" style={{ color: "var(--ink-faint)" }}>Enter отправить · Shift+Enter перенос</div>
                    <button className="btn btn-mark btn-sm" onClick={() => void sendMessage(inputValue)} disabled={!inputValue.trim() || isLoading || !readiness?.canChat} style={{ opacity: inputValue.trim() ? 1 : 0.5 }}>
                      <Send size={16} /> Отправить
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </main>

      <aside style={{ background: "var(--paper-2)", borderLeft: "1px solid var(--rule)", overflow: "auto", padding: 28 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 10 }}>Контекст</div>
        {book ? (
          <>
            <div style={{ marginBottom: 18, width: 120 }}><BookPreviewStage book={book} /></div>
            <h2 style={{ fontSize: 24, letterSpacing: 0 }}>{book.title}</h2>
            <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>{book.author || "Автор не указан"}</p>
            <p className="soft" style={{ fontSize: 13, lineHeight: 1.65, marginTop: 18 }}>
              Правая панель в макете предназначена для источников и цитат. Текущий backend отдаёт цитаты внутри ответа; отдельный source drawer пока перенесён как контекстная зона.
            </p>
            {book.canManage ? <div style={{ marginTop: 18 }}><BookSettings book={book} /></div> : null}
          </>
        ) : (
          <p className="muted">Загружаем книгу...</p>
        )}
      </aside>

      <style jsx>{`
        @media (max-width: 1100px) {
          div.screen-fade {
            grid-template-columns: 240px minmax(0, 1fr) !important;
          }
          aside:last-of-type {
            display: none !important;
          }
        }
        @media (max-width: 760px) {
          div.screen-fade {
            display: flex !important;
            flex-direction: column;
            height: auto !important;
            min-height: calc(100svh - 64px);
          }
          div.screen-fade > aside:first-of-type {
            max-height: 260px;
          }
        }
      `}</style>
    </div>
  );
}
