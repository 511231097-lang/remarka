"use client";

import { motion } from "motion/react";
import Link from "next/link";
import {
  Library as LibraryIcon,
  MessageSquare,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type BookCardDTO } from "@/lib/books";
import { listBooks, removeBookFromLibrary } from "@/lib/booksClient";
import { BookPreviewStage } from "@/components/BookGalleryCard";
import { appendBookDetailSource } from "@/lib/bookDetailNavigation";

interface AnalyzingBook {
  id: string;
  title: string;
  author: string;
  format?: string;
  progress: number;
  eta?: string;
}

type Plan = "free" | "plus";

function declension(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export function Library() {
  const [myBooks, setMyBooks] = useState<BookCardDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());

  // Plan handling: no plan prop yet — default to "free" (most realistic for
  // current users). When plans get wired in, this becomes the data-driven
  // branch. Typed as Plan (not literal) so downstream branches stay open.
  const [plan] = useState<Plan>("free");
  const isPlus = plan === "plus";

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await listBooks({ scope: "library", page: 1, pageSize: 100 });
        if (!active) return;
        setMyBooks(response.items);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить библиотеку");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  // Backend listings only return books with analysisStatus="completed", so the
  // analyzing list is always empty in the current API. The design renders an
  // "in progress" section when these become available.
  const analyzingList: AnalyzingBook[] = [];
  const total = myBooks.length + analyzingList.length;

  async function handleRemove(book: BookCardDTO) {
    if (!book.canRemoveFromLibrary || removingIds.has(book.id)) return;
    const previousBooks = myBooks;
    setRemovingIds((ids) => new Set(ids).add(book.id));
    setMyBooks((items) => items.filter((item) => item.id !== book.id));
    setError(null);
    try {
      await removeBookFromLibrary(book.id);
    } catch (removeError) {
      setMyBooks(previousBooks);
      setError(removeError instanceof Error ? removeError.message : "Не удалось убрать книгу из библиотеки");
    } finally {
      setRemovingIds((ids) => {
        const next = new Set(ids);
        next.delete(book.id);
        return next;
      });
    }
  }

  return (
    <div className="screen-fade">
      <div className="container" style={{ paddingBottom: 24, paddingTop: 48 }}>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 24, justifyContent: "space-between" }}>
            <div>
              <div className="mono" style={{ color: "var(--mark)", marginBottom: 12 }}>
                Моя библиотека · {total} {declension(total, ["книга", "книги", "книг"])}
              </div>
              <h1 style={{ fontSize: 48, letterSpacing: "-0.02em", lineHeight: 1.05 }}>Ваша полка</h1>
              <p className="soft" style={{ fontSize: 16, lineHeight: 1.55, marginTop: 14, maxWidth: 560 }}>
                Все книги, которые вы сохранили{isPlus ? " или загрузили" : ""}. Откройте любую — и задайте вопрос по одной книге.
              </p>
            </div>
            <div className="row-sm library-actions">
              <Link className="btn btn-ghost" href={isPlus ? "/upload" : "/plans"}>
                <Upload size={16} /> Загрузить книгу
                {!isPlus ? <span className="lock-pill">Плюс</span> : null}
              </Link>
              <Link
                className="btn btn-mark"
                href="/library"
                title="Чат доступен по каждой книге отдельно"
              >
                <MessageSquare size={16} /> Открыть чат
              </Link>
            </div>
          </div>
        </motion.div>

        {!isPlus && myBooks.length > 0 ? (
          <div className="upsell-bar">
            <div className="upsell-icon"><Sparkles size={18} /></div>
            <div className="upsell-copy">
              <div className="upsell-t">Загружайте свои книги на тарифе Плюс</div>
              <div className="upsell-s">EPUB, FB2, PDF — и полный AI-разбор по каждой. Каталог и чат остаются бесплатными.</div>
            </div>
            <Link className="btn btn-mark btn-sm" href="/plans">Перейти на Плюс</Link>
          </div>
        ) : null}

        <div className="hr" style={{ marginBottom: 32, marginTop: 36 }} />

        {error ? <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", marginBottom: 24, padding: 16 }}>{error}</div> : null}
        {loading ? <div className="muted" style={{ padding: "64px 0", textAlign: "center" }}>Загрузка библиотеки…</div> : null}

        {!loading && total === 0 ? <EmptyLibrary plan={plan} /> : null}

        {!loading && total > 0 ? (
          <>
            {analyzingList.length > 0 ? (
              <>
                <div className="row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
                  <div className="mono" style={{ color: "var(--bronze)" }}>Анализируется · {analyzingList.length}</div>
                  <div className="mono" style={{ color: "var(--ink-faint)" }}>Обычно 1–3 минуты</div>
                </div>
                <div className="library-grid">
                  {analyzingList.map((book) => (
                    <AnalyzingCard key={book.id} book={book} />
                  ))}
                </div>
                <div className="hr" style={{ margin: "48px 0 32px" }} />
              </>
            ) : null}
            {myBooks.length > 0 ? (
              <>
                <div className="mono" style={{ color: "var(--ink-muted)", marginBottom: 20 }}>
                  Готовы к чтению · {myBooks.length}
                </div>
                <div className="library-grid">
                  {myBooks.map((book, index) => (
                    <motion.div
                      key={book.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.03 }}
                    >
                      <LibraryCard
                        book={book}
                        removing={removingIds.has(book.id)}
                        onRemove={() => void handleRemove(book)}
                      />
                    </motion.div>
                  ))}
                </div>
              </>
            ) : null}
            <style>{`@keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }`}</style>
          </>
        ) : null}
      </div>

      <div style={{ height: 96 }} />
    </div>
  );
}

function LibraryCard({ book, removing, onRemove }: { book: BookCardDTO; removing: boolean; onRemove: () => void }) {
  const bookHref = appendBookDetailSource(`/book/${book.id}`, "library");
  const chatHref = appendBookDetailSource(`/book/${book.id}/chat`, "library");

  return (
    <div className="book-card" style={{ position: "relative" }}>
      <Link href={bookHref} aria-label={`Открыть книгу: ${book.title}`}>
        <BookPreviewStage book={book} />
      </Link>
      <div className="meta">
        <Link className="t" href={bookHref} style={{ cursor: "pointer" }}>{book.title}</Link>
        <div className="a">{book.author || "Автор не указан"}</div>
      </div>
      <div className="row-sm" style={{ marginTop: 10 }}>
        <Link className="btn btn-ghost btn-sm" href={chatHref}>
          <MessageSquare size={14} /> Чат
        </Link>
        {book.canRemoveFromLibrary ? (
          <button
            className="btn btn-plain btn-sm"
            disabled={removing}
            onClick={onRemove}
            title="Убрать"
            style={{ opacity: removing ? 0.5 : 1 }}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AnalyzingCard({ book }: { book: AnalyzingBook }) {
  const stages = [
    { max: 25, label: "Извлечение текста" },
    { max: 55, label: "Разбивка на фрагменты" },
    { max: 85, label: "Индексация для поиска" },
    { max: 100, label: "Сборка разбора" },
  ];
  const safeProgress = Math.max(0, Math.min(100, book.progress ?? 0));
  const stage = stages.find((item) => safeProgress <= item.max) || stages[stages.length - 1];
  const previewBook = { id: `analyzing:${book.id}`, title: book.title, author: book.author };
  const eta = book.eta || "~2 мин";
  const format = book.format || "EPUB";

  return (
    <div className="book-card" style={{ cursor: "default" }}>
      <div style={{ position: "relative" }}>
        <div style={{ opacity: 0.55 }}><BookPreviewStage book={previewBook} /></div>
        <div style={{ display: "flex", flexDirection: "column", inset: 0, justifyContent: "flex-end", padding: 10, position: "absolute" }}>
          <div style={{ background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r)", boxShadow: "var(--shadow-sm)", padding: "8px 10px" }}>
            <div className="row-sm" style={{ justifyContent: "space-between", marginBottom: 6 }}>
              <span className="mono" style={{ color: "var(--bronze)", fontSize: 9 }}>
                <span style={{ animation: "pulse 1.5s infinite", background: "var(--bronze)", borderRadius: "50%", display: "inline-block", height: 6, marginRight: 5, verticalAlign: "middle", width: 6 }} />
                {safeProgress}%
              </span>
              <span className="mono" style={{ color: "var(--ink-muted)", fontSize: 9 }}>{eta}</span>
            </div>
            <div style={{ background: "var(--paper-2)", borderRadius: 100, height: 3, overflow: "hidden" }}>
              <div style={{ background: "var(--bronze)", height: "100%", transition: "width .3s", width: `${safeProgress}%` }} />
            </div>
            <div style={{ color: "var(--ink-muted)", fontSize: 10, marginTop: 6 }}>{stage.label}…</div>
          </div>
        </div>
      </div>
      <div className="meta">
        <div className="t">{book.title}</div>
        <div className="a">{book.author} · {format}</div>
      </div>
    </div>
  );
}

function EmptyLibrary({ plan }: { plan: Plan }) {
  const isPlus = plan === "plus";
  return (
    <div style={{ padding: "72px 0", textAlign: "center" }}>
      <div style={{ color: "var(--ink-faint)", fontFamily: "var(--font-serif)", fontSize: 52 }}>—</div>
      <h3 style={{ fontSize: 28, marginTop: 16 }}>Полка пока пуста</h3>
      <p className="soft" style={{ fontSize: 15, lineHeight: 1.55, margin: "10px auto 0", maxWidth: 420 }}>
        {isPlus
          ? "Добавьте книгу из каталога или загрузите собственную — в EPUB, FB2 или PDF."
          : "Добавьте книгу из каталога. Загрузка своих книг откроется на тарифе Плюс."}
      </p>
      <div className="row empty-actions" style={{ justifyContent: "center", marginTop: 28 }}>
        <Link className="btn btn-ghost" href="/explore"><LibraryIcon size={16} /> В каталог</Link>
        {isPlus ? (
          <Link className="btn btn-mark" href="/upload"><Upload size={16} /> Загрузить</Link>
        ) : (
          <Link className="btn btn-mark" href="/plans"><Sparkles size={16} /> Перейти на Плюс</Link>
        )}
      </div>
    </div>
  );
}
