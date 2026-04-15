"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Bot, MessageSquare, Plus, Send, Trash2, User } from "lucide-react";
import { ChatModePill } from "./BookChatReadiness";
import { BookSettings } from "./BookSettings";
import { ChatMessageMarkdown } from "./ChatMessageMarkdown";
import {
  createBookChatSession,
  deleteBookChatSession,
  getBook,
  getBookChatMessages,
  listBookChatSessions,
  streamBookChatMessage,
} from "@/lib/booksClient";
import type { BookChatMessageDTO, BookChatSessionDTO, BookCoreDTO } from "@/lib/books";
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

function makeGreeting(bookTitle: string): UiMessage {
  return {
    id: `local:greeting:${Date.now()}`,
    role: "assistant",
    content: `Здравствуйте. Я помогу разобраться в книге «${bookTitle}»: в мотивах персонажей, ключевых сценах, скрытых деталях и общем смысле.`,
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
}

export function BookChat() {
  const params = useParams<{ bookId: string; sessionId?: string }>();
  const bookId = String(params.bookId || "");
  const routeSessionId = String(params.sessionId || "").trim() || null;
  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pendingHandledRef = useRef(false);

  const [book, setBook] = useState<BookCoreDTO | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<BookChatSessionDTO[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);

  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { readiness, loading: readinessLoading, error: readinessError } = useBookChatReadiness(bookId);

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) || null,
    [sessions, currentSessionId]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

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
    setMessages(nextMessages.length > 0 ? nextMessages : [makeGreeting(book?.title || "Книга")]);
  };

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
        setBookError(error instanceof Error ? error.message : "Не удалось загрузить чат");
      }
    }

    void loadBookData();
    return () => {
      active = false;
    };
  }, [bookId]);

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
    if (!bookId || !readiness?.canChat || sessions.length === 0) return;
    if (currentSessionId && currentSessionId !== routeSessionId) {
      router.replace(`/book/${bookId}/chat/${currentSessionId}`);
      return;
    }
    if (!currentSessionId && routeSessionId) {
      router.replace(`/book/${bookId}/chat`);
    }
  }, [bookId, currentSessionId, readiness?.canChat, routeSessionId, router]);

  useEffect(() => {
    if (!currentSessionId || !readiness?.canChat) return;
    const activeSessionId: string = currentSessionId;
    let active = true;

    async function loadCurrentMessages() {
      try {
        const nextMessages = await getBookChatMessages(bookId, activeSessionId);
        if (!active) return;
        setMessages(nextMessages.length > 0 ? nextMessages : [makeGreeting(book?.title || "Книга")]);
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
  }, [bookId, currentSessionId, book?.title, readiness?.canChat]);

  const ensureActiveSession = async (): Promise<string> => {
    if (!readiness?.canChat) {
      throw new Error("Чат еще не готов");
    }
    if (currentSessionId) return currentSessionId;
    const created = await createBookChatSession(bookId, {
      title: "Новый чат",
    });
    await refreshSessions(created.id);
    router.replace(`/book/${bookId}/chat/${created.id}`);
    return created.id;
  };

  const createSession = async () => {
    if (!bookId || isLoading || !readiness?.canChat) return;
    const created = await createBookChatSession(bookId, {
      title: "Новый чат",
    });
    await refreshSessions(created.id);
    setMessages([makeGreeting(book?.title || "Книга")]);
    router.push(`/book/${bookId}/chat/${created.id}`);
  };

  const removeSession = async (sessionId: string) => {
    if (!bookId || isLoading || !readiness?.canChat) return;
    await deleteBookChatSession(bookId, sessionId);
    const nextSessionId = await refreshSessions();
    if (nextSessionId) {
      router.replace(`/book/${bookId}/chat/${nextSessionId}`);
      return;
    }
    router.replace(`/book/${bookId}/chat`);
  };

  const sendMessage = async (
    questionRaw: string,
    options?: { forcedSessionId?: string; entryContext?: "overview" | "section" | "full_chat" }
  ) => {
    if (!bookId || !readiness?.canChat) return;
    const question = String(questionRaw || "").trim();
    if (!question || isLoading) return;

    setInputValue("");
    setIsLoading(true);

    try {
      const sessionId = options?.forcedSessionId || (await ensureActiveSession());
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

      setMessages((current) => [
        ...current.filter((message) => !message.pending),
        optimisticUserMessage,
        {
          id: assistantDraftId,
          role: "assistant",
          content: "",
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
      ]);

      await streamBookChatMessage({
        bookId,
        sessionId,
        input: {
          message: question,
          entryContext: options?.entryContext || "full_chat",
        },
        onEvent: (event) => {
          if (event.type === "token") {
            const token = String(event.text || "");
            if (!token) return;
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantDraftId
                  ? {
                      ...message,
                      content: `${message.content}${token}`,
                    }
                  : message
              )
            );
            return;
          }

          if (event.type === "final" && event.final) {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantDraftId
                  ? {
                      id: event.final?.messageId || message.id,
                      role: "assistant",
                      content: String(event.final?.answer || ""),
                      rawAnswer: event.final?.rawAnswer || null,
                      evidence: Array.isArray(event.final?.evidence) ? event.final.evidence : [],
                      usedSources: Array.isArray(event.final?.usedSources) ? event.final.usedSources : [],
                      confidence: event.final?.confidence || null,
                      mode: event.final?.mode || null,
                      citations: Array.isArray(event.final?.citations) ? event.final.citations : [],
                      inlineCitations: Array.isArray(event.final?.inlineCitations) ? event.final.inlineCitations : [],
                      answerItems: Array.isArray(event.final?.answerItems) ? event.final.answerItems : [],
                      referenceResolution: event.final?.referenceResolution || null,
                      createdAt: new Date().toISOString(),
                    }
                  : message
              )
            );
          }
        },
      });

      await Promise.all([refreshSessions(sessionId), loadMessages(sessionId)]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Не удалось получить ответ";
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
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!book || !currentSessionId || pendingHandledRef.current) return;

    try {
      const pending = sessionStorage.getItem("book-chat-pending-message");
      if (!pending) {
        pendingHandledRef.current = true;
        return;
      }

      const pendingSessionId = String(sessionStorage.getItem("book-chat-pending-session-id") || "").trim();
      const pendingEntryContext = String(sessionStorage.getItem("book-chat-pending-entry-context") || "").trim();
      sessionStorage.removeItem("book-chat-pending-message");
      sessionStorage.removeItem("book-chat-pending-session-id");
      sessionStorage.removeItem("book-chat-pending-entry-context");

      pendingHandledRef.current = true;
      const entryContext = pendingEntryContext === "overview" ? "overview" : "full_chat";

      if (pendingSessionId && pendingSessionId !== currentSessionId) {
        setCurrentSessionId(pendingSessionId);
        void sendMessage(pending, { forcedSessionId: pendingSessionId, entryContext });
      } else {
        void sendMessage(pending, { forcedSessionId: currentSessionId, entryContext });
      }
    } catch {
      pendingHandledRef.current = true;
    }
  }, [book, currentSessionId]);

  if (bookError) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-4xl mx-auto px-6 py-8 lg:py-12">
          <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {bookError}
          </div>
        </div>
      </div>
    );
  }

  if (!readinessLoading && readinessError && !readiness) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-4xl mx-auto px-6 py-8 lg:py-12">
          <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {readinessError}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen h-[100dvh] overflow-hidden bg-background">
      <div className="mx-auto flex h-full min-h-0 max-w-5xl flex-col px-6 py-6 lg:py-8">
        <div className="mb-6 shrink-0 lg:mb-8">
          <Link
            href={`/book/${bookId}`}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            Назад к обзору
          </Link>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl lg:text-3xl text-foreground mb-1">{book?.title || "Чат"}</h1>
              <p className="text-muted-foreground">{book?.author || ""}</p>
              <p className="text-sm text-muted-foreground mt-2">
                Экспертный разбор персонажей, сцен, конфликтов и смысла книги.
              </p>
            </div>
            {book ? (
              <BookSettings
                book={book}
                onBookUpdated={(updatedBook) => {
                  setBook(updatedBook);
                }}
              />
            ) : null}
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex min-h-0 flex-1 flex-col gap-4"
        >
          {readinessLoading && !readiness ? (
            <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
              Проверяем готовность чата...
            </div>
          ) : null}
          {!readinessLoading && readiness && !readiness.canChat ? (
            <div className="rounded-2xl border border-border bg-card p-6 lg:p-8">
              <div className="max-w-2xl">
                <h2 className="text-lg text-foreground">Чат еще подготавливается</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Статус анализа перенесен на главную страницу книги. Как только fast lane будет готов, чат откроется
                  автоматически.
                </p>
                <Link
                  href={`/book/${bookId}`}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/30 hover:bg-primary/5"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Открыть главную страницу
                </Link>
              </div>
            </div>
          ) : null}

          {readinessLoading && !readiness ? null : readiness && !readiness.canChat ? null : (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              <div className="shrink-0 rounded-xl border border-border bg-card p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 overflow-x-auto">
                    {sessions.map((session) => (
                      <button
                        key={session.id}
                        onClick={() => {
                          setCurrentSessionId(session.id);
                          router.push(`/book/${bookId}/chat/${session.id}`);
                        }}
                        className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                          currentSessionId === session.id
                            ? "bg-primary/10 border-primary/30 text-primary"
                            : "bg-background border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {session.title}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        void createSession();
                      }}
                      className="p-2 rounded-lg border border-border hover:border-primary/30"
                      title="Новый чат"
                      disabled={isLoading}
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                    {currentSession ? (
                      <button
                        onClick={() => {
                          void removeSession(currentSession.id);
                        }}
                        className="p-2 rounded-lg border border-border hover:border-destructive/40"
                        title="Удалить чат"
                        disabled={isLoading}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-2 pb-6">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex gap-4 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      {message.role === "assistant" ? (
                        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <Bot className="w-5 h-5 text-primary" />
                        </div>
                      ) : null}
                      <div
                        className={`max-w-[78%] p-5 rounded-2xl ${
                          message.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-card border border-border text-foreground"
                        }`}
                      >
                        <ChatMessageMarkdown
                          content={message.content || (message.pending ? "..." : "")}
                          inlineCitations={message.inlineCitations}
                          className={message.role === "user" ? "text-primary-foreground" : "text-foreground"}
                        />

                        {message.role === "assistant" ? (
                          <ChatModePill mode={message.mode} confidence={message.confidence} />
                        ) : null}
                        <span className="text-xs opacity-60 mt-3 block">{formatTime(message.createdAt)}</span>
                      </div>
                      {message.role === "user" ? (
                        <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                          <User className="w-5 h-5 text-primary" />
                        </div>
                      ) : null}
                    </div>
                  ))}

                  {isLoading ? (
                    <div className="flex gap-2 items-center text-xs text-muted-foreground">
                      <MessageSquare className="w-4 h-4" />
                      Ответ формируется...
                    </div>
                  ) : null}

                  <div ref={messagesEndRef} />
                </div>
              </div>

              <div className="shrink-0 border-t border-border bg-background/95 pt-4 pb-[calc(env(safe-area-inset-bottom)+0.25rem)] backdrop-blur supports-[backdrop-filter]:bg-background/80">
                <div className="flex gap-3">
                  <textarea
                    value={inputValue}
                    onChange={(event) => setInputValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage(inputValue, { entryContext: "full_chat" });
                      }
                    }}
                    placeholder="Спросите про героя, сцену, конфликт или общий смысл книги..."
                    className="flex-1 resize-none rounded-2xl border border-border bg-card px-5 py-4 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                    rows={3}
                    disabled={isLoading || !readiness?.canChat}
                  />
                  <button
                    onClick={() => {
                      void sendMessage(inputValue, { entryContext: "full_chat" });
                    }}
                    disabled={!inputValue.trim() || isLoading || !readiness?.canChat}
                    className="self-end rounded-2xl bg-primary px-8 py-4 text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
