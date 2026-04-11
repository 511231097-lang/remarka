"use client";

import { motion } from "motion/react";
import { MapPin } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { mockLocations, mockBooks } from "@/lib/mockData";
import { BookNavigation } from "./BookNavigation";

export function LocationsList() {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");
  const book = mockBooks.find((b) => b.id === bookId);
  const locations = mockLocations.filter((l) => l.bookId === bookId);

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
          <h1 className="text-4xl text-foreground mb-2">Локации</h1>
          <p className="text-muted-foreground">
            {locations.length} {locations.length === 1 ? "локация" : "локаций"} в произведении
          </p>
        </motion.div>

        {/* Locations Grid */}
        <div className="grid grid-cols-1 gap-4">
          {locations.map((location, index) => (
            <motion.div
              key={location.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <Link
                href={`/book/${bookId}/location/${location.id}`}
                className="block p-6 bg-card border border-border rounded-lg hover:border-primary/30 transition-colors"
              >
                <h2 className="text-xl text-foreground mb-3">{location.name}</h2>
                <p className="text-muted-foreground mb-4">{location.description}</p>
                <div className="pt-3 border-t border-border">
                  <p className="text-sm text-muted-foreground">
                    <span className="text-foreground">Значение:</span> {location.significance}
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
