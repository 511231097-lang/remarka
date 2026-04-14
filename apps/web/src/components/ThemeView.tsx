"use client";

import { motion } from "motion/react";
import { Quote, Lightbulb, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookNavigation } from "./BookNavigation";
import { getBookAnalysisStatus, getBookTheme, type BookAnalyzerState } from "@/lib/booksClient";
import type { ThemeDetailDTO } from "@/lib/books";

function resolveThemesState(value: BookAnalyzerState): BookAnalyzerState {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "not_requested"
  ) {
    return value;
  }
  return "not_requested";
}

export function ThemeView() {
  const params = useParams<{ bookId: string; themeId: string }>();
  const bookId = String(params.bookId || "");
  const themeId = String(params.themeId || "");

  const [theme, setTheme] = useState<ThemeDetailDTO | null>(null);
  const [themesState, setThemesState] = useState<BookAnalyzerState>("not_requested");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!bookId || !themeId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      setNotFound(false);

      const [statusResult, themeResult] = await Promise.allSettled([
        getBookAnalysisStatus(bookId),
        getBookTheme(bookId, themeId),
      ]);

      if (!active) return;

      const currentThemesState =
        statusResult.status === "fulfilled"
          ? resolveThemesState(statusResult.value.views.themes.state)
          : "not_requested";
      setThemesState(currentThemesState);

      if (themeResult.status === "fulfilled") {
        setTheme(themeResult.value);
        setError(null);
        setNotFound(false);
      } else {
        setTheme(null);
        if (currentThemesState === "queued" || currentThemesState === "running") {
          setError(null);
          setNotFound(false);
        } else if (currentThemesState === "not_requested") {
          setError("Этап тем не запускался для этой книги.");
          setNotFound(true);
        } else {
          const message =
            themeResult.reason instanceof Error
              ? themeResult.reason.message
              : "Тема не найдена";
          setError(message);
          setNotFound(true);
        }
      }

      setLoading(false);
    }

    void load();
    return () => {
      active = false;
    };
  }, [bookId, themeId]);

  useEffect(() => {
    if (!bookId || !themeId) return;
    if (themesState !== "queued" && themesState !== "running") return;

    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (delayMs: number) => {
      pollTimer = setTimeout(() => {
        void pollOnce();
      }, Math.max(1000, delayMs));
    };

    const tryLoadTheme = async (): Promise<boolean> => {
      try {
        const detail = await getBookTheme(bookId, themeId);
        if (!active) return false;
        setTheme(detail);
        setNotFound(false);
        setError(null);
        return true;
      } catch {
        return false;
      }
    };

    async function pollOnce() {
      try {
        const status = await getBookAnalysisStatus(bookId);
        if (!active) return;

        const nextState = resolveThemesState(status.views.themes.state);
        setThemesState(nextState);
        const hasTheme = await tryLoadTheme();

        if (nextState === "queued" || nextState === "running") {
          schedulePoll(status.pollIntervalMs || 3000);
          return;
        }

        if (!hasTheme) {
          setTheme(null);
          if (nextState === "failed") {
            setError(status.views.themes.error || "Не удалось сформировать темы");
          } else if (nextState === "not_requested") {
            setError("Этап тем не запускался для этой книги.");
          } else {
            setError("Тема не найдена");
          }
          setNotFound(true);
        }
      } catch {
        if (!active) return;
        schedulePoll(4000);
      }
    }

    schedulePoll(2000);

    return () => {
      active = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
  }, [bookId, themeId, themesState]);

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-12">
        <Link
          href={`/book/${bookId}/themes`}
          className="text-sm text-muted-foreground hover:text-foreground mb-8 inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Все темы
        </Link>

        {loading ? (
          <div className="text-sm text-muted-foreground">Загрузка темы...</div>
        ) : null}

        {!loading && !theme && (themesState === "queued" || themesState === "running") ? (
          <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
            Анализируем темы... данные появятся автоматически.
          </div>
        ) : null}

        {!loading && !theme && themesState === "failed" ? (
          <div className="p-6 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error || "Не удалось сформировать темы для этой книги."}
          </div>
        ) : null}

        {!loading && !theme && notFound && themesState !== "queued" && themesState !== "running" ? (
          <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
            {error || "Тема не найдена."}
          </div>
        ) : null}

        {theme ? (
          <>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-12"
            >
              <div className="flex items-start gap-4 mb-6">
                <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                  <Lightbulb className="w-7 h-7 text-primary" />
                </div>
                <div className="flex-1">
                  <h1 className="text-4xl text-foreground">{theme.name}</h1>
                </div>
              </div>
            </motion.div>

            <div className="space-y-10">
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                <h2 className="text-xl text-foreground mb-4">Описание темы</h2>
                <p className="text-muted-foreground leading-relaxed">{theme.description}</p>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
              >
                <h2 className="text-xl text-foreground mb-4">Развитие в произведении</h2>
                <p className="text-muted-foreground leading-relaxed">{theme.development}</p>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xl text-foreground">Подтверждающие цитаты</h2>
                  <span className="text-sm text-muted-foreground">
                    {theme.quotes.length} {theme.quotes.length === 1 ? "цитата" : "цитаты"}
                  </span>
                </div>

                {theme.quotes.length === 0 ? (
                  <div className="p-5 bg-card border border-border rounded-lg text-sm text-muted-foreground">
                    Для этой темы пока нет связанных цитат.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {theme.quotes.map((quote, index) => (
                      <motion.div
                        key={quote.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.4 + index * 0.1 }}
                        className="p-5 bg-card border border-border rounded-lg"
                      >
                        <div className="flex gap-3 mb-3">
                          <Quote className="w-5 h-5 text-primary flex-shrink-0 mt-1" />
                          <p className="text-foreground italic leading-relaxed">{quote.text}</p>
                        </div>

                        <div className="ml-8 space-y-2">
                          <p className="text-sm text-muted-foreground">{quote.context}</p>

                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span>Глава {quote.chapterOrderIndex}</span>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </motion.section>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
