"use client";

import { motion } from "motion/react";
import { Quote, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookNavigation } from "./BookNavigation";
import { getBookAnalysisStatus, getBookCharacter, type BookAnalyzerState } from "@/lib/booksClient";
import type { CharacterDetailDTO } from "@/lib/books";

function resolveCharactersState(value: BookAnalyzerState): BookAnalyzerState {
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

export function CharacterView() {
  const params = useParams<{ bookId: string; characterId: string }>();
  const bookId = String(params.bookId || "");
  const characterId = String(params.characterId || "");

  const [character, setCharacter] = useState<CharacterDetailDTO | null>(null);
  const [charactersState, setCharactersState] = useState<BookAnalyzerState>("not_requested");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!bookId || !characterId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      setNotFound(false);

      const [statusResult, characterResult] = await Promise.allSettled([
        getBookAnalysisStatus(bookId),
        getBookCharacter(bookId, characterId),
      ]);

      if (!active) return;

      const currentCharactersState =
        statusResult.status === "fulfilled"
          ? resolveCharactersState(statusResult.value.views.characters.state)
          : "not_requested";
      setCharactersState(currentCharactersState);

      if (characterResult.status === "fulfilled") {
        setCharacter(characterResult.value);
        setError(null);
        setNotFound(false);
      } else {
        setCharacter(null);
        if (currentCharactersState === "queued" || currentCharactersState === "running") {
          setError(null);
          setNotFound(false);
        } else {
          const message =
            characterResult.reason instanceof Error
              ? characterResult.reason.message
              : "Персонаж не найден";
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
  }, [bookId, characterId]);

  useEffect(() => {
    if (!bookId || !characterId) return;
    if (charactersState !== "queued" && charactersState !== "running") return;

    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (delayMs: number) => {
      pollTimer = setTimeout(() => {
        void pollOnce();
      }, Math.max(1000, delayMs));
    };

    const tryLoadCharacter = async (): Promise<boolean> => {
      try {
        const detail = await getBookCharacter(bookId, characterId);
        if (!active) return false;
        setCharacter(detail);
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

        const nextState = resolveCharactersState(status.views.characters.state);
        setCharactersState(nextState);
        const hasCharacter = await tryLoadCharacter();

        if (nextState === "queued" || nextState === "running") {
          schedulePoll(status.pollIntervalMs || 3000);
          return;
        }

        if (!hasCharacter) {
          setCharacter(null);
          if (nextState === "failed") {
            setError(status.views.characters.error || "Не удалось сформировать персонажей");
          } else {
            setError("Персонаж не найден");
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
  }, [bookId, characterId, charactersState]);

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-12">
        <Link
          href={`/book/${bookId}/characters-list`}
          className="text-sm text-muted-foreground hover:text-foreground mb-8 inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Все персонажи
        </Link>

        {loading ? (
          <div className="text-sm text-muted-foreground">Загрузка персонажа...</div>
        ) : null}

        {!loading && !character && (charactersState === "queued" || charactersState === "running") ? (
          <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
            Анализируем персонажей... данные появятся автоматически.
          </div>
        ) : null}

        {!loading && !character && charactersState === "failed" ? (
          <div className="p-6 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error || "Не удалось сформировать персонажей для этой книги."}
          </div>
        ) : null}

        {!loading && !character && notFound && charactersState !== "queued" && charactersState !== "running" ? (
          <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
            {error || "Персонаж не найден."}
          </div>
        ) : null}

        {character ? (
          <>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-12"
            >
              <div className="flex items-start gap-4 mb-6">
                <div className="flex-1">
                  <h1 className="text-4xl text-foreground mb-3">{character.name}</h1>
                  <span className="inline-block px-3 py-1 bg-secondary text-primary rounded-full text-sm">
                    {character.role}
                  </span>
                </div>
              </div>
            </motion.div>

            <div className="space-y-10">
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                <h2 className="text-xl text-foreground mb-4">Характеристика</h2>
                <p className="text-muted-foreground leading-relaxed">{character.description}</p>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
              >
                <h2 className="text-xl text-foreground mb-4">Развитие персонажа</h2>
                <p className="text-muted-foreground leading-relaxed">{character.arc}</p>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xl text-foreground">Связанные цитаты</h2>
                  <span className="text-sm text-muted-foreground">
                    {character.quotes.length} {character.quotes.length === 1 ? "цитата" : "цитаты"}
                  </span>
                </div>

                {character.quotes.length === 0 ? (
                  <div className="p-5 bg-card border border-border rounded-lg text-sm text-muted-foreground">
                    Для этого персонажа пока нет связанных цитат.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {character.quotes.map((quote, index) => (
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
