"use client";

import { motion } from "motion/react";
import { Quote, Filter, Search } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  getBookAnalysisStatus,
  getBookQuotes,
  type BookAnalyzerState,
  type BookQuotesSort,
} from "@/lib/booksClient";
import type {
  BookQuoteDetailDTO,
  BookQuoteListItemDTO,
  BookQuoteMentionKindDTO,
  BookQuoteTagDTO,
  BookQuoteTypeDTO,
} from "@/lib/books";
import { BookNavigation } from "./BookNavigation";

const QUOTE_TYPE_OPTIONS: Array<{ value: BookQuoteTypeDTO; label: string }> = [
  { value: "dialogue", label: "Диалог" },
  { value: "monologue", label: "Монолог" },
  { value: "narration", label: "Повествование" },
  { value: "description", label: "Описание" },
  { value: "reflection", label: "Размышление" },
  { value: "action", label: "Действие" },
];

const QUOTE_TAG_OPTIONS: Array<{ value: BookQuoteTagDTO; label: string }> = [
  { value: "conflict", label: "Конфликт" },
  { value: "relationship", label: "Отношения" },
  { value: "identity", label: "Идентичность" },
  { value: "morality", label: "Мораль" },
  { value: "power", label: "Власть" },
  { value: "freedom", label: "Свобода" },
  { value: "fear", label: "Страх" },
  { value: "guilt", label: "Вина" },
  { value: "hope", label: "Надежда" },
  { value: "fate", label: "Судьба" },
  { value: "society", label: "Общество" },
  { value: "violence", label: "Насилие" },
  { value: "love", label: "Любовь" },
  { value: "death", label: "Смерть" },
  { value: "faith", label: "Вера" },
];

const MENTION_KIND_OPTIONS: Array<{ value: BookQuoteMentionKindDTO; label: string }> = [
  { value: "character", label: "Персонаж" },
  { value: "theme", label: "Тема" },
  { value: "location", label: "Локация" },
];

function resolveQuotesState(value: BookAnalyzerState): BookAnalyzerState {
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

function quoteTypeLabel(type: BookQuoteTypeDTO): string {
  return QUOTE_TYPE_OPTIONS.find((item) => item.value === type)?.label || type;
}

function quoteTagLabel(tag: BookQuoteTagDTO): string {
  return QUOTE_TAG_OPTIONS.find((item) => item.value === tag)?.label || tag;
}

function mentionKindLabel(kind: BookQuoteMentionKindDTO): string {
  return MENTION_KIND_OPTIONS.find((item) => item.value === kind)?.label || kind;
}

export function QuotesView() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");

  const [query, setQuery] = useState("");
  const [chapter, setChapter] = useState("");
  const [type, setType] = useState<"" | BookQuoteTypeDTO>("");
  const [tag, setTag] = useState<"" | BookQuoteTagDTO>("");
  const [mentionKind, setMentionKind] = useState<"" | BookQuoteMentionKindDTO>("");
  const [mentionValue, setMentionValue] = useState("");
  const [confidenceGte, setConfidenceGte] = useState("");
  const [sort, setSort] = useState<BookQuotesSort>("chapter_asc");

  const [quotes, setQuotes] = useState<BookQuoteListItemDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedQuote, setSelectedQuote] = useState<BookQuoteDetailDTO | null>(null);
  const [quotesState, setQuotesState] = useState<BookAnalyzerState>("not_requested");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const chapterNumber = useMemo(() => {
    const parsed = Number.parseInt(chapter.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed;
  }, [chapter]);

  const confidenceThreshold = useMemo(() => {
    const parsed = Number.parseFloat(confidenceGte.trim());
    if (!Number.isFinite(parsed)) return undefined;
    return Math.max(0, Math.min(1, parsed));
  }, [confidenceGte]);

  useEffect(() => {
    if (!bookId) return;
    let active = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [quotesResponse, statusResponse] = await Promise.all([
          getBookQuotes(bookId, {
            page: 1,
            pageSize: 120,
            chapter: chapterNumber,
            type: type || undefined,
            tag: tag || undefined,
            mentionKind: mentionKind || undefined,
            mentionValue: mentionValue || undefined,
            confidenceGte: confidenceThreshold,
            q: query || undefined,
            sort,
          }),
          getBookAnalysisStatus(bookId),
        ]);
        if (!active) return;

        setQuotes(quotesResponse.items);
        setTotal(quotesResponse.total);
        setQuotesState(resolveQuotesState(statusResponse.views.quotes.state));

        if (quotesResponse.items.length === 0) {
          setSelectedQuote(null);
        } else {
          setSelectedQuote((current) => {
            const existingId = current?.id;
            const next =
              quotesResponse.items.find((quote) => quote.id === existingId) || quotesResponse.items[0];
            return {
              ...next,
              retrievalScore: null,
            };
          });
        }
      } catch (loadError) {
        if (!active) return;
        const message = loadError instanceof Error ? loadError.message : "Не удалось загрузить цитаты";
        setError(message);
        setQuotes([]);
        setTotal(0);
        setSelectedQuote(null);
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
  }, [
    bookId,
    chapterNumber,
    type,
    tag,
    mentionKind,
    mentionValue,
    confidenceThreshold,
    query,
    sort,
    reloadToken,
  ]);

  useEffect(() => {
    if (!bookId) return;
    if (quotesState !== "queued" && quotesState !== "running") return;

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

        const nextState = resolveQuotesState(status.views.quotes.state);
        setQuotesState(nextState);
        setReloadToken((value) => value + 1);

        if (nextState === "queued" || nextState === "running") {
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
  }, [bookId, quotesState]);

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-4xl text-foreground mb-2">Цитаты</h1>
          <p className="text-muted-foreground">
            Автономный слой цитат и разметки книги для последующего строгого quote-only анализа
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="p-4 bg-card border border-border rounded-lg mb-6"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <label className="flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-md">
              <Search className="w-4 h-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Поиск по тексту"
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            </label>

            <input
              value={chapter}
              onChange={(event) => setChapter(event.target.value)}
              placeholder="Глава (номер)"
              inputMode="numeric"
              className="px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />

            <select
              value={type}
              onChange={(event) => setType(event.target.value as "" | BookQuoteTypeDTO)}
              className="px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground focus:outline-none"
            >
              <option value="">Тип цитаты: все</option>
              {QUOTE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>

            <select
              value={tag}
              onChange={(event) => setTag(event.target.value as "" | BookQuoteTagDTO)}
              className="px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground focus:outline-none"
            >
              <option value="">Тег: все</option>
              {QUOTE_TAG_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <select
              value={mentionKind}
              onChange={(event) => setMentionKind(event.target.value as "" | BookQuoteMentionKindDTO)}
              className="px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground focus:outline-none"
            >
              <option value="">Mention kind: любой</option>
              {MENTION_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>

            <input
              value={mentionValue}
              onChange={(event) => setMentionValue(event.target.value)}
              placeholder="Mention value"
              className="px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />

            <input
              value={confidenceGte}
              onChange={(event) => setConfidenceGte(event.target.value)}
              placeholder="Confidence >= (0..1)"
              inputMode="decimal"
              className="px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />

            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as BookQuotesSort)}
                className="flex-1 px-3 py-2 bg-background border border-border rounded-md text-sm text-foreground focus:outline-none"
              >
                <option value="chapter_asc">Сортировка: по главам</option>
                <option value="confidence_desc">Сортировка: confidence</option>
              </select>
            </div>
          </div>
        </motion.div>

        {loading ? (
          <div className="text-sm text-muted-foreground">Загрузка цитат...</div>
        ) : null}

        {!loading && error ? (
          <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {!loading && !error && quotes.length === 0 ? (
          <div className="p-6 bg-card border border-border rounded-lg text-sm text-muted-foreground">
            {quotesState === "queued" || quotesState === "running"
              ? "Анализируем цитаты... список появится автоматически."
              : quotesState === "failed"
                ? "Не удалось построить слой цитат для этой книги."
                : quotesState === "not_requested"
                  ? "Этап цитат не запускался для этой книги."
                  : "По текущим фильтрам цитаты не найдены."}
          </div>
        ) : null}

        {!loading && !error && quotes.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
            <div>
              <div className="text-sm text-muted-foreground mb-3">Показано: {quotes.length} из {total}</div>
              <div className="space-y-4">
                {quotes.map((quote, index) => {
                  const active = selectedQuote?.id === quote.id;
                  return (
                    <motion.button
                      key={quote.id}
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.03 }}
                      onClick={() =>
                        setSelectedQuote({
                          ...quote,
                          retrievalScore: null,
                        })
                      }
                      className={`w-full text-left p-5 bg-card border rounded-lg transition-colors ${
                        active ? "border-primary" : "border-border hover:border-primary/30"
                      }`}
                    >
                      <div className="flex gap-3 mb-3">
                        <Quote className="w-5 h-5 text-primary flex-shrink-0 mt-1" />
                        <p className="text-foreground italic leading-relaxed">{quote.text}</p>
                      </div>

                      <div className="ml-8 space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="px-2 py-1 bg-secondary rounded-full text-muted-foreground">
                            Глава {quote.chapterOrderIndex}
                          </span>
                          <span className="px-2 py-1 bg-secondary rounded-full text-muted-foreground">
                            {quoteTypeLabel(quote.type)}
                          </span>
                          <span className="px-2 py-1 bg-secondary rounded-full text-muted-foreground">
                            conf {quote.confidence.toFixed(2)}
                          </span>
                        </div>

                        {quote.tags.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            {quote.tags.map((quoteTag) => (
                              <span
                                key={`${quote.id}-${quoteTag}`}
                                className="px-2 py-1 bg-primary/10 text-primary rounded-full"
                              >
                                {quoteTagLabel(quoteTag)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </div>

            <aside className="lg:sticky lg:top-24 h-fit">
              {selectedQuote ? (
                <div className="p-5 bg-card border border-border rounded-lg">
                  <h2 className="text-lg text-foreground mb-3">Карточка цитаты</h2>

                  <p className="text-foreground italic leading-relaxed mb-4">{selectedQuote.text}</p>

                  <div className="space-y-2 text-sm text-muted-foreground mb-4">
                    <p><span className="text-foreground">Глава:</span> {selectedQuote.chapterOrderIndex}</p>
                    <p><span className="text-foreground">Span:</span> {selectedQuote.startChar}..{selectedQuote.endChar}</p>
                    <p><span className="text-foreground">Тип:</span> {quoteTypeLabel(selectedQuote.type)}</p>
                    <p><span className="text-foreground">Confidence:</span> {selectedQuote.confidence.toFixed(2)}</p>
                  </div>

                  {selectedQuote.commentary ? (
                    <div className="mb-4">
                      <p className="text-sm text-foreground mb-1">Комментарий</p>
                      <p className="text-sm text-muted-foreground">{selectedQuote.commentary}</p>
                    </div>
                  ) : null}

                  {selectedQuote.tags.length > 0 ? (
                    <div className="mb-4">
                      <p className="text-sm text-foreground mb-2">Теги</p>
                      <div className="flex flex-wrap gap-2">
                        {selectedQuote.tags.map((quoteTag) => (
                          <span key={`selected-${quoteTag}`} className="px-2 py-1 bg-secondary rounded-full text-xs text-muted-foreground">
                            {quoteTagLabel(quoteTag)}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {selectedQuote.mentions.length > 0 ? (
                    <div>
                      <p className="text-sm text-foreground mb-2">Weak labels (mentions)</p>
                      <div className="space-y-2">
                        {selectedQuote.mentions.map((mention, index) => (
                          <div key={`${selectedQuote.id}-mention-${index}`} className="text-xs text-muted-foreground p-2 bg-secondary rounded-md">
                            <div className="mb-1">
                              <span className="text-foreground">{mentionKindLabel(mention.kind)}:</span> {mention.value}
                            </div>
                            <div>
                              norm: {mention.normalizedValue} | span {mention.startChar}..{mention.endChar} | conf {mention.confidence.toFixed(2)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="p-5 bg-card border border-border rounded-lg text-sm text-muted-foreground">
                  Выберите цитату, чтобы посмотреть полную карточку.
                </div>
              )}
            </aside>
          </div>
        ) : null}
      </div>
    </div>
  );
}
