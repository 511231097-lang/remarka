"use client";

import { motion } from "motion/react";
import { BookmarkPlus, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { type BookCardDTO } from "@/lib/books";
import { addBookToLibrary, listBooks, removeBookFromLibrary } from "@/lib/booksClient";
import { BookGalleryCard } from "@/components/BookGalleryCard";
import { appendBookDetailSource } from "@/lib/bookDetailNavigation";

type SortBy = "recent" | "popular";

const ITEMS_PER_PAGE = 10;
const CATEGORIES = ["Все жанры", "Русская классика", "Зарубежная проза", "Нон-фикшн", "Антиутопия", "Философия", "Психология", "Магический реализм"];

function resolveBooksCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "книга";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "книги";
  return "книг";
}

export function Explore() {
  const [sortBy, setSortBy] = useState<SortBy>("popular");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [activeCategory, setActiveCategory] = useState("Все жанры");
  const [libraryPendingIds, setLibraryPendingIds] = useState<Set<string>>(new Set());
  const [books, setBooks] = useState<BookCardDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sortBy]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await listBooks({
          scope: "explore",
          q: searchQuery || undefined,
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
  }, [currentPage, searchQuery, sortBy]);

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

  return (
    <div className="screen-fade">
      <div className="container" style={{ paddingBottom: 24, paddingTop: 48 }}>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 24, justifyContent: "space-between" }}>
            <div>
              <div className="mono" style={{ color: "var(--mark)", marginBottom: 12 }}>Каталог · {total || "98"} книг</div>
              <h1 style={{ fontSize: 48, letterSpacing: 0, lineHeight: 1.05 }}>Открытая библиотека</h1>
              <p className="soft" style={{ fontSize: 16, lineHeight: 1.55, marginTop: 14, maxWidth: 560 }}>
                Курируемая коллекция книг с готовым разбором и чатом. Откройте любую - и задайте вопрос.
              </p>
            </div>
            <div style={{ position: "relative", width: 340 }}>
              <Search size={16} style={{ color: "var(--ink-faint)", left: 14, position: "absolute", top: "50%", transform: "translateY(-50%)" }} />
              <input className="input" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Название или автор" style={{ paddingLeft: 40 }} />
            </div>
          </div>

          <div className="hr" style={{ marginBottom: 20, marginTop: 36 }} />

          <div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
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
            <div className="row" style={{ flexWrap: "wrap", justifyContent: "space-between", marginTop: 24 }}>
              <div className="row-sm">
                <label style={{ color: "var(--ink-muted)", fontSize: 13 }}>Сортировка:</label>
                <select className="input" value={sortBy} onChange={(event) => setSortBy(event.target.value as SortBy)} style={{ borderRadius: 100, fontSize: 13, padding: "8px 34px 8px 14px", width: "auto" }}>
                  <option value="popular">Популярные</option>
                  <option value="recent">Новые</option>
                </select>
              </div>
              <span className="mono" style={{ color: "var(--ink-faint)", fontSize: 11 }}>
                {total} {resolveBooksCountLabel(total)}
              </span>
            </div>
          </div>
        </motion.div>
      </div>

      <div className="container" style={{ paddingBottom: 96, paddingTop: 32 }}>
        {error && <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", marginBottom: 24, padding: 16 }}>{error}</div>}
        {loading && <div className="muted" style={{ padding: "64px 0", textAlign: "center" }}>Загрузка каталога...</div>}
        {!loading && books.length === 0 && (
          <div style={{ padding: "64px 0", textAlign: "center" }}>
            <h3 style={{ fontSize: 22 }}>Ничего не нашлось</h3>
            <p className="muted" style={{ marginTop: 8 }}>Попробуйте изменить запрос или загрузить книгу сами.</p>
            {searchQuery && <button className="btn btn-plain" style={{ marginTop: 14 }} onClick={() => setSearchQuery("")}>Очистить поиск</button>}
          </div>
        )}
        {!loading && books.length > 0 && (
          <>
            <div style={{ display: "grid", gap: 32, gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", rowGap: 44 }}>
              {books.map((book, index) => {
                const disabled = (!book.canAddToLibrary && !book.canRemoveFromLibrary) || libraryPendingIds.has(book.id);
                return (
                  <motion.div key={book.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }}>
                    <BookGalleryCard
                      book={book}
                      href={appendBookDetailSource(`/book/${book.id}`, "explore")}
                      action={
                        !book.isOwner && !book.isInLibrary ? (
                          <button className="badge" disabled={disabled} onClick={() => void toggleLibrary(book)} style={{ opacity: disabled ? 0.55 : 1 }}>
                            <BookmarkPlus size={12} /> В библиотеку
                          </button>
                        ) : null
                      }
                    />
                  </motion.div>
                );
              })}
            </div>
            {totalPages > 1 && (
              <div className="row" style={{ justifyContent: "center", marginTop: 48 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage === 1}>
                  <ChevronLeft size={16} />
                </button>
                <span className="mono" style={{ color: "var(--ink-muted)" }}>{currentPage} / {totalPages}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} disabled={currentPage === totalPages}>
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
