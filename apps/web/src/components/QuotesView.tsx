"use client";

import { motion } from "motion/react";
import { Quote, Filter } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { mockQuotes, mockBooks } from "@/lib/mockData";
import { useState } from "react";
import { BookNavigation } from "./BookNavigation";

type FilterType = "all" | "character" | "theme";

export function QuotesView() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");
  const book = mockBooks.find((b) => b.id === bookId);
  const allQuotes = mockQuotes.filter((q) => q.bookId === bookId);
  const [filter, setFilter] = useState<FilterType>("all");

  if (!book) return null;

  const filteredQuotes =
    filter === "all"
      ? allQuotes
      : allQuotes.filter((q) => q.relatedTo.some((r) => r.type === filter));

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-12">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="text-4xl text-foreground mb-2">Цитаты</h1>
          <p className="text-muted-foreground">
            Короткие фрагменты текста, подтверждающие инсайты
          </p>
        </motion.div>

        {/* Filter */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="flex items-center gap-3 mb-8"
        >
          <Filter className="w-4 h-4 text-muted-foreground" />
          <div className="flex gap-2">
            <button
              onClick={() => setFilter("all")}
              className={`px-4 py-2 rounded-full text-sm transition-colors ${
                filter === "all"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-foreground hover:bg-primary/10"
              }`}
            >
              Все
            </button>
            <button
              onClick={() => setFilter("character")}
              className={`px-4 py-2 rounded-full text-sm transition-colors ${
                filter === "character"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-foreground hover:bg-primary/10"
              }`}
            >
              О персонажах
            </button>
            <button
              onClick={() => setFilter("theme")}
              className={`px-4 py-2 rounded-full text-sm transition-colors ${
                filter === "theme"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-foreground hover:bg-primary/10"
              }`}
            >
              О темах
            </button>
          </div>
        </motion.div>

        {/* Quotes List */}
        <div className="space-y-6">
          {filteredQuotes.map((quote, index) => (
            <motion.div
              key={quote.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + index * 0.05 }}
              className="p-6 bg-card border border-border rounded-lg"
            >
              <div className="flex gap-4 mb-4">
                <Quote className="w-5 h-5 text-primary flex-shrink-0 mt-1" />
                <div className="flex-1">
                  <p className="text-lg text-foreground italic leading-relaxed mb-3">{quote.text}</p>
                  <p className="text-sm text-muted-foreground mb-4">{quote.context}</p>

                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <span className="px-3 py-1 bg-secondary rounded-full text-muted-foreground">
                      Часть {quote.chapterNumber}
                    </span>

                    {quote.relatedTo.map((related, i) => (
                      <Link
                        key={i}
                        href={`/book/${bookId}/${related.type === "character" ? "character" : "theme"}/${related.id}`}
                        className="px-3 py-1 bg-secondary rounded-full text-foreground hover:bg-primary/10 transition-colors"
                      >
                        {related.type === "character" ? "👤" : "💡"} {related.name}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {filteredQuotes.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12"
          >
            <p className="text-muted-foreground">Нет цитат для выбранного фильтра</p>
          </motion.div>
        )}
      </div>
    </div>
  );
}
