"use client";

import { motion } from "motion/react";
import { Users, Lightbulb, BookOpen, ArrowRight, Quote, MapPin } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookNavigation } from "./BookNavigation";
import { BookSettings } from "./BookSettings";
import { getBook, getBookChapters } from "@/lib/booksClient";
import { displayAuthor, type BookChapterDTO, type BookCoreDTO } from "@/lib/books";

const PLACEHOLDER_CHARACTERS = ["Персонажи появятся", "после интеграции", "аналитического контура"];
const PLACEHOLDER_THEMES = ["Темы появятся после", "подключения extraction", "и агрегации данных"];
const PLACEHOLDER_LOCATIONS = ["Локации появятся", "после второй волны", "интеграции"];

export function BookOverview() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");
  const [book, setBook] = useState<BookCoreDTO | null>(null);
  const [chapters, setChapters] = useState<BookChapterDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bookId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [bookResponse, chaptersResponse] = await Promise.all([
          getBook(bookId),
          getBookChapters(bookId),
        ]);
        if (!active) return;
        setBook(bookResponse);
        setChapters(chaptersResponse);
      } catch (loadError) {
        if (!active) return;
        const message = loadError instanceof Error ? loadError.message : "Не удалось загрузить книгу";
        setError(message);
        setBook(null);
        setChapters([]);
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
  }, [bookId]);

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12">
        {loading && (
          <div className="pt-12 text-muted-foreground">Загрузка книги...</div>
        )}

        {error && !loading && (
          <div className="pt-12 p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error}
          </div>
        )}

        {book && !loading && (
          <>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-8 lg:mb-12 pt-8 lg:pt-12"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-3xl lg:text-4xl text-foreground mb-2">{book.title}</h1>
                  <p className="text-lg lg:text-xl text-muted-foreground">{displayAuthor(book.author)}</p>
                </div>
                <BookSettings
                  book={book}
                  onBookUpdated={(updatedBook) => {
                    setBook(updatedBook);
                  }}
                />
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-12"
            >
              <div className="p-6 bg-card border border-border rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <BookOpen className="w-5 h-5 text-primary" />
                  <span className="text-2xl text-foreground">{book.chapterCount}</span>
                </div>
                <p className="text-sm text-muted-foreground">Глав</p>
              </div>

              <div className="p-6 bg-card border border-border rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <Users className="w-5 h-5 text-primary" />
                  <span className="text-2xl text-foreground">0</span>
                </div>
                <p className="text-sm text-muted-foreground">Персонажей</p>
              </div>

              <div className="p-6 bg-card border border-border rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <Lightbulb className="w-5 h-5 text-primary" />
                  <span className="text-2xl text-foreground">0</span>
                </div>
                <p className="text-sm text-muted-foreground">Тем</p>
              </div>

              <div className="p-6 bg-card border border-border rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <MapPin className="w-5 h-5 text-primary" />
                  <span className="text-2xl text-foreground">0</span>
                </div>
                <p className="text-sm text-muted-foreground">Локаций</p>
              </div>

              <Link href={`/book/${bookId}/quotes`} className="p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors">
                <div className="flex items-center gap-3 mb-2">
                  <Quote className="w-5 h-5 text-primary" />
                  <span className="text-2xl text-foreground">0</span>
                </div>
                <p className="text-sm text-muted-foreground">Цитат</p>
              </Link>
            </motion.div>

            <div className="space-y-12">
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
              >
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl text-foreground">Персонажи</h2>
                  <Link
                    href={`/book/${bookId}/characters`}
                    className="text-sm text-primary hover:underline flex items-center gap-1"
                  >
                    Все персонажи
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {PLACEHOLDER_CHARACTERS.map((item, index) => (
                    <motion.div
                      key={item}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.3 + index * 0.1 }}
                      className="block p-5 bg-card border border-border rounded-lg"
                    >
                      <h3 className="text-lg text-foreground mb-3">{item}</h3>
                      <p className="text-sm text-muted-foreground">Детали персонажей появятся после следующего этапа интеграции.</p>
                    </motion.div>
                  ))}
                </div>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
              >
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl text-foreground">Темы</h2>
                  <Link
                    href={`/book/${bookId}/themes`}
                    className="text-sm text-primary hover:underline flex items-center gap-1"
                  >
                    Все темы
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>

                <div className="space-y-4">
                  {PLACEHOLDER_THEMES.map((item, index) => (
                    <motion.div
                      key={item}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.5 + index * 0.1 }}
                      className="block p-5 bg-card border border-border rounded-lg"
                    >
                      <h3 className="text-lg text-foreground mb-2">{item}</h3>
                      <p className="text-sm text-muted-foreground">Контент тематического анализа пока отображается как заглушка.</p>
                    </motion.div>
                  ))}
                </div>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.6 }}
              >
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl text-foreground">Локации</h2>
                  <Link
                    href={`/book/${bookId}/locations`}
                    className="text-sm text-primary hover:underline flex items-center gap-1"
                  >
                    Все локации
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {PLACEHOLDER_LOCATIONS.map((item, index) => (
                    <motion.div
                      key={item}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.7 + index * 0.1 }}
                      className="block p-5 bg-card border border-border rounded-lg"
                    >
                      <h3 className="text-lg text-foreground mb-2">{item}</h3>
                      <p className="text-sm text-muted-foreground">Раздел локаций будет заполнен после подключения аналитических сущностей.</p>
                    </motion.div>
                  ))}
                </div>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8 }}
              >
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl text-foreground">Структура произведения</h2>
                </div>

                <div className="space-y-3">
                  {chapters.length > 0 ? (
                    chapters.map((chapter, index) => (
                      <motion.div
                        key={chapter.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.9 + index * 0.1 }}
                        className="flex items-start gap-4 p-4 bg-card border border-border rounded-lg"
                      >
                        <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                          <span className="text-sm text-primary">{chapter.orderIndex}</span>
                        </div>
                        <div className="flex-1">
                          <h3 className="text-foreground mb-1">{chapter.title}</h3>
                          {chapter.previewText ? (
                            <p className="text-sm text-muted-foreground line-clamp-2">{chapter.previewText}</p>
                          ) : null}
                        </div>
                      </motion.div>
                    ))
                  ) : (
                    <motion.div
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.9 }}
                      className="flex items-start gap-4 p-4 bg-card border border-border rounded-lg"
                    >
                      <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                        <span className="text-sm text-primary">1</span>
                      </div>
                      <div className="flex-1">
                        <h3 className="text-foreground mb-1">Структура пока недоступна</h3>
                        <p className="text-sm text-muted-foreground">Для этой книги пока не найдено глав.</p>
                      </div>
                    </motion.div>
                  )}
                </div>
              </motion.section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
