"use client";

import { motion } from "motion/react";
import { Heart, BookOpen, Users, Lightbulb, User, MapPin } from "lucide-react";
import Link from "next/link";
import { mockBooks } from "@/lib/mockData";

export function Favorites() {
  const likedBooks = mockBooks.filter((b) => b.isLiked && b.isPublic);

  if (likedBooks.length === 0) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md text-center space-y-6"
        >
          <div className="w-20 h-20 rounded-full bg-secondary mx-auto flex items-center justify-center">
            <Heart className="w-10 h-10 text-muted-foreground" />
          </div>

          <div className="space-y-3">
            <h1 className="text-2xl text-foreground">Нет избранных книг</h1>
            <p className="text-muted-foreground">
              Лайкайте интересные анализы в каталоге, чтобы сохранить их здесь
            </p>
          </div>

          <Link
            href="/explore"
            className="inline-block px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
          >
            Перейти в каталог
          </Link>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <div className="flex items-center gap-4 mb-3">
            <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
              <Heart className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-4xl text-foreground">Избранное</h1>
          </div>
          <p className="text-muted-foreground ml-16">
            {likedBooks.length} {likedBooks.length === 1 ? "книга" : "книги"}
          </p>
        </motion.div>

        {/* Books List */}
        <div className="space-y-4">
          {likedBooks.map((book, index) => (
            <motion.div
              key={book.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <Link
                href={`/book/${book.id}`}
                className="block p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <h2 className="text-xl text-foreground mb-1">{book.title}</h2>
                    <p className="text-muted-foreground">{book.author}</p>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-1 bg-primary/10 rounded-full">
                    <Heart className="w-4 h-4 text-primary fill-current" />
                    <span className="text-sm text-primary">{book.likesCount}</span>
                  </div>
                </div>

                <div className="flex items-center gap-6 text-sm mb-4 flex-wrap">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <BookOpen className="w-4 h-4" />
                    <span>{book.chaptersCount} глав</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Users className="w-4 h-4" />
                    <span>{book.charactersCount} персонажей</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Lightbulb className="w-4 h-4" />
                    <span>{book.themesCount} тем</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="w-4 h-4" />
                    <span>{book.locationsCount} локаций</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center">
                    <User className="w-3 h-3 text-primary" />
                  </div>
                  <span>{book.uploadedBy.name}</span>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
