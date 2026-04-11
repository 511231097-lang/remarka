"use client";

import { motion } from "motion/react";
import { Lightbulb } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { mockThemes, mockBooks } from "@/lib/mockData";
import { BookNavigation } from "./BookNavigation";

export function ThemesList() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");
  const book = mockBooks.find((b) => b.id === bookId);
  const themes = mockThemes.filter((t) => t.bookId === bookId);

  if (!book) return null;

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-12">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <h1 className="text-4xl text-foreground mb-2">Темы</h1>
          <p className="text-muted-foreground">
            {themes.length} {themes.length === 1 ? "тема" : "тем"} в произведении
          </p>
        </motion.div>

        {/* Themes List */}
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
