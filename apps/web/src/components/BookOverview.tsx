"use client";

import { motion } from "motion/react";
import {
  AlertCircle,
  ArrowRight,
  BookMarked,
  CheckCircle,
  FileText,
  Lightbulb,
  MapPin,
  Palette,
  Swords,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BookNavigation } from "./BookNavigation";
import { BookSettings } from "./BookSettings";
import { ChatPreview } from "./ChatPreview";
import { DownloadAnalysisPdfButton } from "./DownloadAnalysisPdfButton";
import {
  getBook,
  getBookAnalysisStatus,
  getBookLiteraryAnalysis,
  type BookAnalyzerState,
} from "@/lib/booksClient";
import { displayAuthor, type BookCoreDTO, type BookLiteraryAnalysisDTO, type LiterarySectionKeyDTO } from "@/lib/books";

function resolveState(value: BookAnalyzerState): BookAnalyzerState {
  if (value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "not_requested") {
    return value;
  }
  return "not_requested";
}

export function BookOverview() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");

  const [book, setBook] = useState<BookCoreDTO | null>(null);
  const [analysis, setAnalysis] = useState<BookLiteraryAnalysisDTO | null>(null);
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

      const [bookResult, statusResult, analysisResult] = await Promise.allSettled([
        getBook(bookId),
        getBookAnalysisStatus(bookId),
        getBookLiteraryAnalysis(bookId),
      ]);

      if (!active) return;

      if (bookResult.status === "fulfilled") {
        setBook(bookResult.value);
      } else {
        setBook(null);
        setError(bookResult.reason instanceof Error ? bookResult.reason.message : "Не удалось загрузить книгу");
      }

      if (statusResult.status === "fulfilled") {
        setLiteraryState(resolveState(statusResult.value.views.literary.state));
        setQuotesState(resolveState(statusResult.value.views.quotes.state));
      } else {
        setLiteraryState("not_requested");
        setQuotesState("not_requested");
      }

      if (analysisResult.status === "fulfilled") {
        setAnalysis(analysisResult.value);
      } else {
        setAnalysis(null);
      }

      setLoading(false);
    }

    void load();
    return () => {
      active = false;
    };
  }, [bookId]);

  useEffect(() => {
    if (!bookId) return;
    const shouldPoll = literaryState === "queued" || literaryState === "running" || quotesState === "queued" || quotesState === "running";
    if (!shouldPoll) return;

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
        const nextQuotesState = resolveState(status.views.quotes.state);
        setLiteraryState(nextLiteraryState);
        setQuotesState(nextQuotesState);

        if (nextLiteraryState === "completed") {
          try {
            const nextAnalysis = await getBookLiteraryAnalysis(bookId);
            if (!active) return;
            setAnalysis(nextAnalysis);
          } catch {
            // keep previous state, poll loop may continue if needed
          }
        }

        if (nextLiteraryState === "queued" || nextLiteraryState === "running" || nextQuotesState === "queued" || nextQuotesState === "running") {
          schedulePoll(status.pollIntervalMs || 3000);
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
  }, [bookId, literaryState, quotesState]);

  const sections = useMemo(
    () => [
      {
        key: "what_is_really_going_on" as const,
        title: "Что на самом деле происходит",
        icon: FileText,
        path: `/book/${bookId}/what-is-really-going-on`,
      },
      { key: "main_idea" as const, title: "Главная идея", icon: Lightbulb, path: `/book/${bookId}/main-idea` },
      { key: "how_it_works" as const, title: "Как это работает", icon: BookMarked, path: `/book/${bookId}/how-it-works` },
      { key: "hidden_details" as const, title: "Скрытые детали", icon: User, path: `/book/${bookId}/hidden-details` },
      { key: "characters" as const, title: "Персонажи", icon: Users, path: `/book/${bookId}/characters` },
      { key: "conflicts" as const, title: "Конфликты", icon: Swords, path: `/book/${bookId}/conflicts` },
      { key: "structure" as const, title: "Структура", icon: MapPin, path: `/book/${bookId}/structure` },
      { key: "important_turns" as const, title: "Важные повороты", icon: Palette, path: `/book/${bookId}/important-turns` },
      { key: "takeaways" as const, title: "Что важно вынести", icon: AlertCircle, path: `/book/${bookId}/takeaways` },
      { key: "conclusion" as const, title: "Вывод", icon: CheckCircle, path: `/book/${bookId}/conclusion` },
    ],
    [bookId]
  );

  const previewByKey = useMemo(() => {
    const map = new Map<LiterarySectionKeyDTO, string>();
    if (analysis) {
      for (const section of sections) {
        const summary = analysis.sections[section.key]?.summary || "";
        if (summary) map.set(section.key, summary);
      }
    }

    const fallbackText =
      literaryState === "failed"
        ? "Не удалось сформировать раздел"
        : literaryState === "queued" || literaryState === "running"
          ? "Раздел формируется..."
          : quotesState === "queued" || quotesState === "running"
            ? "Сначала формируем слой цитат..."
            : "Раздел пока недоступен";

    for (const section of sections) {
      if (!map.has(section.key)) {
        map.set(section.key, fallbackText);
      }
    }

    return map;
  }, [analysis, literaryState, quotesState, sections]);

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
      <div className="max-w-6xl mx-auto px-6 pb-12">
        {loading ? <div className="pt-12 text-muted-foreground">Загрузка книги...</div> : null}

        {error && !loading ? (
          <div className="pt-12 p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {book && !loading ? (
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
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mb-12"
            >
              <ChatPreview bookId={bookId} bookTitle={book.title} />
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {sections.map((section, index) => (
                <motion.div
                  key={section.path}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + index * 0.05 }}
                >
                  <Link
                    href={section.path}
                    className="group block p-5 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors h-full"
                  >
                    <div className="flex items-start gap-4 mb-3">
                      <div className="p-2 bg-secondary rounded-lg flex-shrink-0">
                        <section.icon className="w-5 h-5 text-primary" />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-lg text-foreground mb-2 flex items-center gap-2">
                          {section.title}
                          <ArrowRight className="w-4 h-4 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                        </h3>
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          {previewByKey.get(section.key)}
                        </p>
                      </div>
                    </div>
                  </Link>
                </motion.div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
