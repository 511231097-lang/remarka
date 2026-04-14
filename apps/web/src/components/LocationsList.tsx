"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookNavigation } from "./BookNavigation";
import {
  getBookAnalysisStatus,
  getBookLocations,
  type BookAnalyzerStatusDTO,
} from "@/lib/booksClient";
import type { LocationListItemDTO } from "@/lib/books";

function resolveLocationsState(status: BookAnalyzerStatusDTO | null): "queued" | "running" | "completed" | "failed" | "not_requested" {
  if (!status) return "not_requested";
  return status.state;
}

export function LocationsList() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");

  const [locations, setLocations] = useState<LocationListItemDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [locationsState, setLocationsState] = useState<"queued" | "running" | "completed" | "failed" | "not_requested">("not_requested");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bookId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [locationsResponse, statusResponse] = await Promise.all([
          getBookLocations(bookId),
          getBookAnalysisStatus(bookId),
        ]);
        if (!active) return;

        setLocations(locationsResponse.items);
        setTotal(locationsResponse.total);
        setLocationsState(resolveLocationsState(statusResponse.views.locations));
      } catch (loadError) {
        if (!active) return;
        const message = loadError instanceof Error ? loadError.message : "Не удалось загрузить локации";
        setError(message);
        setLocations([]);
        setTotal(0);
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

  useEffect(() => {
    if (!bookId) return;
    if (locationsState !== "queued" && locationsState !== "running") return;

    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (delayMs: number) => {
      pollTimer = setTimeout(() => {
        void pollOnce();
      }, Math.max(1000, delayMs));
    };

    async function refreshLocations(): Promise<void> {
      try {
        const locationsResponse = await getBookLocations(bookId);
        if (!active) return;
        setLocations(locationsResponse.items);
        setTotal(locationsResponse.total);
      } catch {
        // Keep existing view; next poll will retry.
      }
    }

    async function pollOnce() {
      try {
        const status = await getBookAnalysisStatus(bookId);
        if (!active) return;

        const nextState = resolveLocationsState(status.views.locations);
        setLocationsState(nextState);

        if (nextState === "queued" || nextState === "running") {
          schedulePoll(status.pollIntervalMs || 3000);
          return;
        }

        await refreshLocations();
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
  }, [bookId, locationsState]);

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <h1 className="text-4xl text-foreground mb-2">Локации</h1>
          {loading ? (
            <p className="text-muted-foreground">Загрузка...</p>
          ) : (
            <p className="text-muted-foreground">{total} {total === 1 ? "локация" : "локаций"} в произведении</p>
          )}
        </motion.div>

        {error ? (
          <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {!error && !loading && locations.length === 0 ? (
          <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
            {locationsState === "queued" || locationsState === "running"
              ? "Анализируем локации... список обновится автоматически."
              : locationsState === "failed"
                ? "Не удалось сформировать локации для этой книги."
                : locationsState === "not_requested"
                  ? "Этап локаций не запускался для этой книги."
                  : "Локации для этой книги пока не найдены."}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4">
          {locations.map((location, index) => (
            <motion.div
              key={location.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <Link
                href={`/book/${bookId}/location/${location.id}`}
                className="block p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
              >
                <h2 className="text-xl text-foreground mb-3">{location.name}</h2>
                <p className="text-muted-foreground mb-4">{location.description}</p>
                <div className="pt-3 border-t border-border">
                  <p className="text-sm text-muted-foreground">
                    <span className="text-foreground">Значение:</span> {location.significance}
                  </p>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
