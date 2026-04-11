"use client";

import { motion } from "motion/react";
import { Quote, Lightbulb, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { mockThemes, mockQuotes, mockBooks } from "@/lib/mockData";
import { BookNavigation } from "./BookNavigation";

export function ThemeView() {
  const params = useParams<{ bookId: string; themeId: string }>();
  const bookId = String(params.bookId || "");
  const themeId = String(params.themeId || "");
  const theme = mockThemes.find((t) => t.id === themeId);
  const book = mockBooks.find((b) => b.id === bookId);
  const relatedQuotes = mockQuotes.filter((q) =>
    q.relatedTo.some((r) => r.type === "theme" && r.id === themeId)
  );

  if (!theme || !book) return null;

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

        {/* Theme Header */}
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

        {/* Theme Analysis */}
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

          {/* Related Quotes */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl text-foreground">Подтверждающие цитаты</h2>
              <span className="text-sm text-muted-foreground">
                {relatedQuotes.length} {relatedQuotes.length === 1 ? "цитата" : "цитаты"}
              </span>
            </div>

            <div className="space-y-4">
              {relatedQuotes.map((quote, index) => (
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
                      <span>Часть {quote.chapterNumber}</span>
                      {quote.relatedTo.length > 1 && (
                        <div className="flex items-center gap-2">
                          <span>Связано с:</span>
                          {quote.relatedTo
                            .filter((r) => r.id !== themeId)
                            .map((related, i) => (
                              <Link
                                key={i}
                                href={`/book/${bookId}/${related.type === "character" ? "character" : "theme"}/${related.id}`}
                                className="px-2 py-0.5 bg-secondary rounded hover:bg-primary/10 transition-colors"
                              >
                                {related.name}
                              </Link>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.section>
        </div>
      </div>
    </div>
  );
}
