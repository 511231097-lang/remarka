"use client";

import { motion } from "motion/react";
import { Users } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { mockCharacters, mockBooks } from "@/lib/mockData";
import { BookNavigation } from "./BookNavigation";

export function CharactersList() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");
  const book = mockBooks.find((b) => b.id === bookId);
  const characters = mockCharacters.filter((c) => c.bookId === bookId);

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
          <h1 className="text-4xl text-foreground mb-2">Персонажи</h1>
          <p className="text-muted-foreground">
            {characters.length} {characters.length === 1 ? "персонаж" : "персонажей"} в произведении
          </p>
        </motion.div>

        {/* Characters Grid */}
        <div className="grid grid-cols-1 gap-4">
          {characters.map((character, index) => (
            <motion.div
              key={character.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <Link
                href={`/book/${bookId}/character/${character.id}`}
                className="block p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
              >
                <div className="flex items-start justify-between mb-3">
                  <h2 className="text-xl text-foreground">{character.name}</h2>
                  <span className="text-xs text-muted-foreground px-3 py-1 bg-secondary rounded-full">
                    {character.role}
                  </span>
                </div>
                <p className="text-muted-foreground mb-4">{character.description}</p>
                <div className="pt-3 border-t border-border">
                  <p className="text-sm text-muted-foreground">
                    <span className="text-foreground">Развитие:</span> {character.arc}
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
