"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookNavigation } from "./BookNavigation";
import {
  getBookAnalysisStatus,
  getBookCharacters,
  type BookAnalyzerStatusDTO,
} from "@/lib/booksClient";
import type { CharacterListItemDTO } from "@/lib/books";

function resolveCharactersState(status: BookAnalyzerStatusDTO | null): "queued" | "running" | "completed" | "failed" | "not_requested" {
  if (!status) return "not_requested";
  return status.state;
}

export function CharactersList() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");

  const [characters, setCharacters] = useState<CharacterListItemDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [charactersState, setCharactersState] = useState<"queued" | "running" | "completed" | "failed" | "not_requested">("not_requested");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bookId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [charactersResponse, statusResponse] = await Promise.all([
          getBookCharacters(bookId),
          getBookAnalysisStatus(bookId),
        ]);
        if (!active) return;

        setCharacters(charactersResponse.items);
        setTotal(charactersResponse.total);
        setCharactersState(resolveCharactersState(statusResponse.views.characters));
      } catch (loadError) {
        if (!active) return;
        const message = loadError instanceof Error ? loadError.message : "Не удалось загрузить персонажей";
        setError(message);
        setCharacters([]);
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
    if (charactersState !== "queued" && charactersState !== "running") return;

    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (delayMs: number) => {
      pollTimer = setTimeout(() => {
        void pollOnce();
      }, Math.max(1000, delayMs));
    };

    async function refreshCharacters(): Promise<void> {
      try {
        const charactersResponse = await getBookCharacters(bookId);
        if (!active) return;
        setCharacters(charactersResponse.items);
        setTotal(charactersResponse.total);
      } catch {
        // Keep existing view; next poll will retry.
      }
    }

    async function pollOnce() {
      try {
        const status = await getBookAnalysisStatus(bookId);
        if (!active) return;

        const nextState = resolveCharactersState(status.views.characters);
        setCharactersState(nextState);

        if (nextState === "queued" || nextState === "running") {
          schedulePoll(status.pollIntervalMs || 3000);
          return;
        }

        await refreshCharacters();
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
  }, [bookId, charactersState]);

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <h1 className="text-4xl text-foreground mb-2">Персонажи</h1>
          {loading ? (
            <p className="text-muted-foreground">Загрузка...</p>
          ) : (
            <p className="text-muted-foreground">{total} {total === 1 ? "персонаж" : "персонажей"} в произведении</p>
          )}
        </motion.div>

        {error ? (
          <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {!error && !loading && characters.length === 0 ? (
          <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
            {charactersState === "queued" || charactersState === "running"
              ? "Анализируем персонажей... список обновится автоматически."
              : charactersState === "failed"
                ? "Не удалось сформировать персонажей для этой книги."
                : "Персонажи для этой книги пока не найдены."}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4">
          {characters.map((character, index) => (
            <motion.div
              key={character.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <Link
                href={`/book/${bookId}/character/${character.id}`}
                className="block p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
              >
                <div className="flex items-start justify-between mb-3">
                  <h2 className="text-xl text-foreground">{character.name}</h2>
                  <span className="text-xs text-muted-foreground px-3 py-1 bg-secondary rounded-full">
                    {character.role}
                  </span>
                </div>
                <p className="text-muted-foreground mb-4">{character.description}</p>
                <div className="pt-3 border-t border-border">
                  <p className="text-sm text-muted-foreground">
                    <span className="text-foreground">Развитие:</span> {character.arc}
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
