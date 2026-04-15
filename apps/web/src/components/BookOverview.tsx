"use client";

import { motion } from "motion/react";
import { MessageSquare, Wrench } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookNavigation } from "./BookNavigation";
import { ChatReadinessGate } from "./BookChatReadiness";
import { BookSettings } from "./BookSettings";
import { ChatPreview } from "./ChatPreview";
import { getBook } from "@/lib/booksClient";
import { displayAuthor, type BookCoreDTO } from "@/lib/books";
import { useBookChatReadiness } from "@/lib/useBookChatReadiness";

export function BookOverview() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");

  const [book, setBook] = useState<BookCoreDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { readiness, loading: readinessLoading, error: readinessError } = useBookChatReadiness(bookId);

  useEffect(() => {
    if (!bookId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);

      const bookResult = await Promise.allSettled([getBook(bookId)]);

      if (!active) return;

      if (bookResult[0]?.status === "fulfilled") {
        setBook(bookResult[0].value);
      } else {
        setBook(null);
        setError(bookResult[0]?.reason instanceof Error ? bookResult[0].reason.message : "Не удалось загрузить книгу");
      }

      setLoading(false);
    }

    void load();
    return () => {
      active = false;
    };
  }, [bookId]);

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12">
        {loading ? <div className="pt-12 text-muted-foreground">Загрузка книги...</div> : null}

        {error && !loading ? (
          <div className="pt-12 p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {book && !loading ? (
          <>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-8 lg:mb-12 pt-8 lg:pt-12"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-3xl lg:text-4xl text-foreground mb-2">{book.title}</h1>
                  <p className="text-lg lg:text-xl text-muted-foreground">{displayAuthor(book.author)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <BookSettings
                    book={book}
                    onBookUpdated={(updatedBook) => {
                      setBook(updatedBook);
                    }}
                  />
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mb-12"
            >
              <div className="mb-4">
                <h2 className="text-xl text-foreground">Статус анализа</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Здесь видно, какие этапы уже готовы для чата и что еще достраивается в фоне.
                </p>
              </div>

              {readinessError && !readiness ? (
                <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                  {readinessError}
                </div>
              ) : null}

              {readinessLoading && !readiness ? (
                <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
                  Загружаем статус анализа...
                </div>
              ) : null}

              {readiness ? <ChatReadinessGate readiness={readiness} /> : null}
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12 }}
              className="mb-12"
            >
              <ChatPreview
                bookId={bookId}
                bookTitle={book.title}
                readiness={readiness}
                readinessLoading={readinessLoading}
                readinessError={readinessError}
              />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="rounded-3xl border border-border bg-card/90 p-6 lg:p-8"
            >
              <div className="flex items-start gap-4">
                <div className="rounded-2xl bg-primary/10 p-3">
                  <Wrench className="h-6 w-6 text-primary" />
                </div>
                <div className="max-w-3xl">
                  <h2 className="text-2xl text-foreground">Аналитические витрины отключены</h2>
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">
                    Старые отдельные разделы анализа, отчеты и специализированные карточки больше не развиваются как
                    самостоятельный интерфейс. Основной сценарий работы по книге теперь идет через чат.
                  </p>
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">
                    Если нужен разбор персонажа, сцены, темы, цитаты или вопрос по структуре книги, лучше задавать это
                    прямо в чате. Текущий pipeline оптимизирован именно под этот режим.
                  </p>
                  <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground">
                    <MessageSquare className="h-4 w-4 text-primary" />
                    Основной режим: chat-first
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        ) : null}
      </div>
    </div>
  );
}
