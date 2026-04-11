"use client";

import { motion } from "motion/react";
import { Heart, BookOpen, Users, Lightbulb, User, MapPin } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { displayAuthor, type BookCardDTO } from "@/lib/books";
import { listBooks, unlikeBook } from "@/lib/booksClient";

const FAVORITES_PAGE_SIZE = 50;

export function Favorites() {
  const [likedBooks, setLikedBooks] = useState<BookCardDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;

    async function loadAllFavorites() {
      setLoading(true);
      setError(null);

      try {
        const collected: BookCardDTO[] = [];
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages) {
          const response = await listBooks({
            scope: "favorites",
            sort: "recent",
            page,
            pageSize: FAVORITES_PAGE_SIZE,
          });

          if (!active) return;

          collected.push(...response.items);
          totalPages = Math.max(1, Math.ceil(response.total / response.pageSize));
          page += 1;
        }

        if (!active) return;
        setLikedBooks(collected);
      } catch (loadError) {
        if (!active) return;
        const message =
          loadError instanceof Error
            ? loadError.message
            : "Не удалось загрузить избранные книги";
        setError(message);
        setLikedBooks([]);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadAllFavorites();

    return () => {
      active = false;
    };
  }, []);

  const handleUnlike = async (book: BookCardDTO) => {
    if (!book.canLike) return;
    if (pendingIds.has(book.id)) return;
    const targetIndex = likedBooks.findIndex((item) => item.id === book.id);
    if (targetIndex < 0) return;

    setPendingIds((prev) => {
      const next = new Set(prev);
      next.add(book.id);
      return next;
    });

    setLikedBooks((prev) => prev.filter((item) => item.id !== book.id));

    try {
      await unlikeBook(book.id);
    } catch (unlikeError) {
      const message =
        unlikeError instanceof Error
          ? unlikeError.message
          : "Не удалось снять лайк";
      setError(message);
      setLikedBooks((prev) => {
        if (prev.some((item) => item.id === book.id)) return prev;
        const next = [...prev];
        next.splice(Math.min(targetIndex, next.length), 0, book);
        return next;
      });
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(book.id);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div className="text-muted-foreground">Загрузка избранного...</div>
      </div>
    );
  }

  if (likedBooks.length === 0) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md text-center space-y-6"
        >
          <div className="w-20 h-20 rounded-full bg-secondary mx-auto flex items-center justify-center">
            <Heart className="w-10 h-10 text-muted-foreground" />
          </div>

          <div className="space-y-3">
            <h1 className="text-2xl text-foreground">Нет избранных книг</h1>
            <p className="text-muted-foreground">
              Лайкайте интересные анализы в каталоге, чтобы сохранить их здесь
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <Link
            href="/explore"
            className="inline-block px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
          >
            Перейти в каталог
          </Link>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <div className="flex items-center gap-4 mb-3">
            <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
              <Heart className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-4xl text-foreground">Избранное</h1>
          </div>
          <p className="text-muted-foreground ml-16">
            {likedBooks.length} {likedBooks.length === 1 ? "книга" : "книги"}
          </p>
          {error && <p className="text-sm text-destructive ml-16 mt-2">{error}</p>}
        </motion.div>

        <div className="space-y-4">
          {likedBooks.map((book, index) => (
            <motion.div
              key={book.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
            >
              <div className="flex items-start justify-between mb-4 gap-4">
                <div className="flex-1 min-w-0">
                  <Link href={`/book/${book.id}`}>
                    <h2 className="text-xl text-foreground mb-1 hover:text-primary transition-colors">
                      {book.title}
                    </h2>
                  </Link>
                  <p className="text-muted-foreground">{displayAuthor(book.author)}</p>
                </div>

                <button
                  onClick={() => void handleUnlike(book)}
                  disabled={pendingIds.has(book.id) || !book.canLike}
                  className={`flex items-center gap-2 px-3 py-1 rounded-full transition-colors ${
                    pendingIds.has(book.id) || !book.canLike
                      ? "bg-secondary text-muted-foreground/70 cursor-not-allowed"
                      : "bg-primary/10 text-primary hover:bg-primary/15"
                  }`}
                >
                  <Heart className="w-4 h-4 fill-current" />
                  <span className="text-sm">{book.likesCount}</span>
                </button>
              </div>

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
                <span>{book.owner.name}</span>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
