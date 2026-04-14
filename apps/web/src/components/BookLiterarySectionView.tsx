"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Quote } from "lucide-react";
import { AnalysisNavigation } from "./AnalysisNavigation";
import { BookNavigation } from "./BookNavigation";
import { BookSettings } from "./BookSettings";
import { ChatPanel } from "./ChatPanel";
import { DownloadAnalysisPdfButton } from "./DownloadAnalysisPdfButton";
import {
  getBook,
  getBookAnalysisStatus,
  getBookLiterarySection,
  type BookAnalyzerState,
} from "@/lib/booksClient";
import type { BookCoreDTO, BookLiterarySectionDTO, LiterarySectionKeyDTO } from "@/lib/books";

interface BookLiterarySectionViewProps {
  sectionKey: LiterarySectionKeyDTO;
  sectionTitle: string;
}

const RELATED_SECTIONS: Record<LiterarySectionKeyDTO, Array<{ key: LiterarySectionKeyDTO; label: string; href: string }>> = {
  what_is_really_going_on: [
    { key: "main_idea", label: "Главная идея", href: "main-idea" },
    { key: "structure", label: "Структура", href: "structure" },
  ],
  main_idea: [
    { key: "how_it_works", label: "Как это работает", href: "how-it-works" },
    { key: "takeaways", label: "Что важно вынести", href: "takeaways" },
  ],
  how_it_works: [
    { key: "conflicts", label: "Конфликты", href: "conflicts" },
    { key: "hidden_details", label: "Скрытые детали", href: "hidden-details" },
  ],
  hidden_details: [
    { key: "important_turns", label: "Важные повороты", href: "important-turns" },
    { key: "how_it_works", label: "Как это работает", href: "how-it-works" },
  ],
  characters: [
    { key: "conflicts", label: "Конфликты", href: "conflicts" },
    { key: "important_turns", label: "Важные повороты", href: "important-turns" },
  ],
  conflicts: [
    { key: "characters", label: "Персонажи", href: "characters" },
    { key: "how_it_works", label: "Как это работает", href: "how-it-works" },
  ],
  structure: [
    { key: "important_turns", label: "Важные повороты", href: "important-turns" },
    { key: "what_is_really_going_on", label: "Что на самом деле происходит", href: "what-is-really-going-on" },
  ],
  important_turns: [
    { key: "structure", label: "Структура", href: "structure" },
    { key: "hidden_details", label: "Скрытые детали", href: "hidden-details" },
  ],
  takeaways: [
    { key: "main_idea", label: "Главная идея", href: "main-idea" },
    { key: "conclusion", label: "Вывод", href: "conclusion" },
  ],
  conclusion: [
    { key: "takeaways", label: "Что важно вынести", href: "takeaways" },
    { key: "main_idea", label: "Главная идея", href: "main-idea" },
  ],
};

function resolveState(value: BookAnalyzerState): BookAnalyzerState {
  if (value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "not_requested") {
    return value;
  }
  return "not_requested";
}

export function BookLiterarySectionView({ sectionKey, sectionTitle }: BookLiterarySectionViewProps) {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");

  const [book, setBook] = useState<BookCoreDTO | null>(null);
  const [section, setSection] = useState<BookLiterarySectionDTO | null>(null);
  const [literaryState, setLiteraryState] = useState<BookAnalyzerState>("not_requested");
  const [quotesState, setQuotesState] = useState<BookAnalyzerState>("not_requested");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bookId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);

      const [bookResult, statusResult, sectionResult] = await Promise.allSettled([
        getBook(bookId),
        getBookAnalysisStatus(bookId),
        getBookLiterarySection(bookId, sectionKey),
      ]);

      if (!active) return;

      if (bookResult.status === "fulfilled") {
        setBook(bookResult.value);
      } else {
        setBook(null);
      }

      if (statusResult.status === "fulfilled") {
        setLiteraryState(resolveState(statusResult.value.views.literary.state));
        setQuotesState(resolveState(statusResult.value.views.quotes.state));
      } else {
        setLiteraryState("not_requested");
        setQuotesState("not_requested");
      }

      if (sectionResult.status === "fulfilled") {
        setSection(sectionResult.value);
        setError(null);
      } else {
        setSection(null);
        const message = sectionResult.reason instanceof Error ? sectionResult.reason.message : "Не удалось загрузить раздел";
        setError(message);
      }

      setLoading(false);
    }

    void load();
    return () => {
      active = false;
    };
  }, [bookId, sectionKey]);

  useEffect(() => {
    if (!bookId) return;
    if (literaryState !== "queued" && literaryState !== "running") return;

    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (delayMs: number) => {
      pollTimer = setTimeout(() => {
        void pollOnce();
      }, Math.max(1000, delayMs));
    };

    async function pollOnce() {
      try {
        const status = await getBookAnalysisStatus(bookId);
        if (!active) return;

        const nextLiteraryState = resolveState(status.views.literary.state);
        setLiteraryState(nextLiteraryState);
        setQuotesState(resolveState(status.views.quotes.state));

        if (nextLiteraryState === "queued" || nextLiteraryState === "running") {
          schedulePoll(status.pollIntervalMs || 3000);
          return;
        }

        if (nextLiteraryState === "completed") {
          try {
            const nextSection = await getBookLiterarySection(bookId, sectionKey);
            if (!active) return;
            setSection(nextSection);
            setError(null);
          } catch (loadError) {
            if (!active) return;
            const message = loadError instanceof Error ? loadError.message : "Не удалось загрузить раздел";
            setError(message);
          }
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
  }, [bookId, sectionKey, literaryState]);

  const relatedSections = useMemo(() => RELATED_SECTIONS[sectionKey], [sectionKey]);
  const downloadDisabledReason = useMemo(() => {
    if (literaryState === "completed") return null;
    if (literaryState === "queued" || literaryState === "running") {
      return "Литературный анализ еще формируется";
    }
    if (quotesState === "queued" || quotesState === "running") {
      return "Сначала формируется слой цитат";
    }
    if (literaryState === "failed") {
      return "Экспорт станет доступен после успешного анализа";
    }
    return "Анализ еще недоступен";
  }, [literaryState, quotesState]);

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="flex">
        <div className="flex-1 flex flex-col xl:flex-row">
          <div className="flex-1 px-6 py-8 lg:py-12 max-w-7xl mx-auto w-full">
            <div className="mb-8 lg:mb-12">
              <Link
                href={`/book/${bookId}`}
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
              >
                <ArrowLeft className="w-4 h-4" />
                Назад к обзору
              </Link>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl lg:text-3xl text-foreground mb-1">{book?.title || "Книга"}</h1>
                  <p className="text-muted-foreground">{book?.author || ""}</p>
                </div>
                {book ? (
                  <div className="flex items-center gap-2">
                    <DownloadAnalysisPdfButton
                      bookId={bookId}
                      disabled={Boolean(downloadDisabledReason)}
                      disabledReason={downloadDisabledReason || undefined}
                    />
                    <BookSettings
                      book={book}
                      onBookUpdated={(updatedBook) => {
                        setBook(updatedBook);
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col xl:flex-row gap-8 xl:gap-12">
              <AnalysisNavigation />

              <div className="flex-1 min-w-0">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <h2 className="text-3xl lg:text-4xl text-foreground mb-8 lg:mb-12">{sectionTitle}</h2>

                  {loading ? (
                    <div className="text-sm text-muted-foreground">Загрузка раздела...</div>
                  ) : null}

                  {!loading && !section && (literaryState === "queued" || literaryState === "running") ? (
                    <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
                      Формируем литературный анализ... раздел появится автоматически.
                    </div>
                  ) : null}

                  {!loading && !section && literaryState !== "queued" && literaryState !== "running" ? (
                    <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
                      {error ||
                        (literaryState === "failed"
                          ? "Не удалось сформировать литературный анализ для этой книги."
                          : quotesState === "queued" || quotesState === "running"
                            ? "Слой цитат еще в обработке, раздел появится позже."
                            : "Раздел пока недоступен.")}
                    </div>
                  ) : null}

                  {section ? (
                    <div className="space-y-8">
                      <section>
                        <h3 className="text-xl text-foreground mb-4">Кратко</h3>
                        <p className="text-muted-foreground leading-relaxed">{section.summary}</p>
                      </section>

                      <section>
                        <h3 className="text-xl text-foreground mb-4">Разбор</h3>
                        <p className="text-muted-foreground leading-relaxed whitespace-pre-line">{section.bodyMarkdown}</p>
                      </section>

                      {section.bullets.length > 0 ? (
                        <section>
                          <h3 className="text-xl text-foreground mb-4">Ключевые тезисы</h3>
                          <ul className="space-y-2 text-muted-foreground leading-relaxed">
                            {section.bullets.map((bullet, index) => (
                              <li key={`${section.key}-bullet-${index}`} className="flex items-start gap-2">
                                <span className="text-primary">•</span>
                                <span>{bullet}</span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}

                      {section.evidenceQuotes && section.evidenceQuotes.length > 0 ? (
                        <section>
                          <h3 className="text-xl text-foreground mb-4">Цитаты-основания</h3>
                          <div className="space-y-4">
                            {section.evidenceQuotes.slice(0, 8).map((quote) => (
                              <div key={`${section.key}-${quote.id}`} className="p-5 bg-card border border-border rounded-lg">
                                <div className="flex gap-3 mb-3">
                                  <Quote className="w-5 h-5 text-primary flex-shrink-0 mt-1" />
                                  <p className="text-foreground italic leading-relaxed">{quote.text}</p>
                                </div>
                                <div className="ml-8 text-xs text-muted-foreground">Глава {quote.chapterOrderIndex}</div>
                              </div>
                            ))}
                          </div>
                        </section>
                      ) : null}

                      <div className="mt-12 pt-8 border-t border-border">
                        <h3 className="text-sm font-medium text-muted-foreground mb-4">Связанные разделы</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {relatedSections.map((item) => (
                            <Link
                              key={`${section.key}-${item.key}`}
                              href={`/book/${bookId}/${item.href}`}
                              className="flex items-center justify-between p-4 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
                            >
                              <span className="text-sm text-foreground">{item.label}</span>
                              <ArrowRight className="w-4 h-4 text-muted-foreground" />
                            </Link>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </motion.div>
              </div>
            </div>
          </div>

          <ChatPanel bookTitle={book?.title} sectionKey={sectionKey} />
        </div>
      </div>
    </div>
  );
}
