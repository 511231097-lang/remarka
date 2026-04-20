"use client";

import { motion } from "motion/react";
import { BookOpen, Lightbulb, ListTree, Sparkles, Users } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookSettings } from "./BookSettings";
import { ChatPreview } from "./ChatPreview";
import { getBook, getBookShowcase } from "@/lib/booksClient";
import { displayAuthor, type BookCoreDTO, type BookShowcaseDTO } from "@/lib/books";
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

function resolveEventImportanceLabel(value: BookShowcaseDTO["keyEvents"][number]["importance"]): string {
  if (value === "critical") return "Критический";
  if (value === "high") return "Высокий";
  return "Средний";
}

function ShowcaseBlock({ showcase }: { showcase: BookShowcaseDTO }) {
  return (
    <section className="mt-10 rounded-2xl border border-border bg-card p-6 lg:p-8">
      <div className="mb-6 flex items-center gap-3">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-xl text-foreground lg:text-2xl">Витрина книги</h2>
          <p className="text-xs text-muted-foreground">
            Обновлено {new Date(showcase.updatedAt).toLocaleDateString("ru-RU")}
          </p>
        </div>
      </div>

      <div className="space-y-6">
        {showcase.summary.shortSummary ? (
          <div>
            <h3 className="mb-2 text-sm uppercase tracking-[0.16em] text-muted-foreground">Краткая сводка</h3>
            <p className="text-sm leading-7 text-foreground/85">{showcase.summary.shortSummary}</p>
          </div>
        ) : null}

        {showcase.summary.mainIdea ? (
          <div>
            <h3 className="mb-2 text-sm uppercase tracking-[0.16em] text-muted-foreground">Основная идея</h3>
            <p className="text-sm leading-7 text-foreground/85">{showcase.summary.mainIdea}</p>
          </div>
        ) : null}

        {showcase.themes.length > 0 ? (
          <div>
            <div className="mb-3 flex items-center gap-2 text-foreground">
              <Lightbulb className="h-4 w-4 text-primary" />
              <h3 className="text-base">Ключевые темы</h3>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {showcase.themes.map((theme) => (
                <article key={`${theme.name}:${theme.description}`} className="rounded-xl border border-border/80 p-4">
                  <p className="text-sm text-foreground">{theme.name}</p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{theme.description}</p>
                </article>
              ))}
            </div>
          </div>
        ) : null}

        {showcase.characters.length > 0 ? (
          <div>
            <div className="mb-3 flex items-center gap-2 text-foreground">
              <Users className="h-4 w-4 text-primary" />
              <h3 className="text-base">Персонажи</h3>
            </div>
            <div className="space-y-3">
              {showcase.characters.map((character) => (
                <article key={`${character.name}:${character.rank}`} className="rounded-xl border border-border/80 p-4">
                  <p className="text-sm text-foreground">
                    {character.name} <span className="text-muted-foreground">• #{character.rank}</span>
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{character.description}</p>
                </article>
              ))}
            </div>
          </div>
        ) : null}

        {showcase.keyEvents.length > 0 ? (
          <div>
            <div className="mb-3 flex items-center gap-2 text-foreground">
              <ListTree className="h-4 w-4 text-primary" />
              <h3 className="text-base">Ключевые события</h3>
            </div>
            <div className="space-y-3">
              {showcase.keyEvents.map((event) => (
                <article key={`${event.title}:${event.description}`} className="rounded-xl border border-border/80 p-4">
                  <p className="text-sm text-foreground">
                    {event.title}{" "}
                    <span className="text-muted-foreground">• {resolveEventImportanceLabel(event.importance)}</span>
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{event.description}</p>
                </article>
              ))}
            </div>
          </div>
        ) : null}

        {showcase.quotes.length > 0 ? (
          <div>
            <h3 className="mb-2 text-sm uppercase tracking-[0.16em] text-muted-foreground">Популярные цитаты</h3>
            <div className="space-y-3">
              {showcase.quotes.map((quote, index) => (
                <blockquote
                  key={`${index}:${quote.text.slice(0, 48)}`}
                  className="rounded-xl border border-border/80 bg-muted/30 px-4 py-3 text-sm leading-7 text-foreground/90"
                >
                  <p className="whitespace-pre-wrap">“{quote.text}”</p>
                  {quote.chapterOrderIndex ? (
                    <footer className="mt-2 text-xs text-muted-foreground">
                      Глава {quote.chapterOrderIndex}
                      {quote.chapterTitle ? ` • ${quote.chapterTitle}` : ""}
                    </footer>
                  ) : null}
                </blockquote>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function BookOverview() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");

  const [book, setBook] = useState<BookCoreDTO | null>(null);
  const [showcase, setShowcase] = useState<BookShowcaseDTO | null>(null);
  const [showcaseLoading, setShowcaseLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { readiness, loading: readinessLoading, error: readinessError } = useBookChatReadiness(bookId);

  useEffect(() => {
    if (!bookId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      setShowcaseLoading(true);

      const [bookResult, showcaseResult] = await Promise.allSettled([getBook(bookId), getBookShowcase(bookId)]);

      if (!active) return;

      if (bookResult?.status === "fulfilled") {
        setBook(bookResult.value);
      } else {
        setBook(null);
        setError(bookResult?.reason instanceof Error ? bookResult.reason.message : "Не удалось загрузить книгу");
      }

      if (showcaseResult?.status === "fulfilled") {
        setShowcase(showcaseResult.value);
      } else {
        setShowcase(null);
      }

      setShowcaseLoading(false);
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
                      <BookSettings book={book} />
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
              transition={{ delay: 0.05 }}
            >
              {showcaseLoading ? (
                <section className="mt-10 rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
                  Загружаем витрину книги...
                </section>
              ) : showcase ? (
                <ShowcaseBlock showcase={showcase} />
              ) : (
                <section className="mt-10 rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
                  Витрина книги ещё не собрана. Она появится автоматически после завершения пост-обработки анализа.
                </section>
              )}
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
