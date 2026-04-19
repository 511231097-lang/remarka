"use client";

import { motion } from "motion/react";
import { BookOpen } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookSettings } from "./BookSettings";
import { ChatPreview } from "./ChatPreview";
import { getBook } from "@/lib/booksClient";
import { displayAuthor, type BookCoreDTO } from "@/lib/books";
import { useBookChatReadiness } from "@/lib/useBookChatReadiness";

const COVER_THEMES = [
  "from-blue-700 via-cyan-600 to-teal-500",
  "from-emerald-700 via-lime-600 to-yellow-500",
  "from-rose-700 via-pink-600 to-orange-500",
  "from-amber-800 via-orange-700 to-red-600",
  "from-slate-800 via-slate-700 to-zinc-600",
] as const;

function resolveCoverTheme(bookId: string): (typeof COVER_THEMES)[number] {
  let hash = 0;
  for (const char of String(bookId || "")) {
    hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  }
  return COVER_THEMES[hash % COVER_THEMES.length] || COVER_THEMES[0];
}

function BookHeroCover({ book }: { book: BookCoreDTO }) {
  const [hasImageError, setHasImageError] = useState(false);
  const canUseImage = Boolean(book.coverUrl) && !hasImageError;

  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden rounded-[28px] bg-[#120f0d] shadow-[0_22px_70px_rgba(0,0,0,0.28)]">
      {canUseImage ? (
        <img
          src={String(book.coverUrl)}
          alt={`Обложка: ${book.title}`}
          className="absolute inset-0 h-full w-full object-cover object-center"
          referrerPolicy="no-referrer"
          onError={() => setHasImageError(true)}
        />
      ) : (
        <div className={`absolute inset-0 bg-gradient-to-br ${resolveCoverTheme(book.id)}`} />
      )}

      <div className="absolute inset-0 bg-gradient-to-t from-black/78 via-black/18 to-transparent" />
      <div className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/35 px-3 py-1 text-xs text-white/85 backdrop-blur-sm">
        <BookOpen className="h-3.5 w-3.5" />
        <span>{book.chapterCount} глав</span>
      </div>
      <div className="absolute inset-x-0 bottom-0 px-5 pb-5 pt-16 text-white">
        <p className="line-clamp-2 text-xl leading-tight">{book.title}</p>
        <p className="mt-2 line-clamp-1 text-sm text-white/75">{displayAuthor(book.author)}</p>
      </div>
    </div>
  );
}

function resolveBookSummary(book: BookCoreDTO): string {
  const summary = String(book.summary || "").trim();
  if (summary) return summary;
  return "Краткое описание книги пока не добавлено. Для новых FB2 оно будет подхватываться из annotation, если она есть в файле.";
}

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
      <div className="mx-auto max-w-6xl px-6 pb-12">
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
              className="pt-8 lg:pt-12"
            >
              <div className="grid gap-8 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-10">
                <div className="max-w-[320px] lg:max-w-none">
                  <BookHeroCover book={book} />
                </div>

                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm uppercase tracking-[0.18em] text-muted-foreground/75">Книга</p>
                      <h1 className="mt-3 text-3xl leading-tight text-foreground lg:text-5xl">{book.title}</h1>
                      <p className="mt-3 text-lg text-muted-foreground lg:text-xl">{displayAuthor(book.author)}</p>
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

                  <p className="mt-6 max-w-3xl text-sm leading-7 text-foreground/78 lg:text-[15px]">
                    {resolveBookSummary(book)}
                  </p>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mt-10"
            >
              <ChatPreview
                bookId={bookId}
                bookTitle={book.title}
                readiness={readiness}
                readinessLoading={readinessLoading}
                readinessError={readinessError}
              />
            </motion.div>
          </>
        ) : null}
      </div>
    </div>
  );
}
