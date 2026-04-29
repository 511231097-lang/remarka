"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { BookOpen, Check, MessageCircle, Plus } from "lucide-react";
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
  type BookShowcaseThemeDTO,
} from "@/lib/books";

type TabKey = "summary" | "idea" | "heroes" | "events" | "themes";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "summary", label: "Описание" },
  { key: "idea", label: "Идея" },
  { key: "heroes", label: "Герои" },
  { key: "events", label: "События" },
  { key: "themes", label: "Темы" },
];

const PLACEHOLDER_AFTER_ANALYSIS =
  "Информация будет доступна после полного анализа книги.";

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
  const [activeTab, setActiveTab] = useState<TabKey>("summary");

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
                  <h1 style={{ fontSize: "clamp(38px, 6vw, 52px)", letterSpacing: 0, lineHeight: 1.02, textWrap: "balance" }}>
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
                      <MessageCircle size={16} /> Открыть чат
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

          <main className="container-narrow" style={{ paddingBottom: 96, paddingTop: 56 }}>
            <div
              className="overview-tabs"
              role="tablist"
              style={{
                background: "var(--paper-2)",
                border: "1px solid var(--rule)",
                borderRadius: 999,
                display: "inline-flex",
                gap: 4,
                marginBottom: 40,
                padding: 4,
              }}
            >
              {TABS.map((tab) => {
                const isActive = tab.key === activeTab;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActiveTab(tab.key)}
                    style={{
                      background: isActive ? "var(--ink)" : "transparent",
                      border: "none",
                      borderRadius: 999,
                      color: isActive ? "var(--paper)" : "var(--ink-muted)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 14,
                      padding: "8px 18px",
                      transition: "all .15s",
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {showcaseLoading && !showcase ? (
              <div className="card muted" style={{ marginBottom: 24, padding: 20 }}>Загружаем анализ книги…</div>
            ) : null}

            {!showcase && !showcaseLoading ? (
              <div className="card" style={{ marginBottom: 32, padding: 24 }}>
                <BookOpen size={22} style={{ color: "var(--mark)" }} />
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 22, marginTop: 12 }}>Витрина книги собирается</div>
                <p className="soft" style={{ fontSize: 14, lineHeight: 1.6, marginTop: 8 }}>
                  Ниже показана доступная информация. Полный AI-разбор появится после генерации витрины.
                </p>
              </div>
            ) : null}

            <motion.section
              key={activeTab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === "summary" && <SummaryPanel summary={summary} />}
              {activeTab === "idea" && <IdeaPanel idea={idea} themes={themeChips} />}
              {activeTab === "heroes" && <HeroesPanel heroes={heroes} />}
              {activeTab === "events" && <EventsPanel events={events} />}
              {activeTab === "themes" && <ThemesPanel themes={themes} />}
            </motion.section>

            <div
              style={{
                background: "var(--paper-2)",
                border: "1px solid var(--rule)",
                borderRadius: "var(--r-xl)",
                marginTop: 64,
                padding: "40px 32px",
                textAlign: "center",
              }}
            >
              <div className="mono" style={{ color: "var(--mark)", marginBottom: 14 }}>Дальше — вопросы</div>
              <h3 style={{ fontSize: 28, letterSpacing: 0, margin: "0 auto", maxWidth: 520, textWrap: "balance" }}>
                Хотите спросить о чём-то, чего нет в разборе?
              </h3>
              <p className="soft" style={{ fontSize: 15, lineHeight: 1.55, margin: "12px auto 0", maxWidth: 460 }}>
                Откройте чат — AI-эксперт ответит, опираясь на текст книги, и покажет, откуда пришёл ответ.
              </p>
              <Link className="btn btn-mark btn-lg" style={{ marginTop: 24 }} href={chatHref}>
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
          .overview-tabs {
            flex-wrap: wrap;
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

function SummaryPanel({ summary }: { summary: string }) {
  return (
    <div>
      <div className="mono" style={{ color: "var(--ink-muted)", marginBottom: 10 }}>i · Описание</div>
      <h3 style={{ fontSize: 28, letterSpacing: 0, marginBottom: 18 }}>О чём эта книга</h3>
      <p
        style={{
          color: "var(--ink)",
          fontFamily: "var(--font-serif)",
          fontSize: 19,
          lineHeight: 1.65,
          textWrap: "pretty",
        }}
      >
        {summary}
      </p>
    </div>
  );
}

function IdeaPanel({ idea, themes }: { idea: string; themes: string[] }) {
  return (
    <div>
      <div className="mono" style={{ color: "var(--ink-muted)", marginBottom: 10 }}>ii · Ключевая идея</div>
      <h3 style={{ fontSize: 28, letterSpacing: 0, marginBottom: 18 }}>Что говорит автор</h3>
      {idea ? (
        <div style={{ borderLeft: "3px solid var(--mark)", paddingLeft: 24 }}>
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
            {idea}
          </p>
        </div>
      ) : (
        <PlaceholderCard text="Ключевая идея будет сформирована AI после полного анализа книги." />
      )}
      {themes.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 24 }}>
          {themes.map((chip) => (
            <div key={chip} className="chip" style={{ cursor: "default" }}>{chip}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function HeroesPanel({ heroes }: { heroes: BookShowcaseCharacterDTO[] }) {
  return (
    <div>
      <div className="mono" style={{ color: "var(--ink-muted)", marginBottom: 10 }}>iii · Главные персонажи</div>
      <h3 style={{ fontSize: 28, letterSpacing: 0, marginBottom: 18 }}>Кто движет сюжет</h3>
      {heroes.length > 0 ? (
        <ul
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 0,
            listStyle: "none",
            padding: 0,
          }}
        >
          {heroes.map((hero, index) => (
            <li
              key={`${hero.name}:${hero.rank}`}
              style={{
                borderBottom: index < heroes.length - 1 ? "1px solid var(--rule-soft)" : "none",
                display: "grid",
                gap: 20,
                gridTemplateColumns: "minmax(140px, 220px) 1fr",
                padding: "18px 0",
              }}
            >
              <div style={{ color: "var(--ink)", fontFamily: "var(--font-serif)", fontSize: 19, lineHeight: 1.4 }}>
                {hero.name}
              </div>
              <div className="soft" style={{ fontSize: 15, lineHeight: 1.55 }}>{hero.description}</div>
            </li>
          ))}
        </ul>
      ) : (
        <PlaceholderCard text={PLACEHOLDER_AFTER_ANALYSIS} />
      )}
    </div>
  );
}

function EventsPanel({ events }: { events: BookShowcaseEventDTO[] }) {
  return (
    <div>
      <div className="mono" style={{ color: "var(--ink-muted)", marginBottom: 10 }}>iv · Ключевые события</div>
      <h3 style={{ fontSize: 28, letterSpacing: 0, marginBottom: 18 }}>Сюжет в нескольких точках</h3>
      {events.length > 0 ? (
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {events.map((event, index) => (
            <li
              key={`${event.title}:${index}`}
              style={{
                borderBottom: index < events.length - 1 ? "1px solid var(--rule-soft)" : "none",
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
        <PlaceholderCard text={PLACEHOLDER_AFTER_ANALYSIS} />
      )}
    </div>
  );
}

function ThemesPanel({ themes }: { themes: BookShowcaseThemeDTO[] }) {
  return (
    <div>
      <div className="mono" style={{ color: "var(--ink-muted)", marginBottom: 10 }}>v · Темы</div>
      <h3 style={{ fontSize: 28, letterSpacing: 0, marginBottom: 18 }}>О чём думает книга</h3>
      {themes.length > 0 ? (
        <div
          className="themes-grid"
          style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
        >
          {themes.map((theme) => (
            <article
              key={theme.name}
              className="card"
              style={{ background: "var(--cream)", padding: 20 }}
            >
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 500 }}>{theme.name}</div>
              <p className="soft" style={{ fontSize: 14, lineHeight: 1.55, marginTop: 8 }}>{theme.description}</p>
            </article>
          ))}
          <style jsx>{`
            @media (max-width: 720px) {
              .themes-grid {
                grid-template-columns: 1fr !important;
              }
            }
          `}</style>
        </div>
      ) : (
        <PlaceholderCard text={PLACEHOLDER_AFTER_ANALYSIS} />
      )}
    </div>
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
