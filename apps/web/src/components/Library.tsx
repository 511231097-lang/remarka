"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { Library as LibraryIcon, MessageCircle, Sparkles, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { currentUser } from "@/lib/mockData";
import { type BookCardDTO } from "@/lib/books";
import { listBooks, removeBookFromLibrary } from "@/lib/booksClient";
import { BookPreviewStage } from "@/components/BookGalleryCard";
import { appendBookDetailSource } from "@/lib/bookDetailNavigation";

function resolveBooksCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "книга";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "книги";
  return "книг";
}

export function Library() {
  const [myBooks, setMyBooks] = useState<BookCardDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());

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

  const isPlus = currentUser.plan.type === "plus";
  const analyzingList: Array<{ id: string; title: string; author: string; progress: number; eta?: string }> = [];
  const total = myBooks.length + (isPlus ? analyzingList.length : 0);

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
                Моя библиотека · {total} {resolveBooksCountLabel(total)}
              </div>
              <h1 style={{ fontSize: 48, letterSpacing: 0, lineHeight: 1.05 }}>Ваша полка</h1>
              <p className="soft" style={{ fontSize: 16, lineHeight: 1.55, marginTop: 14, maxWidth: 560 }}>
                Все книги, которые вы сохранили{isPlus ? " или загрузили" : ""}. Задавайте вопрос сразу по всей полке - или по одной книге.
              </p>
            </div>
            <div className="row-sm library-actions">
              <Link className="btn btn-ghost" href={isPlus ? "/upload" : "/plans"}>
                <Upload size={16} /> Загрузить книгу
                {!isPlus ? <span className="lock-pill">Плюс</span> : null}
              </Link>
              <button
                className="btn btn-mark"
                disabled
                title="UI-заглушка: общий чат по библиотеке пока не подключён к backend"
                style={{ opacity: 0.72 }}
              >
                <MessageCircle size={16} /> Открыть чат
              </button>
            </div>
          </div>
        </motion.div>

        {!isPlus && myBooks.length > 0 ? (
          <div className="upsell-bar">
            <div className="upsell-icon"><Sparkles size={18} /></div>
            <div className="upsell-copy">
              <div className="upsell-title">Загружайте свои книги на тарифе Плюс</div>
              <div className="upsell-subtitle">EPUB, FB2, PDF - и полный AI-разбор по каждой. Каталог и чат остаются бесплатными.</div>
            </div>
            <Link className="btn btn-mark btn-sm" href="/plans">Перейти на Плюс</Link>
          </div>
        ) : null}

        <div className="hr" style={{ marginBottom: 32, marginTop: 36 }} />

        {error ? <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", marginBottom: 24, padding: 16 }}>{error}</div> : null}
        {loading ? <div className="muted" style={{ padding: "64px 0", textAlign: "center" }}>Загрузка библиотеки...</div> : null}

        {!loading && total === 0 ? (
          <EmptyLibrary isPlus={isPlus} />
        ) : null}

        {!loading && total > 0 ? (
          <>
            {isPlus && analyzingList.length > 0 ? (
              <>
                <div className="row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
                  <div className="mono" style={{ color: "var(--bronze)" }}>Анализируется · {analyzingList.length}</div>
                  <div className="mono" style={{ color: "var(--ink-faint)" }}>Обычно 1-3 минуты</div>
                </div>
                <div className="library-grid">
                  {analyzingList.map((book) => (
                    <AnalyzingCard key={book.id} title={book.title} author={book.author} progress={book.progress} eta={book.eta} />
                  ))}
                </div>
                <div className="hr" style={{ margin: "48px 0 32px" }} />
              </>
            ) : null}
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
      </div>

      <div style={{ height: 96 }} />

      <style jsx>{`
        .library-actions {
          align-items: center;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .lock-pill {
          align-items: center;
          background: var(--mark-soft);
          border-radius: 100px;
          color: var(--mark);
          display: inline-flex;
          font-family: var(--font-mono);
          font-size: 9.5px;
          font-weight: 500;
          letter-spacing: 0.06em;
          margin-left: 8px;
          padding: 2px 8px;
          text-transform: uppercase;
        }
        .upsell-bar {
          align-items: center;
          background: var(--cream);
          border: 1px solid var(--mark);
          border-radius: var(--r-lg);
          box-shadow: var(--shadow-sm);
          display: flex;
          gap: 16px;
          margin-top: 28px;
          padding: 16px 20px;
        }
        .upsell-icon {
          align-items: center;
          background: var(--mark-soft);
          border-radius: 50%;
          color: var(--mark);
          display: flex;
          flex-shrink: 0;
          height: 40px;
          justify-content: center;
          width: 40px;
        }
        .upsell-copy {
          flex: 1;
          min-width: 0;
        }
        .upsell-title {
          color: var(--ink);
          font-family: var(--font-serif);
          font-size: 16px;
        }
        .upsell-subtitle {
          color: var(--ink-muted);
          font-size: 13px;
          line-height: 1.5;
          margin-top: 3px;
        }
        .library-grid {
          display: grid;
          gap: 32px;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          row-gap: 44px;
        }
        @media (max-width: 1080px) {
          .library-grid {
            grid-template-columns: repeat(4, minmax(0, 1fr));
          }
        }
        @media (max-width: 860px) {
          .library-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }
        @media (max-width: 640px) {
          .library-actions {
            align-items: stretch;
            width: 100%;
          }
          .library-actions :global(.btn) {
            justify-content: center;
            width: 100%;
          }
          .upsell-bar {
            align-items: flex-start;
            flex-direction: column;
          }
          .library-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 420px) {
          .library-grid {
            grid-template-columns: 1fr;
            max-width: 180px;
          }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
      `}</style>
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
        <Link className="t" href={bookHref}>{book.title}</Link>
        <div className="a">{book.author || "Автор не указан"}</div>
      </div>
      <div className="row-sm" style={{ marginTop: 10 }}>
        <Link className="btn btn-ghost btn-sm" href={chatHref}>
          <MessageCircle size={14} /> Чат
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

function AnalyzingCard({ title, author, progress = 0, eta = "~2 мин" }: { title: string; author: string; progress?: number; eta?: string }) {
  const stages = [
    { max: 25, label: "Извлечение текста" },
    { max: 55, label: "Разбивка на фрагменты" },
    { max: 85, label: "Индексация для поиска" },
    { max: 100, label: "Сборка разбора" },
  ];
  const safeProgress = Math.max(0, Math.min(100, progress));
  const stage = stages.find((item) => safeProgress <= item.max) || stages[stages.length - 1];
  const previewBook = { id: `analyzing:${title}`, title, author };

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
            <div style={{ color: "var(--ink-muted)", fontSize: 10, marginTop: 6 }}>{stage.label}...</div>
          </div>
        </div>
      </div>
      <div className="meta">
        <div className="t">{title}</div>
        <div className="a">{author} · EPUB</div>
      </div>
    </div>
  );
}

function EmptyLibrary({ isPlus }: { isPlus: boolean }) {
  return (
    <div style={{ padding: "72px 0", textAlign: "center" }}>
      <div style={{ color: "var(--ink-faint)", fontFamily: "var(--font-serif)", fontSize: 52 }}>—</div>
      <h3 style={{ fontSize: 28, marginTop: 16 }}>Полка пока пуста</h3>
      <p className="soft" style={{ fontSize: 15, lineHeight: 1.55, margin: "10px auto 0", maxWidth: 420 }}>
        {isPlus
          ? "Добавьте книгу из каталога или загрузите собственную - в EPUB, FB2 или PDF."
          : "Добавьте книгу из каталога. Загрузка своих книг откроется на тарифе Плюс."}
      </p>
      <div className="row" style={{ justifyContent: "center", marginTop: 28 }}>
        <Link className="btn btn-ghost" href="/explore"><LibraryIcon size={16} /> В каталог</Link>
        {isPlus ? (
          <Link className="btn btn-mark" href="/upload"><Upload size={16} /> Загрузить</Link>
        ) : (
          <Link className="btn btn-mark" href="/plans"><Sparkles size={16} /> Перейти на Плюс</Link>
        )}
      </div>
      <style jsx>{`
        @media (max-width: 520px) {
          .row {
            align-items: stretch;
            flex-direction: column;
          }
          .row :global(.btn) {
            justify-content: center;
            width: 100%;
          }
        }
      `}</style>
    </div>
  );
}
