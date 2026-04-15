"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Bot, Maximize2, MessageSquare, Plus, Send, Trash2, User } from "lucide-react";
import { ChatModePill, ChatReadinessGate } from "./BookChatReadiness";
import { ChatMessageMarkdown } from "./ChatMessageMarkdown";
import {
  createBookChatSession,
  deleteBookChatSession,
  getBookChatMessages,
  listBookChatSessions,
  streamBookChatMessage,
} from "@/lib/booksClient";
import type { BookChatMessageDTO, BookChatSessionDTO, LiterarySectionKeyDTO } from "@/lib/books";
import { useBookChatReadiness } from "@/lib/useBookChatReadiness";

interface ChatPanelProps {
  bookTitle?: string;
  sectionKey?: LiterarySectionKeyDTO;
}

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

function buildAssistantGreeting(bookTitle: string | null, sectionKey?: LiterarySectionKeyDTO): UiMessage {
  const focusText = sectionKey
    ? "Можем разбирать именно этот раздел: уточнять мотивы, спорные трактовки и сильные доказательства из текста."
    : "Могу помочь понять персонажей, конфликты, скрытые детали и общий смысл книги.";

  return {
    id: `msg:greeting:${Date.now()}`,
    role: "assistant",
    content: `Здравствуйте. Я ваш собеседник по книге${bookTitle ? ` «${bookTitle}»` : ""}. ${focusText}`,
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

function buildSectionPrompts(sectionKey?: LiterarySectionKeyDTO): string[] {
  if (sectionKey === "main_idea") {
    return [
      "Сформулируй главную идею этого раздела простыми словами",
      "Какие эпизоды лучше всего подтверждают эту идею?",
      "Что здесь видно прямо в тексте, а что уже интерпретация?",
    ];
  }

  if (sectionKey === "characters") {
    return [
      "Кто из персонажей сильнее всего меняется и почему?",
      "Что движет главным героем в ключевых сценах?",
      "Где лучше всего видно внутренний конфликт персонажа?",
    ];
  }

  if (sectionKey === "conflicts") {
    return [
      "Какой конфликт здесь главный и что его подпитывает?",
      "Какие сцены лучше всего показывают столкновение ценностей?",
      "Это больше внешний конфликт или внутренний?",
    ];
  }

  if (sectionKey === "hidden_details") {
    return [
      "Какие скрытые детали здесь важнее всего?",
      "Что можно заметить только при внимательном чтении?",
      "Какая деталь потом начинает работать по-новому?",
    ];
  }

  return [
    "Почему герой поступает именно так?",
    "Какие эпизоды лучше всего доказывают главную мысль?",
    "Что в этой книге кажется самым важным под поверхностью сюжета?",
  ];
}

function resolvePlaceholder(sectionKey?: LiterarySectionKeyDTO): string {
  if (sectionKey) {
    return "Спросите про этот раздел, спорный момент или скрытый смысл...";
  }
  return "Спросите про героя, сцену, конфликт или общий смысл книги...";
}

export function ChatPanel({ bookTitle, sectionKey }: ChatPanelProps) {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const [sessions, setSessions] = useState<BookChatSessionDTO[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const { readiness, loading: readinessLoading, error: readinessError } = useBookChatReadiness(bookId);

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) || null,
    [sessions, currentSessionId]
  );
  const suggestedPrompts = useMemo(() => buildSectionPrompts(sectionKey), [sectionKey]);
  const fullChatHref = currentSessionId ? `/book/${bookId}/chat/${currentSessionId}` : `/book/${bookId}/chat`;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const refreshSessions = async (preferredSessionId?: string | null) => {
    if (!bookId) return;
    const nextSessions = await listBookChatSessions(bookId);
    setSessions(nextSessions);

    const requested = String(preferredSessionId || "").trim();
    if (requested && nextSessions.some((session) => session.id === requested)) {
      setCurrentSessionId(requested);
      return;
    }

    if (currentSessionId && nextSessions.some((session) => session.id === currentSessionId)) {
      return;
    }

    setCurrentSessionId(nextSessions[0]?.id || null);
  };

  const loadMessages = async (sessionId: string) => {
    if (!bookId || !sessionId) return;
    const nextMessages = await getBookChatMessages(bookId, sessionId);
    setMessages(nextMessages.length > 0 ? nextMessages : [buildAssistantGreeting(bookTitle || null, sectionKey)]);
  };

  useEffect(() => {
    if (!bookId || !readiness?.canChat) {
      setSessions([]);
      setCurrentSessionId(null);
      return;
    }
    let active = true;

    async function loadInitial() {
      try {
        setErrorText(null);
        let nextSessions = await listBookChatSessions(bookId);

        if (nextSessions.length === 0) {
          const created = await createBookChatSession(bookId, {
            title: "Новый чат",
          });
          nextSessions = [created];
        }

        if (!active) return;
        setSessions(nextSessions);
        setCurrentSessionId(nextSessions[0]?.id || null);
      } catch (error) {
        if (!active) return;
        setErrorText(error instanceof Error ? error.message : "Не удалось загрузить чат");
      }
    }

    void loadInitial();
    return () => {
      active = false;
    };
  }, [bookId, readiness?.canChat]);

  useEffect(() => {
    if (!currentSessionId || !readiness?.canChat) return;
    const activeSessionId: string = currentSessionId;
    let active = true;

    async function loadCurrentMessages() {
      try {
        const nextMessages = await getBookChatMessages(bookId, activeSessionId);
        if (!active) return;
        setMessages(nextMessages.length > 0 ? nextMessages : [buildAssistantGreeting(bookTitle || null, sectionKey)]);
      } catch (error) {
        if (!active) return;
        setMessages([
          {
            id: `msg:error:${Date.now()}`,
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
  }, [bookId, currentSessionId, bookTitle, sectionKey, readiness?.canChat]);

  const ensureActiveSession = async (): Promise<string> => {
    if (!readiness?.canChat) {
      throw new Error("Чат еще не готов");
    }
    if (currentSessionId) return currentSessionId;
    const created = await createBookChatSession(bookId, {
      title: "Новый чат",
    });
    await refreshSessions(created.id);
    return created.id;
  };

  const createNewChat = async () => {
    if (!bookId || isLoading || !readiness?.canChat) return;
    const created = await createBookChatSession(bookId, {
      title: "Новый чат",
    });
    await refreshSessions(created.id);
    setMessages([buildAssistantGreeting(bookTitle || null, sectionKey)]);
    setInputValue("");
  };

  const removeChat = async (sessionId: string) => {
    if (!bookId || isLoading || !readiness?.canChat) return;
    await deleteBookChatSession(bookId, sessionId);
    await refreshSessions();
  };

  const handleSend = async (prefilledQuestion?: string) => {
    const question = String(prefilledQuestion ?? inputValue).trim();
    if (!question || !bookId || isLoading || !readiness?.canChat) return;

    setInputValue("");
    setIsLoading(true);

    try {
      const sessionId = await ensureActiveSession();
      const userMessage: UiMessage = {
        id: `msg:user:${Date.now()}`,
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
      const assistantDraftId = `msg:assistant:${Date.now() + 1}`;

      setMessages((current) => [
        ...current.filter((message) => !message.pending),
        userMessage,
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
          sectionKey,
          entryContext: "section",
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
      const message = error instanceof Error ? error.message : "Не удалось получить ответ. Попробуйте еще раз.";

      setMessages((current) => [
        ...current.filter((entry) => !entry.pending),
        {
          id: `msg:error:${Date.now() + 1}`,
          role: "assistant",
          content: `Ошибка: ${message}`,
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

  return (
    <div className="hidden xl:flex flex-col w-96 flex-shrink-0 border-l border-border bg-card">
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <MessageSquare className="w-4 h-4" />
            Эксперт по книге
          </h3>
          <div className="flex items-center gap-1">
            <Link
              href={fullChatHref}
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
              title="Открыть в полном режиме"
            >
              <Maximize2 className="w-4 h-4 text-muted-foreground" />
            </Link>
            <button
              onClick={() => {
                void createNewChat();
              }}
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
              title="Новый чат"
            >
              <Plus className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          {sectionKey ? "Чат учитывает текущий раздел и подбирает релевантные опоры из книги." : "Разбор персонажей, сцен, тем и скрытых смыслов книги."}
        </p>
        {readinessLoading && !readiness ? (
          <div className="text-xs text-muted-foreground">Проверяем готовность чата...</div>
        ) : null}
        {readiness ? <ChatReadinessGate readiness={readiness} compact /> : null}
        {readinessError && !readiness ? <div className="text-xs text-destructive">{readinessError}</div> : null}

        {readinessError && !readiness ? null : readinessLoading && !readiness ? null : readiness && !readiness.canChat ? null : (
        <div className="space-y-1 max-h-32 overflow-y-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors group ${
                currentSessionId === session.id
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-secondary text-muted-foreground"
              }`}
              onClick={() => setCurrentSessionId(session.id)}
            >
              <span className="text-xs flex-1 truncate">{session.title}</span>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  void removeChat(session.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/10 rounded transition-opacity"
              >
                <Trash2 className="w-3 h-3 text-destructive" />
              </button>
            </div>
          ))}
        </div>
        )}
      </div>

      {readinessError && !readiness ? null : readinessLoading && !readiness ? null : readiness && !readiness.canChat ? null : (
      <>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div key={message.id} className={`flex gap-2 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            {message.role === "assistant" ? (
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Bot className="w-3.5 h-3.5 text-primary" />
              </div>
            ) : null}

            <div
              className={`max-w-[85%] px-3 py-2 rounded-lg ${
                message.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background border border-border text-foreground"
              }`}
            >
              <ChatMessageMarkdown
                content={message.content || (message.pending ? "..." : "")}
                inlineCitations={message.inlineCitations}
                className={`text-sm ${message.role === "user" ? "text-primary-foreground" : "text-foreground"}`}
              />

              {message.role === "assistant" ? (
                <ChatModePill mode={message.mode} confidence={message.confidence} compact />
              ) : null}
              <p className="text-[10px] opacity-60 mt-2">{formatTime(message.createdAt)}</p>
            </div>

            {message.role === "user" ? (
              <div className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 mt-0.5">
                <User className="w-3.5 h-3.5 text-primary" />
              </div>
            ) : null}
          </div>
        ))}

        {isLoading ? (
          <div className="flex gap-2 items-center text-xs text-muted-foreground">
            <MessageSquare className="w-3 h-3" />
            Формирую ответ...
          </div>
        ) : null}

        {errorText ? <div className="text-xs text-destructive">{errorText}</div> : null}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 border-t border-border space-y-3">
        <div className="flex flex-wrap gap-2">
          {suggestedPrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => setInputValue(prompt)}
              className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-foreground transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              {prompt}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <textarea
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            placeholder={resolvePlaceholder(sectionKey)}
            className="flex-1 px-3 py-2 bg-background border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 text-foreground placeholder:text-muted-foreground"
            rows={2}
            disabled={isLoading || !currentSession || !readiness?.canChat}
          />
          <button
            onClick={() => {
              void handleSend();
            }}
            disabled={!inputValue.trim() || isLoading || !currentSession || !readiness?.canChat}
            className="px-3 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed self-end"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
