"use client";

import Link from "next/link";
import { ArrowRight, Check, Upload } from "lucide-react";
import { type ReactNode } from "react";
import { displayAuthor, type BookCardDTO } from "@/lib/books";

export interface BookPreviewCardValue {
  id: string;
  title: string;
  author: string | null;
  coverUrl?: string | null;
}

const BOOK_COLORS = [
  ["oklch(42% 0.11 25)", "oklch(96% 0.02 80)", "Русская классика"],
  ["oklch(28% 0.04 260)", "oklch(94% 0.03 85)", "Русская классика"],
  ["oklch(48% 0.09 55)", "oklch(96% 0.02 85)", "Русская классика"],
  ["oklch(32% 0.03 30)", "oklch(95% 0.02 85)", "Зарубежная проза"],
  ["oklch(88% 0.04 85)", "oklch(22% 0.02 60)", "Нон-фикшн"],
  ["oklch(36% 0.07 150)", "oklch(95% 0.02 85)", "Зарубежная проза"],
  ["oklch(52% 0.14 50)", "oklch(97% 0.015 85)", "Магический реализм"],
  ["oklch(38% 0.11 280)", "oklch(92% 0.08 95)", "Классика"],
] as const;

function hashValue(value: string): number {
  let hash = 0;
  for (const char of String(value || "")) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function resolveBookSkin(book: BookPreviewCardValue) {
  return BOOK_COLORS[hashValue(book.id || book.title) % BOOK_COLORS.length] || BOOK_COLORS[0];
}

export function BookPreviewStage({ book, size = "md" }: { book: BookPreviewCardValue; size?: "sm" | "md" | "lg" }) {
  const [bg, fg, tag] = resolveBookSkin(book);
  const cls = size === "lg" ? "cover cover-lg" : size === "sm" ? "cover cover-sm" : "cover";
  return (
    <div className={cls} style={{ "--cover-bg": bg, "--cover-fg": fg } as React.CSSProperties}>
      <div className="c-top">{tag}</div>
      <div className="c-title">{book.title || "Без названия"}</div>
      <div className="c-author">{displayAuthor(book.author)}</div>
    </div>
  );
}

interface BookGalleryCardProps {
  book: BookCardDTO;
  href: string;
  action?: ReactNode;
}

export function BookGalleryCard({ book, href, action }: BookGalleryCardProps) {
  return (
    <article className="book-card">
      <Link href={href} aria-label={`Открыть книгу: ${book.title}`}>
        <BookPreviewStage book={book} />
      </Link>
      <div className="meta">
        <Link href={href} className="t">{book.title}</Link>
        <div className="a">{displayAuthor(book.author)}{book.createdAt ? "" : ""}</div>
        <div style={{ alignItems: "center", display: "flex", gap: 8, marginTop: 8, minHeight: 24 }}>
          {book.isInLibrary || book.isOwner ? (
            <span className="badge"><Check size={12} /> {book.isOwner ? "Ваша книга" : "В библиотеке"}</span>
          ) : action}
        </div>
      </div>
    </article>
  );
}

export function AddBookGalleryCard({ limitReached }: { limitReached: boolean }) {
  return (
    <Link href={limitReached ? "/plans" : "/upload"} className="book-card" style={{ display: "block" }}>
      <div className="cover" style={{ "--cover-bg": "var(--paper-2)", "--cover-fg": "var(--mark)" } as React.CSSProperties}>
        <div className="c-top">{limitReached ? "Расширение" : "Новая книга"}</div>
        <div style={{ alignItems: "center", display: "flex", flex: 1, justifyContent: "center" }}>
          <Upload size={28} />
        </div>
        <div className="c-author">Загрузить</div>
      </div>
      <div className="meta">
        <div className="t">Добавить книгу</div>
        <div className="a">{limitReached ? "Поднимите лимит на Плюсе" : "EPUB · FB2 · PDF"}</div>
        <div className="btn btn-plain btn-sm" style={{ justifyContent: "flex-start", marginTop: 8, paddingLeft: 0 }}>
          {limitReached ? "К тарифам" : "Загрузить"} <ArrowRight size={14} />
        </div>
      </div>
    </Link>
  );
}
