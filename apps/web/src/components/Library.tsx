"use client";

import { motion } from "motion/react";
import { Upload, BookOpen } from "lucide-react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { currentUser } from "@/lib/mockData";
import { displayAuthor, type BookCardDTO } from "@/lib/books";
import { listBooks } from "@/lib/booksClient";

const COVER_THEMES = [
  "from-blue-600 via-cyan-500 to-teal-400",
  "from-emerald-600 via-lime-500 to-yellow-400",
  "from-rose-600 via-pink-500 to-orange-400",
  "from-violet-600 via-fuchsia-500 to-pink-400",
  "from-amber-700 via-orange-600 to-red-500",
  "from-slate-700 via-slate-600 to-zinc-500",
] as const;

function resolveCoverTheme(bookId: string): (typeof COVER_THEMES)[number] {
  let hash = 0;
  for (const char of String(bookId || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return COVER_THEMES[hash % COVER_THEMES.length] || COVER_THEMES[0];
}

function truncateCoverTitle(value: string): string {
  const title = String(value || "").trim();
  if (!title) return "Без названия";
  if (title.length <= 70) return title;
  return `${title.slice(0, 67).trimEnd()}...`;
}

function BookShelfCover({ book }: { book: BookCardDTO }) {
  const [hasImageError, setHasImageError] = useState(false);
  const canUseImage = Boolean(book.coverUrl) && !hasImageError;
  const title = truncateCoverTitle(book.title);
  const author = displayAuthor(book.author);

  return (
    <>
      {canUseImage ? (
        <img
          src={String(book.coverUrl)}
          alt={`Обложка: ${book.title}`}
          className="absolute inset-0 h-full w-full object-cover object-center"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setHasImageError(true)}
        />
      ) : (
        <div className={`absolute inset-0 bg-gradient-to-br ${resolveCoverTheme(book.id)}`} />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/92 via-black/42 via-28% to-transparent" />
      <div className="absolute inset-x-0 bottom-0 z-10 px-3 pb-3 pt-10 text-white">
        <p className="line-clamp-2 text-[0.98rem] leading-[1.1]">{title}</p>
        <p className="mt-1 line-clamp-1 text-sm text-white/80">{author}</p>
      </div>
    </>
  );
}

function AddBookCard({ limitReached }: { limitReached: boolean }) {
  const href = limitReached ? "/plans" : "/upload";
  const ctaLabel = limitReached ? "Открыть тарифы" : "Загрузить книгу";

  return (
    <Link
      href={href}
      className="group block aspect-[2/3] overflow-hidden rounded-[20px] border border-dashed border-primary/30 bg-[#17120f] transition-colors hover:border-primary/55"
    >
      <div className="flex h-full w-full flex-col items-center justify-center px-5 text-center">
        <h3 className="line-clamp-2 text-lg text-foreground transition-colors group-hover:text-primary">
          Добавить новую книгу
        </h3>
        <p className="mt-2 max-w-[24ch] text-sm text-muted-foreground">
          {limitReached
            ? "Лимит базового тарифа исчерпан. Перейдите к тарифам, чтобы добавить больше книг."
            : "Загрузите файл и получите структурированный анализ персонажей, тем и сцен."}
        </p>

        <div className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground transition-opacity group-hover:opacity-90">
          <Upload className="h-3.5 w-3.5" />
          <span>{ctaLabel}</span>
        </div>
      </div>
    </Link>
  );
}

export function Library() {
  const [myBooks, setMyBooks] = useState<BookCardDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await listBooks({
          scope: "library",
          page: 1,
          pageSize: 100,
        });

        if (!active) return;
        setMyBooks(response.items);
      } catch (loadError) {
        if (!active) return;
        const message = loadError instanceof Error ? loadError.message : "Не удалось загрузить библиотеку";
        setError(message);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  const hasBooks = myBooks.length > 0;
  const planBookLimit = currentUser.plan.features.maxBooks;
  const isBookLimitReached =
    currentUser.plan.type === "basic" && typeof planBookLimit === "number" && myBooks.length >= planBookLimit;

  if (!hasBooks) {
    return <EmptyLibrary loading={loading} error={error} />;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="mb-12">
          <h1 className="text-3xl text-foreground mb-2">Мои книги</h1>
          <p className="text-muted-foreground">
            {myBooks.length} {myBooks.length === 1 ? "книга" : "книги"}
          </p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 xl:grid-cols-4">
          <motion.div
            key="add-new-book-card"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <AddBookCard limitReached={isBookLimitReached} />
          </motion.div>

          {myBooks.map((book, index) => (
            <motion.div
              key={book.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: (index + 1) * 0.1 }}
            >
              <Link
                href={`/book/${book.id}`}
                className="group relative block aspect-[2/3] overflow-hidden rounded-[20px] bg-[#120f0d] transition-transform duration-300 hover:scale-[1.015]"
              >
                <BookShelfCover book={book} />
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyLibrary({ loading, error }: { loading: boolean; error: string | null }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md text-center space-y-6"
      >
        <div className="w-20 h-20 rounded-full bg-secondary mx-auto flex items-center justify-center">
          <BookOpen className="w-10 h-10 text-primary" />
        </div>

        <div className="space-y-3">
          <h1 className="text-2xl text-foreground">Начните исследование</h1>
          <p className="text-muted-foreground">
            {loading
              ? "Загружаем ваши книги..."
              : "Загрузите вашу первую книгу, чтобы получить структурированный анализ персонажей, тем и событий"}
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <Link
          href="/upload"
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
        >
          <Upload className="w-4 h-4" />
          Загрузить книгу
        </Link>

        <div className="pt-8 space-y-4 text-left">
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
              <span className="text-sm text-primary">1</span>
            </div>
            <div>
              <p className="text-sm text-foreground">Загрузите файл книги</p>
              <p className="text-xs text-muted-foreground">Форматы: FB2 или ZIP с FB2</p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
              <span className="text-sm text-primary">2</span>
            </div>
            <div>
              <p className="text-sm text-foreground">Дождитесь загрузки</p>
              <p className="text-xs text-muted-foreground">Мы извлечем название и автора из FB2</p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
              <span className="text-sm text-primary">3</span>
            </div>
            <div>
              <p className="text-sm text-foreground">Исследуйте карточку книги</p>
              <p className="text-xs text-muted-foreground">Детальный анализ подключим на следующем этапе</p>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
