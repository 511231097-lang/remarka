"use client";

import { motion } from "motion/react";
import { Users, Lightbulb, BookOpen, ArrowRight, Calendar, Quote, MapPin } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { mockBooks, mockCharacters, mockThemes, mockChapters, mockQuotes, mockLocations } from "@/lib/mockData";
import { BookNavigation } from "./BookNavigation";

export function BookOverview() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");
  const book = mockBooks.find((b) => b.id === bookId);
  const characters = mockCharacters.filter((c) => c.bookId === bookId);
  const themes = mockThemes.filter((t) => t.bookId === bookId);
  const locations = mockLocations.filter((l) => l.bookId === bookId);
  const chapters = mockChapters.filter((c) => c.bookId === bookId);
  const quotes = mockQuotes.filter((q) => q.bookId === bookId);

  if (!book) return null;

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="max-w-6xl mx-auto px-6 pb-12">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 lg:mb-12 pt-8 lg:pt-12"
        >
          <h1 className="text-3xl lg:text-4xl text-foreground mb-2">{book.title}</h1>
          <p className="text-lg lg:text-xl text-muted-foreground">{book.author}</p>
        </motion.div>

        {/* Quick Stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-12"
        >
          <div className="p-6 bg-card border border-border rounded-lg">
            <div className="flex items-center gap-3 mb-2">
              <BookOpen className="w-5 h-5 text-primary" />
              <span className="text-2xl text-foreground">{book.chaptersCount}</span>
            </div>
            <p className="text-sm text-muted-foreground">Глав</p>
          </div>

          <div className="p-6 bg-card border border-border rounded-lg">
            <div className="flex items-center gap-3 mb-2">
              <Users className="w-5 h-5 text-primary" />
              <span className="text-2xl text-foreground">{book.charactersCount}</span>
            </div>
            <p className="text-sm text-muted-foreground">Персонажей</p>
          </div>

          <div className="p-6 bg-card border border-border rounded-lg">
            <div className="flex items-center gap-3 mb-2">
              <Lightbulb className="w-5 h-5 text-primary" />
              <span className="text-2xl text-foreground">{book.themesCount}</span>
            </div>
            <p className="text-sm text-muted-foreground">Тем</p>
          </div>

          <div className="p-6 bg-card border border-border rounded-lg">
            <div className="flex items-center gap-3 mb-2">
              <MapPin className="w-5 h-5 text-primary" />
              <span className="text-2xl text-foreground">{book.locationsCount}</span>
            </div>
            <p className="text-sm text-muted-foreground">Локаций</p>
          </div>

          <Link href={`/book/${bookId}/quotes`} className="p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors">
            <div className="flex items-center gap-3 mb-2">
              <Quote className="w-5 h-5 text-primary" />
              <span className="text-2xl text-foreground">{quotes.length}</span>
            </div>
            <p className="text-sm text-muted-foreground">Цитат</p>
          </Link>
        </motion.div>

        {/* Main Sections */}
        <div className="space-y-12">
          {/* Characters */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl text-foreground">Персонажи</h2>
              <Link
                href={`/book/${bookId}/characters`}
                className="text-sm text-primary hover:underline flex items-center gap-1"
              >
                Все персонажи
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {characters.slice(0, 4).map((character, index) => (
                <motion.div
                  key={character.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 + index * 0.1 }}
                >
                  <Link
                    href={`/book/${bookId}/character/${character.id}`}
                    className="block p-5 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <h3 className="text-lg text-foreground">{character.name}</h3>
                      <span className="text-xs text-muted-foreground px-2 py-1 bg-secondary rounded">
                        {character.role}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {character.description}
                    </p>
                  </Link>
                </motion.div>
              ))}
            </div>
          </motion.section>

          {/* Themes */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl text-foreground">Темы</h2>
              <Link
                href={`/book/${bookId}/themes`}
                className="text-sm text-primary hover:underline flex items-center gap-1"
              >
                Все темы
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>

            <div className="space-y-4">
              {themes.map((theme, index) => (
                <motion.div
                  key={theme.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5 + index * 0.1 }}
                >
                  <Link
                    href={`/book/${bookId}/theme/${theme.id}`}
                    className="block p-5 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
                  >
                    <h3 className="text-lg text-foreground mb-2">{theme.name}</h3>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {theme.description}
                    </p>
                  </Link>
                </motion.div>
              ))}
            </div>
          </motion.section>

          {/* Locations */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl text-foreground">Локации</h2>
              <Link
                href={`/book/${bookId}/locations`}
                className="text-sm text-primary hover:underline flex items-center gap-1"
              >
                Все локации
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {locations.slice(0, 4).map((location, index) => (
                <motion.div
                  key={location.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.7 + index * 0.1 }}
                >
                  <Link
                    href={`/book/${bookId}/location/${location.id}`}
                    className="block p-5 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
                  >
                    <h3 className="text-lg text-foreground mb-2">{location.name}</h3>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {location.description}
                    </p>
                  </Link>
                </motion.div>
              ))}
            </div>
          </motion.section>

          {/* Chapters */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8 }}
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl text-foreground">Структура произведения</h2>
            </div>

            <div className="space-y-3">
              {chapters.map((chapter, index) => (
                <motion.div
                  key={chapter.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.9 + index * 0.1 }}
                >
                  <Link
                    href={`/book/${bookId}/chapter/${chapter.id}`}
                    className="flex items-start gap-4 p-4 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                      <span className="text-sm text-primary">{chapter.number}</span>
                    </div>
                    <div className="flex-1">
                      <h3 className="text-foreground mb-1">{chapter.title}</h3>
                      <p className="text-sm text-muted-foreground line-clamp-1">{chapter.summary}</p>
                    </div>
                  </Link>
                </motion.div>
              ))}
            </div>
          </motion.section>
        </div>
      </div>
    </div>
  );
}
