"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Library as LibraryIcon,
  MessageSquare,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AnalyzingBookDTO, type BookCardDTO } from "@/lib/books";
import { listAnalyzingBooks, listBooks, removeBookFromLibrary } from "@/lib/booksClient";
import { BookPreviewStage } from "@/components/BookGalleryCard";
import { PaywallModal } from "@/components/PaywallModal";
import { appendBookDetailSource } from "@/lib/bookDetailNavigation";
import { useEventReconnect, useEventSubscription } from "@/lib/events/EventChannelProvider";

// Fallback poll interval — only used as a safety net when the user has
// analyzing books and the SSE channel hasn't delivered an update for a long
// time (worker crash mid-run, NOTIFY lost, etc). The primary path is
// `book.analysis.done` events from the worker.
const ANALYZING_FALLBACK_REFRESH_MS = 60_000;

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [myBooks, setMyBooks] = useState<BookCardDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [analyzing, setAnalyzing] = useState<AnalyzingBookDTO[]>([]);
  const previousAnalyzingIdsRef = useRef<Set<string>>(new Set());

  // TEMPORARY: until the subscription model exists, treat everyone as Plus.
  // Mirrors the AppChrome mapping — keeps upload/upsell flows testable.
  // Replace with real `User.plan` when the billing backend is wired up.
  const [plan] = useState<Plan>("plus");
  const isPlus = plan === "plus";
  const [paywallOpen, setPaywallOpen] = useState(false);

  // Auto-open paywall when bounced here from /upload by the server-side gate
  // (e.g. /library?paywall=upload). Strip the query param so the modal
  // doesn't reopen on re-renders or on close.
  useEffect(() => {
    if (searchParams.get("paywall") === "upload") {
      setPaywallOpen(true);
      router.replace("/library", { scroll: false });
    }
  }, [searchParams, router]);

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

  // Lifecycle:
  //  1. On mount, fetch the analyzing list once so we render the in-flight
  //     row immediately without waiting for an event.
  //  2. The worker emits `book.analysis.done` via Postgres NOTIFY when a
  //     book transitions to completed/failed. We subscribe via the event
  //     channel and refetch on each event.
  //  3. On SSE reconnect, refetch the list defensively (in case any events
  //     were dropped while the connection was down).
  //  4. Fallback safety net: if there are still analyzing books and we
  //     haven't received an event in 60s, refetch anyway. Covers worker
  //     crashes mid-run, lost NOTIFYs, and any other path where status
  //     transitions silently in the DB.
  const refetchAfterCompletion = useCallback(async () => {
    try {
      const [items, response] = await Promise.all([
        listAnalyzingBooks(),
        listBooks({ scope: "library", page: 1, pageSize: 100 }),
      ]);
      previousAnalyzingIdsRef.current = new Set(items.map((item) => item.id));
      setAnalyzing(items);
      setMyBooks(response.items);
    } catch {
      // non-fatal — UI keeps last known state until next signal
    }
    router.refresh();
  }, [router]);

  useEffect(() => {
    let active = true;

    async function fetchInitial() {
      try {
        const items = await listAnalyzingBooks();
        if (!active) return;
        previousAnalyzingIdsRef.current = new Set(items.map((item) => item.id));
        setAnalyzing(items);
      } catch {
        // tolerate — list will refresh on the next event
      }
    }

    void fetchInitial();

    return () => {
      active = false;
    };
  }, []);

  useEventSubscription("book.analysis.done", () => {
    void refetchAfterCompletion();
  });

  useEventReconnect(() => {
    if (analyzing.length > 0) {
      void refetchAfterCompletion();
    }
  });

  // Safety-net fallback: if there are analyzing books and no event has
  // landed for a minute, force a refresh so a stuck worker can't leave the
  // UI hanging forever.
  useEffect(() => {
    if (analyzing.length === 0) return undefined;
    const timer = setInterval(() => {
      void refetchAfterCompletion();
    }, ANALYZING_FALLBACK_REFRESH_MS);
    return () => clearInterval(timer);
  }, [analyzing.length, refetchAfterCompletion]);

  const total = myBooks.length + analyzing.length;

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
              {isPlus ? (
                <Link className="btn btn-ghost" href="/upload">
                  <Upload size={16} /> Загрузить книгу
                </Link>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setPaywallOpen(true)}
                >
                  <Upload size={16} /> Загрузить книгу
                  <span className="lock-pill">Плюс</span>
                </button>
              )}
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
            <button
              type="button"
              className="btn btn-mark btn-sm"
              onClick={() => setPaywallOpen(true)}
            >
              Перейти на Плюс
            </button>
          </div>
        ) : null}

        <div className="hr" style={{ marginBottom: 32, marginTop: 36 }} />

        {error ? <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", marginBottom: 24, padding: 16 }}>{error}</div> : null}
        {loading ? <div className="muted" style={{ padding: "64px 0", textAlign: "center" }}>Загрузка библиотеки…</div> : null}

        {!loading && total === 0 ? (
          <EmptyLibrary plan={plan} onOpenPaywall={() => setPaywallOpen(true)} />
        ) : null}

        {!loading && total > 0 ? (
          <>
            {analyzing.length > 0 ? (
              <>
                <div className="row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
                  <div className="mono" style={{ color: "var(--bronze)" }}>Анализируется · {analyzing.length}</div>
                  <div className="mono" style={{ color: "var(--ink-faint)" }}>Обычно 1–3 минуты</div>
                </div>
                <div className="library-grid">
                  {analyzing.map((book) => (
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

      <PaywallModal
        open={paywallOpen}
        feature="upload"
        onClose={() => setPaywallOpen(false)}
      />
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

function AnalyzingCard({ book }: { book: AnalyzingBookDTO }) {
  const safeProgress = Math.max(0, Math.min(100, book.progress));
  const previewBook = {
    id: `analyzing:${book.id}`,
    title: book.title,
    author: book.author,
  };
  const authorLine = book.author ? `${book.author} · ${book.format}` : book.format;

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
              <span className="mono" style={{ color: "var(--ink-muted)", fontSize: 9 }}>{book.eta}</span>
            </div>
            <div style={{ background: "var(--paper-2)", borderRadius: 100, height: 3, overflow: "hidden" }}>
              <div style={{ background: "var(--bronze)", height: "100%", transition: "width .3s", width: `${safeProgress}%` }} />
            </div>
            <div style={{ color: "var(--ink-muted)", fontSize: 10, marginTop: 6 }}>{book.stageLabel}…</div>
          </div>
        </div>
      </div>
      <div className="meta">
        <div className="t">{book.title}</div>
        <div className="a">{authorLine}</div>
      </div>
    </div>
  );
}

function EmptyLibrary({ plan, onOpenPaywall }: { plan: Plan; onOpenPaywall: () => void }) {
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
          <button type="button" className="btn btn-mark" onClick={onOpenPaywall}>
            <Sparkles size={16} /> Перейти на Плюс
          </button>
        )}
      </div>
    </div>
  );
}
