"use client";

import { motion } from "motion/react";
import { Upload, BookOpen, Users, Lightbulb, Clock, Lock, Globe, MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { currentUser } from "@/lib/mockData";
import { displayAuthor, type BookCardDTO } from "@/lib/books";
import { listBooks } from "@/lib/booksClient";

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

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 p-8 bg-secondary/50 border border-border rounded-lg text-center"
        >
          <h3 className="text-xl text-foreground mb-3">Добавьте новую книгу</h3>
          <p className="text-muted-foreground mb-6">
            Загрузите произведение и получите структурированный анализ персонажей, тем и событий
          </p>
          <Link
            href="/upload"
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
          >
            <Upload className="w-4 h-4" />
            Загрузить книгу
          </Link>

          {myBooks.length >= (currentUser.plan.features.maxBooks as number) && currentUser.plan.type === "basic" && (
            <p className="mt-4 text-sm text-muted-foreground">
              Лимит книг исчерпан.{" "}
              <Link href="/plans" className="text-primary hover:underline">
                Обновите до тарифа Плюс
              </Link>{" "}
              для безлимитной загрузки
            </p>
          )}
        </motion.div>

        {error && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-4">
          {myBooks.map((book, index) => (
            <motion.div
              key={book.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <Link
                href={`/book/${book.id}`}
                className="block p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h2 className="text-xl text-foreground mb-1">{book.title}</h2>
                    <p className="text-muted-foreground mb-4">{displayAuthor(book.author)}</p>

                    <div className="flex items-center gap-6 text-sm flex-wrap">
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
                  </div>

                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4" />
                      <span>
                        {new Date(book.createdAt).toLocaleDateString("ru-RU", {
                          day: "numeric",
                          month: "long",
                        })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {book.isPublic ? (
                        <>
                          <Globe className="w-4 h-4 text-primary" />
                          <span className="text-primary">Публичная</span>
                        </>
                      ) : (
                        <>
                          <Lock className="w-4 h-4" />
                          <span>Приватная</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
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
