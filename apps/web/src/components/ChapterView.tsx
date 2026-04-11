"use client";

import { motion } from "motion/react";
import { BookOpen, Users, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { mockChapters, mockBooks, mockCharacters } from "@/lib/mockData";
import { BookNavigation } from "./BookNavigation";

export function ChapterView() {
  const params = useParams<{ bookId: string; chapterId: string }>();
  const bookId = String(params.bookId || "");
  const chapterId = String(params.chapterId || "");
  const chapter = mockChapters.find((c) => c.id === chapterId);
  const book = mockBooks.find((b) => b.id === bookId);

  if (!chapter || !book) return null;

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-12">
        <Link
          href={`/book/${bookId}`}
          className="text-sm text-muted-foreground hover:text-foreground mb-8 inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Обзор книги
        </Link>

        {/* Chapter Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <div className="flex items-start gap-4 mb-6">
            <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
              <span className="text-xl text-primary">{chapter.number}</span>
            </div>
            <div className="flex-1">
              <h1 className="text-4xl text-foreground">{chapter.title}</h1>
            </div>
          </div>
        </motion.div>

        {/* Chapter Content */}
        <div className="space-y-10">
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <h2 className="text-xl text-foreground mb-4">Краткое содержание</h2>
            <p className="text-muted-foreground leading-relaxed">{chapter.summary}</p>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <h2 className="text-xl text-foreground mb-4">Ключевые события</h2>
            <div className="space-y-3">
              {chapter.keyEvents.map((event, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3 + index * 0.1 }}
                  className="flex gap-3"
                >
                  <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  </div>
                  <p className="text-muted-foreground">{event}</p>
                </motion.div>
              ))}
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
          >
            <h2 className="text-xl text-foreground mb-4">Действующие персонажи</h2>
            <div className="flex flex-wrap gap-2">
              {chapter.charactersAppearing.map((charName, index) => {
                const character = mockCharacters.find((c) => c.name === charName && c.bookId === bookId);
                return (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.6 + index * 0.05 }}
                  >
                    {character ? (
                      <Link
                        href={`/book/${bookId}/character/${character.id}`}
                        className="px-4 py-2 bg-card border border-border rounded-full hover:border-primary/30 transition-colors text-sm text-foreground"
                      >
                        {charName}
                      </Link>
                    ) : (
                      <span className="px-4 py-2 bg-card border border-border rounded-full text-sm text-foreground">
                        {charName}
                      </span>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </motion.section>
        </div>
      </div>
    </div>
  );
}
