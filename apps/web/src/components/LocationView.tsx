"use client";

import { motion } from "motion/react";
import { Quote, MapPin, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookNavigation } from "./BookNavigation";
import { getBookAnalysisStatus, getBookLocation, type BookAnalyzerState } from "@/lib/booksClient";
import type { LocationDetailDTO } from "@/lib/books";

function resolveLocationsState(value: BookAnalyzerState): BookAnalyzerState {
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

export function LocationView() {
  const params = useParams<{ bookId: string; locationId: string }>();
  const bookId = String(params.bookId || "");
  const locationId = String(params.locationId || "");

  const [location, setLocation] = useState<LocationDetailDTO | null>(null);
  const [locationsState, setLocationsState] = useState<BookAnalyzerState>("not_requested");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!bookId || !locationId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      setNotFound(false);

      const [statusResult, locationResult] = await Promise.allSettled([
        getBookAnalysisStatus(bookId),
        getBookLocation(bookId, locationId),
      ]);

      if (!active) return;

      const currentLocationsState =
        statusResult.status === "fulfilled"
          ? resolveLocationsState(statusResult.value.views.locations.state)
          : "not_requested";
      setLocationsState(currentLocationsState);

      if (locationResult.status === "fulfilled") {
        setLocation(locationResult.value);
        setError(null);
        setNotFound(false);
      } else {
        setLocation(null);
        if (currentLocationsState === "queued" || currentLocationsState === "running") {
          setError(null);
          setNotFound(false);
        } else if (currentLocationsState === "not_requested") {
          setError("Этап локаций не запускался для этой книги.");
          setNotFound(true);
        } else {
          const message =
            locationResult.reason instanceof Error
              ? locationResult.reason.message
              : "Локация не найдена";
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
  }, [bookId, locationId]);

  useEffect(() => {
    if (!bookId || !locationId) return;
    if (locationsState !== "queued" && locationsState !== "running") return;

    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (delayMs: number) => {
      pollTimer = setTimeout(() => {
        void pollOnce();
      }, Math.max(1000, delayMs));
    };

    const tryLoadLocation = async (): Promise<boolean> => {
      try {
        const detail = await getBookLocation(bookId, locationId);
        if (!active) return false;
        setLocation(detail);
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

        const nextState = resolveLocationsState(status.views.locations.state);
        setLocationsState(nextState);
        const hasLocation = await tryLoadLocation();

        if (nextState === "queued" || nextState === "running") {
          schedulePoll(status.pollIntervalMs || 3000);
          return;
        }

        if (!hasLocation) {
          setLocation(null);
          if (nextState === "failed") {
            setError(status.views.locations.error || "Не удалось сформировать локации");
          } else if (nextState === "not_requested") {
            setError("Этап локаций не запускался для этой книги.");
          } else {
            setError("Локация не найдена");
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
  }, [bookId, locationId, locationsState]);

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-12">
        <Link
          href={`/book/${bookId}/locations`}
          className="text-sm text-muted-foreground hover:text-foreground mb-8 inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Все локации
        </Link>

        {loading ? (
          <div className="text-sm text-muted-foreground">Загрузка локации...</div>
        ) : null}

        {!loading && !location && (locationsState === "queued" || locationsState === "running") ? (
          <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
            Анализируем локации... данные появятся автоматически.
          </div>
        ) : null}

        {!loading && !location && locationsState === "failed" ? (
          <div className="p-6 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error || "Не удалось сформировать локации для этой книги."}
          </div>
        ) : null}

        {!loading && !location && notFound && locationsState !== "queued" && locationsState !== "running" ? (
          <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
            {error || "Локация не найдена."}
          </div>
        ) : null}

        {location ? (
          <>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-12"
            >
              <div className="flex items-start gap-4 mb-6">
                <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                  <MapPin className="w-7 h-7 text-primary" />
                </div>
                <div className="flex-1">
                  <h1 className="text-4xl text-foreground">{location.name}</h1>
                </div>
              </div>
            </motion.div>

            <div className="space-y-10">
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                <h2 className="text-xl text-foreground mb-4">Описание</h2>
                <p className="text-muted-foreground leading-relaxed">{location.description}</p>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
              >
                <h2 className="text-xl text-foreground mb-4">Значение в произведении</h2>
                <p className="text-muted-foreground leading-relaxed">{location.significance}</p>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xl text-foreground">Связанные цитаты</h2>
                  <span className="text-sm text-muted-foreground">
                    {location.quotes.length} {location.quotes.length === 1 ? "цитата" : "цитаты"}
                  </span>
                </div>

                {location.quotes.length === 0 ? (
                  <div className="p-5 bg-card border border-border rounded-lg text-sm text-muted-foreground">
                    Для этой локации пока нет связанных цитат.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {location.quotes.map((quote, index) => (
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
