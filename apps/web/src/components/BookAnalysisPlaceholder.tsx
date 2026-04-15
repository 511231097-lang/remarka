"use client";

import { MessageSquare, Wrench } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { BookNavigation } from "./BookNavigation";

interface BookAnalysisPlaceholderProps {
  title: string;
}

export function BookAnalysisPlaceholder({ title }: BookAnalysisPlaceholderProps) {
  const params = useParams<{ bookId: string }>();
  const bookId = String(params.bookId || "");

  return (
    <div className="min-h-screen bg-background">
      <BookNavigation />
      <div className="mx-auto flex max-w-4xl px-6 pb-16 pt-12">
        <div className="w-full rounded-3xl border border-border bg-card/90 p-8 shadow-sm">
          <div className="mb-6 flex items-start gap-4">
            <div className="rounded-2xl bg-primary/10 p-3">
              <Wrench className="h-6 w-6 text-primary" />
            </div>
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Analysis Placeholder</p>
              <h1 className="mt-2 text-2xl text-foreground">{title}</h1>
            </div>
          </div>

          <div className="space-y-4 text-sm leading-7 text-muted-foreground">
            <p>
              Старый интерфейс аналитических витрин для этой книги сейчас выведен из активной поддержки и больше не
              обновляется отдельными backend-ручками.
            </p>
            <p>
              Основной рабочий режим книги теперь один: чат по тексту. Через него можно задавать вопросы про персонажей,
              темы, сцены, цитаты и получать ответ в текущем pipeline.
            </p>
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href={`/book/${bookId}`}
              className="rounded-full border border-border px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              К книге
            </Link>
            <Link
              href={`/book/${bookId}/chat`}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90"
            >
              <MessageSquare className="h-4 w-4" />
              Открыть чат
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
