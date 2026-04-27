"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { BookOpen, Check, MessageCircle, Plus } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BookPreviewStage } from "./BookGalleryCard";
import { BookSettings } from "./BookSettings";
import { getBook, getBookShowcase } from "@/lib/booksClient";
import { appendBookDetailSource, resolveBookDetailSource } from "@/lib/bookDetailNavigation";
import { displayAuthor, type BookCoreDTO, type BookShowcaseDTO } from "@/lib/books";

const CHARACTER_COLORS = [
  "oklch(58% 0.11 60)",
  "oklch(42% 0.11 25)",
  "oklch(28% 0.04 260)",
  "oklch(36% 0.07 150)",
  "oklch(48% 0.09 55)",
  "oklch(60% 0.12 200)",
] as const;

function resolveBookSummary(book: BookCoreDTO, showcase: BookShowcaseDTO | null): string {
  return (
    String(showcase?.summary.shortSummary || "").trim() ||
    String(book.summary || "").trim() ||
    "Краткое описание книги пока не добавлено. После анализа здесь появится сжатый обзор произведения."
  );
}

function resolveMainIdea(showcase: BookShowcaseDTO | null): string {
  return (
    String(showcase?.summary.mainIdea || "").trim() ||
    "Ключевая идея будет сформирована AI после полного анализа книги."
  );
}

function resolveEyebrow(book: BookCoreDTO): string {
  const chapters = book.chapterCount > 0 ? `${book.chapterCount} глав` : "главы готовятся";
  return `AI-разбор · ${chapters} · ${book.isPublic ? "Публичная" : "Только для вас"}`;
}

function resolveChips(book: BookCoreDTO, showcase: BookShowcaseDTO | null): string[] {
  const themeNames = (showcase?.themes || []).map((theme) => theme.name).filter(Boolean).slice(0, 5);
  if (themeNames.length > 0) return themeNames;
  return [book.isPublic ? "Публичная книга" : "Личная книга", "AI-разбор", "Чат по тексту"];
}

export function BookOverview() {
  const params = useParams<{ bookId: string }>();
  const searchParams = useSearchParams();
  const bookId = String(params.bookId || "");

  const [book, setBook] = useState<BookCoreDTO | null>(null);
  const [showcase, setShowcase] = useState<BookShowcaseDTO | null>(null);
  const [showcaseLoading, setShowcaseLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bookId) return;
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      setShowcaseLoading(true);
      const [bookResult, showcaseResult] = await Promise.allSettled([getBook(bookId), getBookShowcase(bookId)]);
      if (!active) return;
      if (bookResult.status === "fulfilled") setBook(bookResult.value);
      else {
        setBook(null);
        setError(bookResult.reason instanceof Error ? bookResult.reason.message : "Не удалось загрузить книгу");
      }
      setShowcase(showcaseResult.status === "fulfilled" ? showcaseResult.value : null);
      setShowcaseLoading(false);
      setLoading(false);
    }
    void load();
    return () => {
      active = false;
    };
  }, [bookId]);

  const source = resolveBookDetailSource(searchParams.get("from"));
  const fallbackSource = book?.canManage ? "library" : "explore";
  const resolvedSource = source || fallbackSource;
  const chatHref = appendBookDetailSource(`/book/${bookId}/chat`, resolvedSource);
  const backHref = resolvedSource === "library" ? "/library" : "/explore";

  return (
    <div className="screen-fade">
      {loading && (
        <div className="container" style={{ paddingBottom: 96, paddingTop: 48 }}>
          <div className="muted" style={{ padding: "24px 0" }}>Загрузка книги...</div>
        </div>
      )}

      {error && !loading && (
        <div className="container" style={{ paddingBottom: 96, paddingTop: 48 }}>
          <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", padding: 16 }}>{error}</div>
        </div>
      )}

      {book && !loading && (
        <>
          <div style={{ background: "var(--paper-2)", borderBottom: "1px solid var(--rule)" }}>
            <div className="container" style={{ paddingBottom: 48, paddingTop: 48 }}>
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="book-hero-grid"
                style={{ alignItems: "flex-start", display: "grid", gap: 48, gridTemplateColumns: "260px minmax(0,1fr)" }}
              >
                <div style={{ width: 260 }}>
                  <BookPreviewStage book={book} size="lg" />
                </div>
                <div>
                  <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>
                    {resolveEyebrow(book)}
                  </div>
                  <h1 style={{ fontSize: "clamp(38px, 6vw, 52px)", letterSpacing: 0, lineHeight: 1.02, textWrap: "balance" }}>
                    {book.title}
                  </h1>
                  <div style={{ color: "var(--ink-soft)", fontFamily: "var(--font-serif)", fontSize: 20, fontStyle: "italic", marginTop: 12 }}>
                    {displayAuthor(book.author)}
                  </div>
                  <p className="soft" style={{ fontSize: 17, lineHeight: 1.6, marginTop: 20, maxWidth: 620, textWrap: "pretty" }}>
                    {resolveBookSummary(book, showcase)}
                  </p>
                  <div className="book-hero-actions row" style={{ flexWrap: "wrap", marginTop: 28 }}>
                    <Link className="btn btn-mark btn-lg" href={chatHref}>
                      <MessageCircle size={16} /> Начать разговор
                    </Link>
                    {book.canManage || resolvedSource === "library" ? (
                      <button className="btn btn-ghost btn-lg" disabled style={{ opacity: 0.7 }}>
                        <Check size={16} /> {book.canManage ? "Ваша книга" : "В библиотеке"}
                      </button>
                    ) : (
                      <button className="btn btn-ghost btn-lg" disabled title="Добавление с этой страницы будет подключено отдельно" style={{ opacity: 0.7 }}>
                        <Plus size={16} /> Добавить к себе
                      </button>
                    )}
                    <Link className="btn btn-plain btn-lg" href={backHref}>
                      {resolvedSource === "library" ? "К библиотеке" : "К каталогу"}
                    </Link>
                    {book.canManage ? <BookSettings book={book} triggerClassName="btn btn-plain btn-lg" triggerLabel="Настройки" /> : null}
                  </div>
                  <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 28 }}>
                    {resolveChips(book, showcase).map((chip) => (
                      <div key={chip} className="badge">{chip}</div>
                    ))}
                  </div>
                </div>
              </motion.div>
            </div>
          </div>

          <main className="container-narrow" style={{ paddingBottom: 96, paddingTop: 72 }}>
            <div className="mono" style={{ color: "var(--mark)", marginBottom: 16, textAlign: "center" }}>
              Анализ · AI-разбор
            </div>
            <h2 style={{ fontSize: 40, letterSpacing: 0, marginBottom: 48, textAlign: "center", textWrap: "balance" }}>
              Краткий разбор книги
            </h2>

            {showcaseLoading ? (
              <div className="card muted" style={{ marginBottom: 48, padding: 20 }}>Загружаем анализ книги...</div>
            ) : null}

            {!showcase && !showcaseLoading ? (
              <div className="card" style={{ marginBottom: 48, padding: 24 }}>
                <BookOpen size={22} style={{ color: "var(--mark)" }} />
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 24, marginTop: 12 }}>Витрина книги собирается</div>
                <p className="soft" style={{ fontSize: 15, lineHeight: 1.65, marginTop: 10 }}>
                  Ниже показана доступная информация из карточки книги. Полный AI-разбор появится после генерации витрины.
                </p>
              </div>
            ) : null}

            <AnalysisSection eyebrow="i · Описание" title="О чём эта книга">
              <p style={{ color: "var(--ink)", fontFamily: "var(--font-serif)", fontSize: 19, lineHeight: 1.6, textWrap: "pretty" }}>
                {resolveBookSummary(book, showcase)}
              </p>
            </AnalysisSection>

            <Divider />

            <AnalysisSection eyebrow="ii · Ключевая идея" title="Что говорит автор">
              <div style={{ borderLeft: "3px solid var(--mark)", marginTop: 8, paddingLeft: 24 }}>
                <p style={{ color: "var(--ink)", fontFamily: "var(--font-serif)", fontSize: 22, fontStyle: "italic", lineHeight: 1.45, textWrap: "pretty" }}>
                  {resolveMainIdea(showcase)}
                </p>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 20 }}>
                {resolveChips(book, showcase).map((chip) => (
                  <div key={chip} className="chip" style={{ cursor: "default" }}>{chip}</div>
                ))}
              </div>
            </AnalysisSection>

            <Divider />

            <AnalysisSection eyebrow="iii · Главные персонажи" title="Кто движет сюжет">
              {showcase?.characters.length ? (
                <div className="book-character-grid" style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(2, 1fr)", marginTop: 8 }}>
                  {showcase.characters.map((character, index) => (
                    <article key={`${character.name}:${character.rank}`} className="card" style={{ background: "var(--cream)", padding: 20 }}>
                      <div className="row-sm" style={{ marginBottom: 8 }}>
                        <div
                          style={{
                            alignItems: "center",
                            background: CHARACTER_COLORS[index % CHARACTER_COLORS.length],
                            borderRadius: "50%",
                            color: "#fff",
                            display: "flex",
                            fontFamily: "var(--font-serif)",
                            fontSize: 14,
                            height: 32,
                            justifyContent: "center",
                            width: 32,
                          }}
                        >
                          {character.name.trim().charAt(0) || "?"}
                        </div>
                        <div style={{ fontFamily: "var(--font-serif)", fontSize: 17, fontWeight: 500 }}>{character.name}</div>
                      </div>
                      <p className="soft" style={{ fontSize: 14, lineHeight: 1.5 }}>{character.description}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="soft" style={{ fontSize: 15, lineHeight: 1.6 }}>Главные персонажи появятся после полного анализа книги.</p>
              )}
            </AnalysisSection>

            <Divider />

            <AnalysisSection eyebrow="iv · Ключевые события" title="Сюжет в пяти точках">
              {showcase?.keyEvents.length ? (
                <ol style={{ listStyle: "none", marginTop: 12, padding: 0 }}>
                  {showcase.keyEvents.map((event, index) => (
                    <li
                      key={`${event.title}:${index}`}
                      style={{
                        borderBottom: index < showcase.keyEvents.length - 1 ? "1px solid var(--rule-soft)" : "none",
                        display: "grid",
                        gap: 20,
                        gridTemplateColumns: "48px 1fr",
                        padding: "18px 0",
                      }}
                    >
                      <div style={{ color: "var(--mark)", fontFamily: "var(--font-serif)", fontSize: 28, lineHeight: 1 }}>
                        {String(index + 1).padStart(2, "0")}
                      </div>
                      <div style={{ color: "var(--ink)", fontFamily: "var(--font-serif)", fontSize: 19, lineHeight: 1.5, paddingTop: 2 }}>
                        <div>{event.title}</div>
                        <p className="soft" style={{ fontFamily: "var(--font-sans)", fontSize: 14, lineHeight: 1.55, marginTop: 6 }}>
                          {event.description}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="soft" style={{ fontSize: 15, lineHeight: 1.6 }}>Ключевые события появятся после полного анализа книги.</p>
              )}
            </AnalysisSection>

            <div style={{ background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: "var(--r-xl)", marginTop: 72, padding: "48px 32px", textAlign: "center" }}>
              <div className="mono" style={{ color: "var(--mark)", marginBottom: 14 }}>Дальше — вопросы</div>
              <h3 style={{ fontSize: 30, letterSpacing: 0, margin: "0 auto", maxWidth: 520, textWrap: "balance" }}>
                Хотите спросить о чём-то, чего нет в разборе?
              </h3>
              <p className="soft" style={{ fontSize: 15, lineHeight: 1.55, margin: "14px auto 0", maxWidth: 460 }}>
                Откройте чат — AI-эксперт ответит, опираясь на текст книги, и покажет, откуда пришёл ответ.
              </p>
              <Link className="btn btn-mark btn-lg" style={{ marginTop: 28 }} href={chatHref}>
                <MessageCircle size={16} /> Перейти в чат
              </Link>
            </div>
          </main>
        </>
      )}
      <style jsx>{`
        @media (max-width: 820px) {
          .book-hero-grid {
            grid-template-columns: 1fr !important;
            gap: 32px !important;
          }
          .book-hero-actions {
            align-items: stretch;
            flex-direction: column;
          }
          .book-hero-actions :global(.btn) {
            justify-content: center;
            width: 100%;
          }
          .book-character-grid {
            grid-template-columns: 1fr !important;
          }
        }
        @media (max-width: 520px) {
          .book-hero-grid > div:first-child {
            width: min(260px, 100%) !important;
          }
        }
      `}</style>
    </div>
  );
}

function AnalysisSection({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="stack">
      <div>
        <div className="mono" style={{ color: "var(--ink-muted)", marginBottom: 10 }}>{eyebrow}</div>
        <h3 style={{ fontSize: 28, letterSpacing: 0 }}>{title}</h3>
      </div>
      {children}
    </motion.section>
  );
}

function Divider() {
  return <div className="hr" style={{ margin: "56px 0" }} />;
}
