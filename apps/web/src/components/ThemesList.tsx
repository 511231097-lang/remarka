"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookNavigation } from "./BookNavigation";
import {
  getBookAnalysisStatus,
  getBookThemes,
  type BookAnalyzerStatusDTO,
} from "@/lib/booksClient";
import type { ThemeListItemDTO } from "@/lib/books";

function resolveThemesState(status: BookAnalyzerStatusDTO | null): "queued" | "running" | "completed" | "failed" | "not_requested" {
  if (!status) return "not_requested";
  return status.state;
}

export function ThemesList() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");

  const [themes, setThemes] = useState<ThemeListItemDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [themesState, setThemesState] = useState<"queued" | "running" | "completed" | "failed" | "not_requested">("not_requested");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bookId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [themesResponse, statusResponse] = await Promise.all([
          getBookThemes(bookId),
          getBookAnalysisStatus(bookId),
        ]);
        if (!active) return;

        setThemes(themesResponse.items);
        setTotal(themesResponse.total);
        setThemesState(resolveThemesState(statusResponse.views.themes));
      } catch (loadError) {
        if (!active) return;
        const message = loadError instanceof Error ? loadError.message : "Не удалось загрузить темы";
        setError(message);
        setThemes([]);
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
    if (themesState !== "queued" && themesState !== "running") return;

    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (delayMs: number) => {
      pollTimer = setTimeout(() => {
        void pollOnce();
      }, Math.max(1000, delayMs));
    };

    async function refreshThemes(): Promise<void> {
      try {
        const themesResponse = await getBookThemes(bookId);
        if (!active) return;
        setThemes(themesResponse.items);
        setTotal(themesResponse.total);
      } catch {
        // Keep existing view; next poll will retry.
      }
    }

    async function pollOnce() {
      try {
        const status = await getBookAnalysisStatus(bookId);
        if (!active) return;

        const nextState = resolveThemesState(status.views.themes);
        setThemesState(nextState);

        if (nextState === "queued" || nextState === "running") {
          schedulePoll(status.pollIntervalMs || 3000);
          return;
        }

        await refreshThemes();
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
  }, [bookId, themesState]);

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <h1 className="text-4xl text-foreground mb-2">Темы</h1>
          {loading ? (
            <p className="text-muted-foreground">Загрузка...</p>
          ) : (
            <p className="text-muted-foreground">{total} {total === 1 ? "тема" : "тем"} в произведении</p>
          )}
        </motion.div>

        {error ? (
          <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {!error && !loading && themes.length === 0 ? (
          <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
            {themesState === "queued" || themesState === "running"
              ? "Анализируем темы... список обновится автоматически."
              : themesState === "failed"
                ? "Не удалось сформировать темы для этой книги."
                : themesState === "not_requested"
                  ? "Этап тем не запускался для этой книги."
                  : "Темы для этой книги пока не найдены."}
          </div>
        ) : null}

        <div className="space-y-6">
          {themes.map((theme, index) => (
            <motion.div
              key={theme.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <Link
                href={`/book/${bookId}/theme/${theme.id}`}
                className="block p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
              >
                <h2 className="text-xl text-foreground mb-3">{theme.name}</h2>
                <p className="text-muted-foreground mb-4">{theme.description}</p>
                <div className="pt-3 border-t border-border">
                  <p className="text-sm text-muted-foreground">
                    <span className="text-foreground">Развитие:</span> {theme.development}
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
