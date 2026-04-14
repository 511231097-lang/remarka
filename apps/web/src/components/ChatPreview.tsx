"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, Send, Sparkles } from "lucide-react";
import { ChatReadinessBanner, ChatReadinessGate } from "./BookChatReadiness";
import { createBookChatSession } from "@/lib/booksClient";
import { useBookChatReadiness } from "@/lib/useBookChatReadiness";

interface ChatPreviewProps {
  bookId: string;
  bookTitle: string;
}

export function ChatPreview({ bookId, bookTitle }: ChatPreviewProps) {
  const [inputValue, setInputValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();
  const { readiness, loading: readinessLoading, error: readinessError } = useBookChatReadiness(bookId);

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

      router.push(`/book/${bookId}/chat`);
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
      {readiness && !readiness.canChat ? <ChatReadinessGate readiness={readiness} /> : null}
      {readiness?.canChat ? <ChatReadinessBanner readiness={readiness} /> : null}

      {readinessError && !readiness
        ? null
        : readinessLoading && !readiness
          ? null
          : !readinessLoading && readiness && !readiness.canChat
            ? null
            : (
        <>
      <div className="flex gap-2 mb-4">
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
          className="flex-1 px-4 py-3 bg-background border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 text-foreground placeholder:text-muted-foreground"
          rows={2}
          disabled={isSubmitting}
        />
        <button
          onClick={() => {
            void handleSend();
          }}
          disabled={!inputValue.trim() || isSubmitting}
          className="px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed self-end"
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
              className="text-xs px-3 py-1.5 bg-background border border-border rounded-full hover:border-primary/30 hover:bg-primary/5 transition-colors text-foreground"
            >
              {question}
            </button>
          ))}
        </div>
      </div>
        </>
      )}
    </div>
  );
}
