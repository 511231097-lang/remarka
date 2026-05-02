"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { BookmarkPlus, ChevronDown, ChevronLeft, ChevronRight, Search, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type BookCardDTO } from "@/lib/books";
import { addBookToLibrary, listBooks, removeBookFromLibrary } from "@/lib/booksClient";
import { BookGalleryCard } from "@/components/BookGalleryCard";
import { appendBookDetailSource } from "@/lib/bookDetailNavigation";

type SortBy = "recent" | "popular";

export const EXPLORE_ITEMS_PER_PAGE = 10;
const ITEMS_PER_PAGE = EXPLORE_ITEMS_PER_PAGE;
const SEARCH_DEBOUNCE_MS = 350;
const CATEGORIES = [
  "Все жанры",
  "Русская классика",
  "Зарубежная проза",
  "Нон-фикшн",
  "Антиутопия",
  "Философия",
  "Психология",
  "Магический реализм",
];

function resolveBooksCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "книга";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "книги";
  return "книг";
}

export interface ExploreInitialData {
  items: BookCardDTO[];
  total: number;
  page: number;
  sort: SortBy;
  q: string;
}

interface ExploreProps {
  isAuthenticated?: boolean;
  initialData?: ExploreInitialData;
}

export function Explore({ isAuthenticated = false, initialData }: ExploreProps) {
  const [sortBy, setSortBy] = useState<SortBy>(initialData?.sort ?? "popular");
  const [searchInput, setSearchInput] = useState(initialData?.q ?? "");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initialData?.q ?? "");
  const [currentPage, setCurrentPage] = useState(initialData?.page ?? 1);
  const [activeCategory, setActiveCategory] = useState("Все жанры");
  const [libraryPendingIds, setLibraryPendingIds] = useState<Set<string>>(new Set());
  const [books, setBooks] = useState<BookCardDTO[]>(initialData?.items ?? []);
  const [total, setTotal] = useState(initialData?.total ?? 0);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  // SSR-hydrate skip: первый useEffect не делает client-fetch если уже есть
  // initialData с теми же query-params, что и первый рендер. Любое изменение
  // sort/page/searchQuery дёргает свежий fetch как обычно.
  const skipNextLoadRef = useRef(Boolean(initialData));

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchQuery, sortBy]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false;
      return;
    }
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await listBooks({
          scope: "explore",
          q: debouncedSearchQuery || undefined,
          sort: sortBy,
          page: currentPage,
          pageSize: ITEMS_PER_PAGE,
        });
        if (!active) return;
        setBooks(response.items);
        setTotal(response.total);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить каталог");
        setBooks([]);
        setTotal(0);
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [currentPage, debouncedSearchQuery, sortBy]);

  const toggleLibrary = async (book: BookCardDTO) => {
    if (!book.canAddToLibrary && !book.canRemoveFromLibrary) return;
    if (libraryPendingIds.has(book.id)) return;

    const previousState = {
      isInLibrary: book.isInLibrary,
      libraryUsersCount: book.libraryUsersCount,
      canAddToLibrary: book.canAddToLibrary,
      canRemoveFromLibrary: book.canRemoveFromLibrary,
    };

    setLibraryPendingIds((prev) => new Set(prev).add(book.id));
    setBooks((prev) =>
      prev.map((item) =>
        item.id === book.id
          ? {
              ...item,
              isInLibrary: !previousState.isInLibrary,
              libraryUsersCount: Math.max(0, previousState.libraryUsersCount + (previousState.isInLibrary ? -1 : 1)),
              canAddToLibrary: previousState.isInLibrary,
              canRemoveFromLibrary: !previousState.isInLibrary,
            }
          : item,
      ),
    );

    try {
      const libraryState = previousState.isInLibrary ? await removeBookFromLibrary(book.id) : await addBookToLibrary(book.id);
      setBooks((prev) =>
        prev.map((item) =>
          item.id === book.id
            ? {
                ...item,
                isInLibrary: libraryState.isInLibrary,
                libraryUsersCount: libraryState.libraryUsersCount,
                canAddToLibrary: !libraryState.isInLibrary && !item.isOwner,
                canRemoveFromLibrary: libraryState.isInLibrary && !item.isOwner,
              }
            : item,
        ),
      );
    } catch (libraryError) {
      setError(libraryError instanceof Error ? libraryError.message : "Не удалось обновить библиотеку");
      setBooks((prev) =>
        prev.map((item) =>
          item.id === book.id
            ? {
                ...item,
                isInLibrary: previousState.isInLibrary,
                libraryUsersCount: previousState.libraryUsersCount,
                canAddToLibrary: previousState.canAddToLibrary,
                canRemoveFromLibrary: previousState.canRemoveFromLibrary,
              }
            : item,
        ),
      );
    } finally {
      setLibraryPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(book.id);
        return next;
      });
    }
  };

  const totalLabel = `${total} ${resolveBooksCountLabel(total)}`;
  const hasSearchInput = Boolean(searchInput.trim());

  const clearSearch = () => {
    setSearchInput("");
    setDebouncedSearchQuery("");
  };

  return (
    <div className="screen-fade">
      <div className="container" style={{ paddingBottom: 24, paddingTop: 48 }}>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 24, justifyContent: "space-between" }}>
            <div>
              <div className="mono" style={{ color: "var(--mark)", marginBottom: 12 }}>
                Каталог · {totalLabel}
              </div>
              <h1 style={{ fontSize: 48, letterSpacing: "-0.02em", lineHeight: 1.05 }}>Открытая библиотека</h1>
              <p className="soft" style={{ fontSize: 16, lineHeight: 1.55, marginTop: 14, maxWidth: 560 }}>
                Курируемая коллекция книг с готовым разбором и чатом. Откройте любую — и задайте вопрос.
              </p>
            </div>
            <div className="search-box">
              <Search size={16} className="search-icon" />
              <input
                className="input"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Название или автор"
                style={{ paddingLeft: 40 }}
              />
            </div>
          </div>

          <div className="hr" style={{ marginBottom: 20, marginTop: 36 }} />

          <div className="catalog-filters">
            <div className="catalog-chips">
              {CATEGORIES.map((category) => (
                <button
                  key={category}
                  className={`chip ${activeCategory === category ? "active" : ""}`}
                  onClick={() => setActiveCategory(category)}
                  title={category === "Все жанры" ? undefined : "UI-фильтр из макета: backend-фильтра по жанрам пока нет"}
                >
                  {category}
                </button>
              ))}
            </div>
            <div className="catalog-bottom">
              <div className="catalog-sort">
                <label style={{ color: "var(--ink-muted)", fontSize: 13 }}>Сортировка:</label>
                <div className="select-wrap">
                  <select
                    value={sortBy}
                    onChange={(event) => setSortBy(event.target.value as SortBy)}
                    className="catalog-select"
                  >
                    <option value="popular">Популярные</option>
                    <option value="recent">Новые</option>
                  </select>
                  <ChevronDown size={10} className="select-caret" aria-hidden />
                </div>
              </div>
              <span className="catalog-count">{totalLabel}</span>
            </div>
          </div>
        </motion.div>
      </div>

      <div className="container" style={{ paddingBottom: 96, paddingTop: 32 }}>
        {error ? (
          <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", marginBottom: 24, padding: 16 }}>{error}</div>
        ) : null}
        {loading ? (
          <div className="muted" style={{ padding: "64px 0", textAlign: "center" }}>Загрузка каталога…</div>
        ) : null}
        {!loading && books.length === 0 ? (
          <div style={{ padding: "64px 0", textAlign: "center" }}>
            <h3 style={{ fontSize: 22 }}>Ничего не нашлось</h3>
            <p className="muted" style={{ marginTop: 8 }}>Попробуйте загрузить книгу сами — мы её разберём.</p>
            <div className="row" style={{ gap: 12, justifyContent: "center", marginTop: 20 }}>
              {hasSearchInput ? (
                <button className="btn btn-plain" onClick={clearSearch}>Очистить поиск</button>
              ) : null}
              {isAuthenticated ? (
                <Link className="btn btn-mark" href="/upload">
                  <Upload size={16} /> Загрузить книгу
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
        {!loading && books.length > 0 ? (
          <>
            <div className="explore-grid">
              {books.map((book, index) => {
                const disabled = (!book.canAddToLibrary && !book.canRemoveFromLibrary) || libraryPendingIds.has(book.id);
                const showLibraryAction = isAuthenticated && !book.isOwner && !book.isInLibrary && book.canAddToLibrary;
                return (
                  <motion.div key={book.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }}>
                    <BookGalleryCard
                      book={book}
                      href={appendBookDetailSource(`/book/${book.id}`, "explore")}
                      action={
                        showLibraryAction ? (
                          <button
                            className="badge"
                            disabled={disabled}
                            onClick={() => void toggleLibrary(book)}
                            style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}
                          >
                            <BookmarkPlus size={12} /> В библиотеку
                          </button>
                        ) : null
                      }
                    />
                  </motion.div>
                );
              })}
            </div>
            {totalPages > 1 ? (
              <div className="row" style={{ justifyContent: "center", marginTop: 48 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage === 1}>
                  <ChevronLeft size={16} />
                </button>
                <span className="mono" style={{ color: "var(--ink-muted)" }}>{currentPage} / {totalPages}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} disabled={currentPage === totalPages}>
                  <ChevronRight size={16} />
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <style jsx>{`
        .search-box {
          position: relative;
          width: 340px;
          max-width: 100%;
        }
        .search-box :global(.search-icon) {
          color: var(--ink-faint);
          left: 14px;
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          pointer-events: none;
        }
        .catalog-filters {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }
        .catalog-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .catalog-bottom {
          align-items: center;
          display: flex;
          flex-wrap: wrap;
          gap: 16px;
          justify-content: space-between;
        }
        .catalog-sort {
          align-items: center;
          display: flex;
          gap: 10px;
        }
        .select-wrap {
          position: relative;
        }
        .catalog-select {
          appearance: none;
          -webkit-appearance: none;
          -moz-appearance: none;
          background: var(--paper-2);
          border: 1px solid var(--rule);
          border-radius: 100px;
          color: var(--ink);
          cursor: pointer;
          font-family: inherit;
          font-size: 13px;
          outline: none;
          padding: 8px 36px 8px 14px;
        }
        .select-wrap :global(.select-caret) {
          color: var(--ink-muted);
          pointer-events: none;
          position: absolute;
          right: 14px;
          top: 50%;
          transform: translateY(-50%);
        }
        .catalog-count {
          color: var(--ink-faint);
          font-family: var(--font-mono);
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .explore-grid {
          display: grid;
          gap: 32px;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          row-gap: 44px;
        }
        @media (max-width: 1080px) {
          .explore-grid {
            grid-template-columns: repeat(4, minmax(0, 1fr));
          }
        }
        @media (max-width: 860px) {
          .explore-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }
        @media (max-width: 640px) {
          .search-box {
            width: 100%;
          }
          .explore-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 420px) {
          .explore-grid {
            grid-template-columns: 1fr;
            max-width: 200px;
            margin: 0 auto;
          }
        }
      `}</style>
    </div>
  );
}
