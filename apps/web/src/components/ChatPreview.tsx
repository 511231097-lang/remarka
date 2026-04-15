"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, Send, Sparkles } from "lucide-react";
import { createBookChatSession, listBookChatSessions } from "@/lib/booksClient";
import type { BookChatReadinessDTO, BookChatSessionDTO } from "@/lib/books";

interface ChatPreviewProps {
  bookId: string;
  bookTitle: string;
  readiness: BookChatReadinessDTO | null;
  readinessLoading: boolean;
  readinessError: string | null;
}

export function ChatPreview({ bookId, bookTitle, readiness, readinessLoading, readinessError }: ChatPreviewProps) {
  const [inputValue, setInputValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessions, setSessions] = useState<BookChatSessionDTO[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!bookId || !readiness?.canChat) {
      setSessions([]);
      setSessionsLoading(false);
      setSessionsError(null);
      return;
    }

    let active = true;

    async function loadSessions() {
      try {
        setSessionsLoading(true);
        setSessionsError(null);
        const nextSessions = await listBookChatSessions(bookId);
        if (!active) return;
        setSessions(nextSessions);
      } catch (error) {
        if (!active) return;
        setSessions([]);
        setSessionsError(error instanceof Error ? error.message : "Не удалось загрузить прошлые чаты");
      } finally {
        if (active) {
          setSessionsLoading(false);
        }
      }
    }

    void loadSessions();
    return () => {
      active = false;
    };
  }, [bookId, readiness?.canChat]);

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

  const handleSend = async () => {
    const value = inputValue.trim();
    if (!value || isSubmitting || !readiness?.canChat) return;

    setIsSubmitting(true);
    try {
      const session = await createBookChatSession(bookId, {
        title: value.slice(0, 80) || "Новый чат",
      });

      try {
        sessionStorage.setItem("book-chat-pending-message", value);
        sessionStorage.setItem("book-chat-pending-session-id", session.id);
        sessionStorage.setItem("book-chat-pending-entry-context", "overview");
      } catch {
        // ignore storage errors in private modes
      }

      router.push(`/book/${bookId}/chat/${session.id}`);
    } catch {
      try {
        sessionStorage.setItem("book-chat-pending-message", value);
        sessionStorage.removeItem("book-chat-pending-session-id");
        sessionStorage.setItem("book-chat-pending-entry-context", "overview");
      } catch {
        // ignore storage errors in private modes
      }
      router.push(`/book/${bookId}/chat`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const suggestedQuestions = [
    "Объясни главную идею произведения простыми словами",
    "Какие ключевые конфликты движут сюжетом?",
    "Какие эпизоды лучше всего доказывают авторскую позицию?",
  ];

  return (
    <div className="bg-gradient-to-br from-primary/5 to-primary/10 border border-primary/20 rounded-lg p-6 lg:p-8">
      <div className="flex items-start gap-4 mb-6">
        <div className="p-3 bg-primary/10 rounded-lg">
          <MessageSquare className="w-6 h-6 text-primary" />
        </div>
        <div className="flex-1">
          <h3 className="text-xl text-foreground mb-2 flex items-center gap-2">
            Спросите эксперта по книге
            <Sparkles className="w-4 h-4 text-primary" />
          </h3>
          <p className="text-sm text-muted-foreground">
            Задайте вопрос о «{bookTitle}» и получите разбор с опорой на текст книги
          </p>
        </div>
      </div>

      {readinessError && !readiness ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {readinessError}
        </div>
      ) : null}

      {readinessLoading && !readiness ? (
        <div className="rounded-xl border border-border bg-background/70 px-4 py-3 text-sm text-muted-foreground">
          Проверяем готовность чата...
        </div>
      ) : null}

      {readinessError && !readiness
        ? null
        : readinessLoading && !readiness
          ? null
          : !readinessLoading && readiness && !readiness.canChat
            ? (
        <div className="rounded-xl border border-border bg-background/70 px-4 py-3 text-sm text-muted-foreground">
          Чат откроется автоматически, как только fast lane будет готов. Подробный статус анализа показан выше.
        </div>
              )
            : (
        <>
          <div className="mb-4 flex gap-2">
            <textarea
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="Например: Что на самом деле движет героем в решающий момент?"
              className="flex-1 resize-none rounded-lg border border-border bg-background px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
              rows={2}
              disabled={isSubmitting}
            />
            <button
              onClick={() => {
                void handleSend();
              }}
              disabled={!inputValue.trim() || isSubmitting}
              className="self-end rounded-lg bg-primary px-6 py-3 text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Популярные вопросы:</p>
            <div className="flex flex-wrap gap-2">
              {suggestedQuestions.map((question) => (
                <button
                  key={question}
                  onClick={() => setInputValue(question)}
                  className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/30 hover:bg-primary/5"
                >
                  {question}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-border bg-background/70 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-foreground">Прошлые чаты</p>
                <p className="text-xs text-muted-foreground">Можно вернуться к любому разговору по этой книге.</p>
              </div>
              {sessions[0] ? (
                <Link
                  href={`/book/${bookId}/chat/${sessions[0].id}`}
                  className="text-xs text-primary hover:underline"
                >
                  Последний чат
                </Link>
              ) : null}
            </div>

            {sessionsLoading ? (
              <div className="text-sm text-muted-foreground">Загружаем историю чатов...</div>
            ) : null}

            {sessionsError ? (
              <div className="text-sm text-destructive">{sessionsError}</div>
            ) : null}

            {!sessionsLoading && !sessionsError && sessions.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                История пока пустая. Первый разговор появится здесь автоматически.
              </div>
            ) : null}

            {!sessionsLoading && !sessionsError && sessions.length > 0 ? (
              <div className="space-y-2">
                {sessions.slice(0, 6).map((session) => (
                  <Link
                    key={session.id}
                    href={`/book/${bookId}/chat/${session.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:border-primary/30 hover:bg-primary/5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{session.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {session.lastMessageAt ? "Последнее сообщение" : "Создан"}:{" "}
                        {formatSessionTime(session.lastMessageAt, session.updatedAt)}
                      </p>
                    </div>
                    <MessageSquare className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
