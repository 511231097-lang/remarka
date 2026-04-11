"use client";

import { motion } from "motion/react";
import { Quote, MapPin, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { mockLocations, mockQuotes, mockBooks } from "@/lib/mockData";
import { BookNavigation } from "./BookNavigation";

export function LocationView() {
  const params = useParams<{ bookId: string; locationId: string }>();
  const bookId = String(params.bookId || "");
  const locationId = String(params.locationId || "");
  const location = mockLocations.find((l) => l.id === locationId);
  const book = mockBooks.find((b) => b.id === bookId);
  const relatedQuotes = mockQuotes.filter((q) =>
    q.relatedTo.some((r) => r.type === "location" && r.id === locationId)
  );

  if (!location || !book) return null;

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

        {/* Location Header */}
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

        {/* Location Analysis */}
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

          {/* Related Quotes */}
          {relatedQuotes.length > 0 && (
            <motion.section
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl text-foreground">Связанные цитаты</h2>
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
                              .filter((r) => r.id !== locationId)
                              .map((related, i) => (
                                <Link
                                  key={i}
                                  href={`/book/${bookId}/${related.type === "character" ? "character" : related.type === "theme" ? "theme" : "location"}/${related.id}`}
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
          )}
        </div>
      </div>
    </div>
  );
}
