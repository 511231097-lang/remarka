"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { Check, MessageCircle, Plus } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BookPreviewStage } from "./BookGalleryCard";
import { BookSettings } from "./BookSettings";
import { getBook, getBookShowcase } from "@/lib/booksClient";
import { appendBookDetailSource, resolveBookDetailSource } from "@/lib/bookDetailNavigation";
import {
  displayAuthor,
  type BookCoreDTO,
  type BookShowcaseDTO,
  type BookShowcaseCharacterDTO,
  type BookShowcaseEventDTO,
} from "@/lib/books";

const HERO_AVATAR_COLORS = [
  "oklch(58% 0.11 60)",
  "oklch(42% 0.11 25)",
  "oklch(28% 0.04 260)",
  "oklch(36% 0.07 150)",
  "oklch(48% 0.09 55)",
  "oklch(60% 0.12 200)",
];

const PLACEHOLDER_HEROES = "Главные персонажи появятся после полного анализа книги.";
const PLACEHOLDER_EVENTS = "Ключевые события появятся после полного анализа книги.";
const IDEA_PLACEHOLDER = "Ключевая идея будет сформирована AI после полного анализа книги.";

function resolveBookSummary(book: BookCoreDTO, showcase: BookShowcaseDTO | null): string {
  return (
    String(showcase?.summary.shortSummary || "").trim() ||
    String(book.summary || "").trim() ||
    "Краткое описание книги пока не добавлено. После анализа здесь появится сжатый обзор произведения."
  );
}

function resolveMainIdea(showcase: BookShowcaseDTO | null): string {
  return String(showcase?.summary.mainIdea || "").trim();
}

function resolveEyebrow(book: BookCoreDTO): string {
  const chapters = book.chapterCount > 0 ? `${book.chapterCount} глав` : "главы готовятся";
  return `AI-разбор · ${chapters} · ${book.isPublic ? "Публичная" : "Только для вас"}`;
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

  const themes = showcase?.themes ?? [];
  const heroes = showcase?.characters ?? [];
  const events = showcase?.keyEvents ?? [];
  const idea = useMemo(() => resolveMainIdea(showcase), [showcase]);
  const summary = book ? resolveBookSummary(book, showcase) : "";
  const themeChips = useMemo(
    () => themes.map((theme) => theme.name).filter(Boolean).slice(0, 6),
    [themes]
  );

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
                  <h1 style={{ fontSize: "clamp(38px, 6vw, 52px)", letterSpacing: "-0.02em", lineHeight: 1.02, textWrap: "balance" }}>
                    {book.title}
                  </h1>
                  <div style={{ color: "var(--ink-soft)", fontFamily: "var(--font-serif)", fontSize: 20, fontStyle: "italic", marginTop: 12 }}>
                    {displayAuthor(book.author)}
                  </div>
                  <p className="soft" style={{ fontSize: 17, lineHeight: 1.6, marginTop: 20, maxWidth: 620, textWrap: "pretty" }}>
                    {summary}
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
                    {book.canManage ? <BookSettings book={book} triggerClassName="btn btn-plain btn-sm" triggerLabel="Настройки" /> : null}
                  </div>
                  {themeChips.length > 0 && (
                    <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 28 }}>
                      {themeChips.map((chip) => (
                        <div key={chip} className="badge">{chip}</div>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          </div>

          <main className="container-narrow" style={{ paddingBottom: 96, paddingTop: 72 }}>
            <div className="mono" style={{ color: "var(--mark)", marginBottom: 16, textAlign: "center" }}>
              Анализ · AI-разбор
            </div>
            <h2
              style={{
                fontSize: 40,
                letterSpacing: "-0.02em",
                marginBottom: 48,
                textAlign: "center",
                textWrap: "balance",
              }}
            >
              Краткий разбор книги
            </h2>

            {showcaseLoading && !showcase ? (
              <div className="card muted" style={{ marginBottom: 24, padding: 20 }}>Загружаем анализ книги…</div>
            ) : null}

            {!showcase && !showcaseLoading ? (
              <div className="card" style={{ marginBottom: 32, padding: 24 }}>
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 22 }}>Витрина книги собирается</div>
                <p className="soft" style={{ fontSize: 14, lineHeight: 1.6, marginTop: 8 }}>
                  Ниже показана доступная информация. Полный AI-разбор появится после генерации витрины.
                </p>
              </div>
            ) : null}

            {/* i · Описание */}
            <section className="stack">
              <div className="mono" style={{ color: "var(--ink-muted)" }}>i · Описание</div>
              <h3 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>О чём эта книга</h3>
              <p
                style={{
                  color: "var(--ink)",
                  fontFamily: "var(--font-serif)",
                  fontSize: 19,
                  lineHeight: 1.6,
                  textWrap: "pretty",
                }}
              >
                {summary}
              </p>
            </section>

            <div className="hr" style={{ margin: "56px 0" }} />

            {/* ii · Ключевая идея */}
            <section className="stack">
              <div className="mono" style={{ color: "var(--ink-muted)" }}>ii · Ключевая идея</div>
              <h3 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>Что говорит автор</h3>
              <div style={{ borderLeft: "3px solid var(--mark)", marginTop: 8, paddingLeft: 24 }}>
                <p
                  style={{
                    color: "var(--ink)",
                    fontFamily: "var(--font-serif)",
                    fontSize: 22,
                    fontStyle: "italic",
                    lineHeight: 1.45,
                    textWrap: "pretty",
                  }}
                >
                  {idea || IDEA_PLACEHOLDER}
                </p>
              </div>
              {themeChips.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 20 }}>
                  {themeChips.map((chip) => (
                    <div key={chip} className="chip" style={{ cursor: "default" }}>{chip}</div>
                  ))}
                </div>
              )}
            </section>

            <div className="hr" style={{ margin: "56px 0" }} />

            {/* iii · Главные персонажи */}
            <section className="stack">
              <div className="mono" style={{ color: "var(--ink-muted)" }}>iii · Главные персонажи</div>
              <h3 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>Кто движет сюжет</h3>
              {heroes.length > 0 ? (
                <div
                  className="heroes-grid"
                  style={{ display: "grid", gap: 18, gridTemplateColumns: "repeat(2, 1fr)", marginTop: 8 }}
                >
                  {heroes.map((hero, index) => (
                    <HeroCard key={`${hero.name}:${hero.rank}`} hero={hero} index={index} />
                  ))}
                </div>
              ) : (
                <PlaceholderCard text={PLACEHOLDER_HEROES} />
              )}
            </section>

            <div className="hr" style={{ margin: "56px 0" }} />

            {/* iv · Ключевые события */}
            <section className="stack">
              <div className="mono" style={{ color: "var(--ink-muted)" }}>iv · Ключевые события</div>
              <h3 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>Сюжет в нескольких точках</h3>
              {events.length > 0 ? (
                <ol style={{ listStyle: "none", margin: 0, marginTop: 12, padding: 0 }}>
                  {events.map((event, index) => (
                    <EventRow key={`${event.title}:${index}`} event={event} index={index} total={events.length} />
                  ))}
                </ol>
              ) : (
                <PlaceholderCard text={PLACEHOLDER_EVENTS} />
              )}
            </section>

            {/* CTA */}
            <div
              style={{
                background: "var(--paper-2)",
                border: "1px solid var(--rule)",
                borderRadius: "var(--r-xl)",
                marginTop: 72,
                padding: "48px 32px",
                textAlign: "center",
              }}
            >
              <div className="mono" style={{ color: "var(--mark)", marginBottom: 14 }}>Дальше — вопросы</div>
              <h3 style={{ fontSize: 30, letterSpacing: "-0.015em", margin: "0 auto", maxWidth: 520, textWrap: "balance" }}>
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
          :global(.book-hero-grid) {
            grid-template-columns: 1fr !important;
            gap: 32px !important;
          }
          :global(.book-hero-actions) {
            align-items: stretch;
            flex-direction: column;
          }
          :global(.book-hero-actions .btn) {
            justify-content: center;
            width: 100%;
          }
          :global(.heroes-grid) {
            grid-template-columns: 1fr !important;
          }
        }
        @media (max-width: 520px) {
          :global(.book-hero-grid) > div:first-child {
            width: min(260px, 100%) !important;
          }
        }
      `}</style>
    </div>
  );
}

function HeroCard({ hero, index }: { hero: BookShowcaseCharacterDTO; index: number }) {
  const initial = (hero.name || "?").trim().charAt(0) || "?";
  const color = HERO_AVATAR_COLORS[index % HERO_AVATAR_COLORS.length];
  return (
    <div className="card" style={{ background: "var(--cream)", padding: 20 }}>
      <div className="row-sm" style={{ marginBottom: 8 }}>
        <div
          style={{
            alignItems: "center",
            background: color,
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
          {initial}
        </div>
        <div style={{ fontFamily: "var(--font-serif)", fontSize: 17, fontWeight: 500 }}>{hero.name}</div>
      </div>
      <p className="soft" style={{ fontSize: 14, lineHeight: 1.5 }}>{hero.description}</p>
    </div>
  );
}

function EventRow({
  event,
  index,
  total,
}: {
  event: BookShowcaseEventDTO;
  index: number;
  total: number;
}) {
  return (
    <li
      style={{
        borderBottom: index < total - 1 ? "1px solid var(--rule-soft)" : "none",
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
        {event.description ? (
          <p className="soft" style={{ fontFamily: "var(--font-sans)", fontSize: 14, lineHeight: 1.55, marginTop: 6 }}>
            {event.description}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function PlaceholderCard({ text }: { text: string }) {
  return (
    <div
      className="card"
      style={{ background: "var(--paper-2)", color: "var(--ink-muted)", fontSize: 14, padding: 20 }}
    >
      {text}
    </div>
  );
}
