"use client";

import { motion } from "motion/react";
import { BookOpen, Users, Lightbulb, Heart, User, TrendingUp, Clock, Upload, Search, ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { useState, useEffect } from "react";
import Link from "next/link";
import { mockBooks } from "@/lib/mockData";

type SortBy = "recent" | "popular" | "likes";

const ITEMS_PER_PAGE = 10;

export function Explore() {
  const [sortBy, setSortBy] = useState<SortBy>("popular");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [likedBooks, setLikedBooks] = useState<Set<string>>(
    new Set(mockBooks.filter((b) => b.isLiked).map((b) => b.id))
  );

  const publicBooks = mockBooks.filter((b) => b.isPublic);

  const filteredBooks = publicBooks.filter((book) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      book.title.toLowerCase().includes(query) ||
      book.author.toLowerCase().includes(query) ||
      book.uploadedBy.name.toLowerCase().includes(query)
    );
  });

  const sortedBooks = [...filteredBooks].sort((a, b) => {
    if (sortBy === "recent") {
      return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
    }
    if (sortBy === "popular") {
      return b.likesCount - a.likesCount;
    }
    return 0;
  });

  const totalPages = Math.ceil(sortedBooks.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedBooks = sortedBooks.slice(startIndex, endIndex);

  // Reset page when search or sort changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sortBy]);

  const toggleLike = (bookId: string) => {
    setLikedBooks((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
      }
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-4xl text-foreground mb-3">Каталог анализов</h1>
          <p className="text-muted-foreground">
            Исследуйте литературные произведения, проанализированные сообществом
          </p>
        </motion.div>

        {/* Search */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-6"
        >
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Поиск по названию, автору или пользователю..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-12 pr-4 py-3 bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary transition-colors"
            />
          </div>
        </motion.div>

        {/* Sorting */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="flex items-center gap-3 mb-8"
        >
          <span className="text-sm text-muted-foreground">Сортировка:</span>
          <div className="flex gap-2">
            <button
              onClick={() => setSortBy("popular")}
              className={`px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                sortBy === "popular"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-foreground hover:bg-primary/10"
              }`}
            >
              <TrendingUp className="w-4 h-4" />
              Популярные
            </button>
            <button
              onClick={() => setSortBy("recent")}
              className={`px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                sortBy === "recent"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-foreground hover:bg-primary/10"
              }`}
            >
              <Clock className="w-4 h-4" />
              Недавние
            </button>
          </div>
        </motion.div>

        {/* No Results */}
        {sortedBooks.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-16"
          >
            <p className="text-muted-foreground mb-4">
              {searchQuery ? "Ничего не найдено" : "Пока нет публичных анализов"}
            </p>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="text-sm text-primary hover:underline"
              >
                Очистить поиск
              </button>
            )}
          </motion.div>
        )}

        {/* Books Grid */}
        {sortedBooks.length > 0 && (
          <>
          <div className="space-y-4">
          {paginatedBooks.map((book, index) => (
            <motion.div
              key={book.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + index * 0.05 }}
              className="p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
            >
              <div className="flex items-start gap-6">
                <div className="flex-1">
                  <Link href={`/book/${book.id}`} className="block mb-4">
                    <h2 className="text-xl text-foreground mb-1 hover:text-primary transition-colors">
                      {book.title}
                    </h2>
                    <p className="text-muted-foreground">{book.author}</p>
                  </Link>

                  <div className="flex items-center gap-6 text-sm mb-4 flex-wrap">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <BookOpen className="w-4 h-4" />
                      <span>{book.chaptersCount} глав</span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Users className="w-4 h-4" />
                      <span>{book.charactersCount} персонажей</span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Lightbulb className="w-4 h-4" />
                      <span>{book.themesCount} тем</span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <MapPin className="w-4 h-4" />
                      <span>{book.locationsCount} локаций</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center">
                      <User className="w-3 h-3 text-primary" />
                    </div>
                    <span>{book.uploadedBy.name}</span>
                    <span>•</span>
                    <span>
                      {new Date(book.uploadedAt).toLocaleDateString("ru-RU", {
                        day: "numeric",
                        month: "long",
                      })}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col items-end gap-3">
                  <button
                    onClick={() => toggleLike(book.id)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                      likedBooks.has(book.id)
                        ? "bg-primary/10 text-primary"
                        : "bg-secondary text-muted-foreground hover:bg-secondary/80"
                    }`}
                  >
                    <Heart
                      className={`w-4 h-4 ${likedBooks.has(book.id) ? "fill-current" : ""}`}
                    />
                    <span className="text-sm">
                      {likedBooks.has(book.id) ? book.likesCount + 1 : book.likesCount}
                    </span>
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="mt-8 flex items-center justify-center gap-2"
            >
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="p-2 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>

              <div className="flex items-center gap-1">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                  <button
                    key={page}
                    onClick={() => setCurrentPage(page)}
                    className={`px-4 py-2 rounded-lg transition-colors ${
                      currentPage === page
                        ? "bg-primary text-primary-foreground"
                        : "border border-border hover:bg-secondary"
                    }`}
                  >
                    {page}
                  </button>
                ))}
              </div>

              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="p-2 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </motion.div>
          )}
          </>
        )}
      </div>
    </div>
  );
}
