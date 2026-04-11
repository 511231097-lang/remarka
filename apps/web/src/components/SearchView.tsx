"use client";

import { motion } from "motion/react";
import { Search, Users, Lightbulb, Quote, X, MapPin } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { mockCharacters, mockThemes, mockQuotes, mockBooks, mockLocations } from "@/lib/mockData";
import { BookNavigation } from "./BookNavigation";
import { useState } from "react";

export function SearchView() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");
  const book = mockBooks.find((b) => b.id === bookId);
  const [searchQuery, setSearchQuery] = useState("");

  const allCharacters = mockCharacters.filter((c) => c.bookId === bookId);
  const allThemes = mockThemes.filter((t) => t.bookId === bookId);
  const allLocations = mockLocations.filter((l) => l.bookId === bookId);
  const allQuotes = mockQuotes.filter((q) => q.bookId === bookId);

  const filteredCharacters = allCharacters.filter((c) =>
    searchQuery === "" ||
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.role.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredThemes = allThemes.filter((t) =>
    searchQuery === "" ||
    t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredLocations = allLocations.filter((l) =>
    searchQuery === "" ||
    l.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    l.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    l.significance.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredQuotes = allQuotes.filter((q) =>
    searchQuery === "" ||
    q.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
    q.context.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalResults = filteredCharacters.length + filteredThemes.length + filteredLocations.length + filteredQuotes.length;

  if (!book) return null;

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
          <h1 className="text-4xl text-foreground mb-2">Поиск</h1>
          <p className="text-muted-foreground">
            Найдите персонажей, темы и цитаты в произведении
          </p>
        </motion.div>

        {/* Search Input */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-8"
        >
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Введите запрос для поиска..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
              className="w-full pl-12 pr-12 py-4 bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary transition-colors text-lg"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {searchQuery && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mt-3 text-sm text-muted-foreground"
            >
              Найдено результатов: {totalResults}
            </motion.p>
          )}
        </motion.div>

        {/* Empty State */}
        {!searchQuery && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-center py-16"
          >
            <div className="w-20 h-20 rounded-full bg-secondary mx-auto flex items-center justify-center mb-6">
              <Search className="w-10 h-10 text-muted-foreground" />
            </div>
            <h3 className="text-xl text-foreground mb-3">Начните поиск</h3>
            <p className="text-muted-foreground max-w-md mx-auto">
              Введите имя персонажа, тему, локацию или фрагмент цитаты, чтобы найти информацию в произведении
            </p>
          </motion.div>
        )}

        {/* No Results */}
        {searchQuery && totalResults === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-16"
          >
            <p className="text-muted-foreground mb-4">Ничего не найдено</p>
            <button
              onClick={() => setSearchQuery("")}
              className="text-sm text-primary hover:underline"
            >
              Очистить поиск
            </button>
          </motion.div>
        )}

        {/* Search Results */}
        {searchQuery && totalResults > 0 && (
          <div className="space-y-12">
            {/* Characters */}
            {filteredCharacters.length > 0 && (
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className="flex items-center gap-3 mb-6">
                  <Users className="w-6 h-6 text-primary" />
                  <h2 className="text-2xl text-foreground">
                    Персонажи
                    <span className="text-sm text-muted-foreground ml-2">
                      ({filteredCharacters.length})
                    </span>
                  </h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredCharacters.map((character) => (
                    <Link
                      key={character.id}
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
                  ))}
                </div>
              </motion.section>
            )}

            {/* Themes */}
            {filteredThemes.length > 0 && (
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                <div className="flex items-center gap-3 mb-6">
                  <Lightbulb className="w-6 h-6 text-primary" />
                  <h2 className="text-2xl text-foreground">
                    Темы
                    <span className="text-sm text-muted-foreground ml-2">
                      ({filteredThemes.length})
                    </span>
                  </h2>
                </div>

                <div className="space-y-4">
                  {filteredThemes.map((theme) => (
                    <Link
                      key={theme.id}
                      href={`/book/${bookId}/theme/${theme.id}`}
                      className="block p-5 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
                    >
                      <h3 className="text-lg text-foreground mb-2">{theme.name}</h3>
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {theme.description}
                      </p>
                    </Link>
                  ))}
                </div>
              </motion.section>
            )}

            {/* Locations */}
            {filteredLocations.length > 0 && (
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
              >
                <div className="flex items-center gap-3 mb-6">
                  <MapPin className="w-6 h-6 text-primary" />
                  <h2 className="text-2xl text-foreground">
                    Локации
                    <span className="text-sm text-muted-foreground ml-2">
                      ({filteredLocations.length})
                    </span>
                  </h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredLocations.map((location) => (
                    <Link
                      key={location.id}
                      href={`/book/${bookId}/location/${location.id}`}
                      className="block p-5 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
                    >
                      <h3 className="text-lg text-foreground mb-2">{location.name}</h3>
                      <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                        {location.description}
                      </p>
                      <p className="text-xs text-muted-foreground line-clamp-1">
                        <span className="text-foreground">Значение:</span> {location.significance}
                      </p>
                    </Link>
                  ))}
                </div>
              </motion.section>
            )}

            {/* Quotes */}
            {filteredQuotes.length > 0 && (
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                <div className="flex items-center gap-3 mb-6">
                  <Quote className="w-6 h-6 text-primary" />
                  <h2 className="text-2xl text-foreground">
                    Цитаты
                    <span className="text-sm text-muted-foreground ml-2">
                      ({filteredQuotes.length})
                    </span>
                  </h2>
                </div>

                <div className="space-y-4">
                  {filteredQuotes.map((quote) => (
                    <div
                      key={quote.id}
                      className="p-5 bg-card border border-border rounded-lg"
                    >
                      <div className="flex gap-3 mb-3">
                        <Quote className="w-5 h-5 text-primary flex-shrink-0 mt-1" />
                        <p className="text-foreground italic leading-relaxed">{quote.text}</p>
                      </div>

                      <div className="ml-8 space-y-2">
                        <p className="text-sm text-muted-foreground">{quote.context}</p>

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
                  ))}
                </div>
              </motion.section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
