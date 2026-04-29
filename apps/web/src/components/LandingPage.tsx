"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight, Quote, Upload } from "lucide-react";

const SAMPLE_BOOKS = [
  { id: "master", title: "Мастер и Маргарита", author: "Михаил Булгаков", year: 1967, tag: "Русская классика", cover: { bg: "oklch(42% 0.11 25)", fg: "oklch(96% 0.02 80)" } },
  { id: "crime", title: "Преступление и наказание", author: "Фёдор Достоевский", year: 1866, tag: "Русская классика", cover: { bg: "oklch(28% 0.04 260)", fg: "oklch(94% 0.03 85)" } },
  { id: "anna", title: "Анна Каренина", author: "Лев Толстой", year: 1877, tag: "Русская классика", cover: { bg: "oklch(48% 0.09 55)", fg: "oklch(96% 0.02 85)" } },
  { id: "1984", title: "1984", author: "Джордж Оруэлл", year: 1949, tag: "Зарубежная проза", cover: { bg: "oklch(32% 0.03 30)", fg: "oklch(95% 0.02 85)" } },
  { id: "sapiens", title: "Sapiens. Краткая история человечества", author: "Юваль Ной Харари", year: 2011, tag: "Нон-фикшн", cover: { bg: "oklch(88% 0.04 85)", fg: "oklch(22% 0.02 60)" } },
  { id: "steppe", title: "Степной волк", author: "Герман Гессе", year: 1927, tag: "Зарубежная проза", cover: { bg: "oklch(36% 0.07 150)", fg: "oklch(95% 0.02 85)" } },
  { id: "hundred", title: "Сто лет одиночества", author: "Габриэль Гарсиа Маркес", year: 1967, tag: "Зарубежная проза", cover: { bg: "oklch(52% 0.14 50)", fg: "oklch(97% 0.015 85)" } },
];

type SampleBook = (typeof SAMPLE_BOOKS)[number];

function BookCover({ book, size = "md" }: { book: SampleBook; size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "cover cover-lg" : size === "sm" ? "cover cover-sm" : "cover";
  return (
    <div className={cls} style={{ "--cover-bg": book.cover.bg, "--cover-fg": book.cover.fg } as React.CSSProperties}>
      <div className="c-top">{book.tag}</div>
      <div className="c-title">{book.title}</div>
      <div className="c-author">{book.author}</div>
    </div>
  );
}

function HeroArt() {
  return (
    <div className="hidden lg:block landing-hero-art" style={{ height: 520, position: "relative" }}>
      <div style={{ left: 0, position: "absolute", top: 40, transform: "rotate(-6deg)", width: 200 }}>
        <BookCover book={SAMPLE_BOOKS[2]} size="lg" />
      </div>
      <div style={{ left: 140, position: "absolute", top: 0, width: 240, zIndex: 2 }}>
        <BookCover book={SAMPLE_BOOKS[0]} size="lg" />
      </div>
      <div style={{ position: "absolute", right: 0, top: 60, transform: "rotate(5deg)", width: 200 }}>
        <BookCover book={SAMPLE_BOOKS[6]} size="lg" />
      </div>
      <div style={{ left: 220, pointerEvents: "none", position: "absolute", top: 240, zIndex: 4 }}>
        <svg width="280" height="120" viewBox="0 0 280 120" fill="none" aria-hidden="true">
          <path
            d="M 10 60 C 60 20, 120 90, 200 50 S 270 70, 270 70"
            stroke="var(--mark)"
            strokeLinecap="round"
            strokeWidth="3"
            fill="none"
            style={{ filter: "drop-shadow(0 1px 0 oklch(52% 0.18 25 / 0.3))" }}
          />
        </svg>
      </div>
      <div
        style={{
          background: "var(--cream)",
          border: "1px solid var(--rule)",
          borderRadius: "var(--r-lg)",
          bottom: 10,
          boxShadow: "var(--shadow)",
          padding: 16,
          position: "absolute",
          right: -10,
          transform: "rotate(3deg)",
          width: 220,
          zIndex: 5,
        }}
      >
        <div className="mono" style={{ color: "var(--mark)", fontSize: 9, marginBottom: 8 }}>Ремарка AI · стр. 247</div>
        <div style={{ color: "var(--ink)", fontFamily: "var(--font-serif)", fontSize: 14, lineHeight: 1.4 }}>
          «Трусость — самый страшный порок», — говорит Иешуа. Это не случайная фраза, а камертон всего романа.
        </div>
      </div>
    </div>
  );
}

function LandingChatDemo() {
  return (
    <div className="card" style={{ boxShadow: "var(--shadow-lg)", padding: 28 }}>
      <div className="row" style={{ marginBottom: 20 }}>
        <BookCover book={SAMPLE_BOOKS[0]} size="sm" />
        <div style={{ marginLeft: 12 }}>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>Мастер и Маргарита</div>
          <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>Михаил Булгаков · 480 стр.</div>
        </div>
      </div>

      <div style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)", padding: "14px 16px" }}>
        <div className="mono" style={{ color: "var(--ink-faint)", marginBottom: 6 }}>Вы</div>
        <div style={{ color: "var(--ink)", fontSize: 14 }}>Почему Маргарита согласилась стать королевой бала?</div>
      </div>

      <div style={{ borderLeft: "2px solid var(--mark)", marginTop: 16, paddingLeft: 18 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>Ремарка</div>
        <div style={{ color: "var(--ink)", fontFamily: "var(--font-serif)", fontSize: 15, lineHeight: 1.55 }}>
          Не ради величия, а ради надежды: Азазелло обещает вернуть Мастера. Маргарита — женщина, у которой отняли смысл,
          и она соглашается на любое испытание, только бы его обрести обратно.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
          <div className="badge mark"><Quote size={14} /> гл. 19 · стр. 218</div>
          <div className="badge"><Quote size={14} /> гл. 20 · стр. 231</div>
          <div className="badge"><Quote size={14} /> гл. 22 · стр. 247</div>
        </div>
      </div>
    </div>
  );
}

const PRINCIPLES: Array<{ n: string; t: string; d: string; href: string; al: string }> = [
  { n: "i", t: "Каталог", d: "Сто книг — от Достоевского до Канемана. Открываете страницу книги и сразу видите анализ.", href: "/explore", al: "В каталог" },
  { n: "ii", t: "Анализ-витрина", d: "Описание, ключевая идея, герои, события — на одной странице, как авторский разбор.", href: "/explore", al: "Пример разбора" },
  { n: "iii", t: "Диалог с книгой", d: "AI-эксперт отвечает с цитатами и ссылками на страницы — ни слова без источника.", href: "/explore", al: "Открыть чат" },
  { n: "iv", t: "Вся библиотека", d: "Загрузите свои книги и задавайте вопросы сразу по всей полке.", href: "/library", al: "Мои книги" },
];

export function LandingPage() {
  return (
    <div className="screen-fade">
      {/* Hero */}
      <motion.section
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="container"
        style={{ paddingBottom: 64, paddingTop: 64 }}
      >
        <div
          className="landing-hero-grid"
          style={{ alignItems: "center", display: "grid", gap: 64, gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr)" }}
        >
          <div>
            <div className="mono" style={{ color: "var(--mark)", marginBottom: 24 }}>№ 001 · AI-чтение</div>
            <h1 style={{ fontSize: "clamp(46px, 7vw, 68px)", letterSpacing: "-0.025em", lineHeight: 1.02, textWrap: "balance" }}>
              Разговор с книгой,<br />
              как с автором, <span style={{ color: "var(--mark)", fontStyle: "italic" }}>лично</span>.
            </h1>
            <p className="soft" style={{ fontSize: 18, lineHeight: 1.55, marginTop: 28, maxWidth: 520, textWrap: "pretty" }}>
              Ремарка читает книгу за вас — и остаётся рядом, чтобы ответить на сложные вопросы,
              найти цитату, сравнить героев и свести всю вашу библиотеку в один диалог.
            </p>
            <div className="row" style={{ flexWrap: "wrap", marginTop: 36 }}>
              <Link className="btn btn-mark btn-lg" href="/explore">Открыть каталог <ArrowRight size={14} /></Link>
              <Link className="btn btn-ghost btn-lg" href="/upload"><Upload size={16} /> Загрузить свою книгу</Link>
            </div>
            <div className="row" style={{ gap: 32, marginTop: 48 }}>
              <div>
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 32, fontWeight: 500 }}>
                  98<span style={{ color: "var(--mark)" }}>.</span>
                </div>
                <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>Каталог открыт</div>
              </div>
              <div className="hr-v" style={{ height: 44 }} />
              <div>
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 32, fontWeight: 500 }}>EPUB · FB2 · PDF</div>
                <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>Форматы загрузки</div>
              </div>
            </div>
          </div>
          <HeroArt />
        </div>
      </motion.section>

      {/* Принципы */}
      <div className="hr" />
      <section className="container" style={{ paddingBottom: 72, paddingTop: 72 }}>
        <div style={{ marginBottom: 20 }}>
          <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>Как это устроено</div>
          <h2 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>Четыре разворота</h2>
        </div>
        <div className="landing-principles-grid" style={{ display: "grid", gap: 32, gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          {PRINCIPLES.map((it) => (
            <div key={it.n} className="stack-sm" style={{ paddingRight: 24 }}>
              <div className="mono" style={{ color: "var(--mark)", fontSize: 10 }}>{it.n}</div>
              <h3 style={{ fontSize: 22, marginBottom: 4, marginTop: 4 }}>{it.t}</h3>
              <p className="soft" style={{ fontSize: 14, lineHeight: 1.55 }}>{it.d}</p>
              <Link
                className="btn btn-plain btn-sm"
                href={it.href}
                style={{ justifyContent: "flex-start", marginTop: 8, paddingLeft: 0 }}
              >
                {it.al} <ArrowRight size={14} />
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Пример чата */}
      <section style={{ background: "var(--paper-2)", borderBottom: "1px solid var(--rule)", borderTop: "1px solid var(--rule)" }}>
        <div className="container" style={{ paddingBottom: 80, paddingTop: 80 }}>
          <div
            className="landing-chat-grid"
            style={{ alignItems: "center", display: "grid", gap: 64, gridTemplateColumns: "minmax(0,1fr) minmax(0,1.1fr)" }}
          >
            <div>
              <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>Пример</div>
              <h2 style={{ fontSize: 40, letterSpacing: "-0.02em", lineHeight: 1.1, textWrap: "balance" }}>
                Задайте вопрос, на который страница <span style={{ fontStyle: "italic" }}>не отвечает прямо</span>.
              </h2>
              <p className="soft" style={{ fontSize: 16, lineHeight: 1.6, marginTop: 18, maxWidth: 440 }}>
                Каждое утверждение модель подкрепляет цитатой с точным местом в книге. Вы видите, откуда пришёл ответ —
                и можете открыть это место одним кликом.
              </p>
              <Link className="btn btn-primary btn-lg" href="/explore" style={{ marginTop: 28 }}>
                Попробовать на «Мастере и Маргарите» <ArrowRight size={14} />
              </Link>
            </div>
            <LandingChatDemo />
          </div>
        </div>
      </section>

      {/* Свежие разборы */}
      <section className="container" style={{ paddingBottom: 80, paddingTop: 80 }}>
        <div
          style={{
            alignItems: "flex-end",
            display: "flex",
            gap: 24,
            justifyContent: "space-between",
            marginBottom: 20,
          }}
        >
          <div>
            <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>В каталоге</div>
            <h2 style={{ fontSize: 28, letterSpacing: "-0.015em" }}>Свежие разборы</h2>
          </div>
          <Link className="btn btn-ghost btn-sm" href="/explore">Все книги <ArrowRight size={14} /></Link>
        </div>
        <div className="landing-books-grid" style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
          {SAMPLE_BOOKS.slice(0, 6).map((book) => (
            <Link key={book.id} href={`/book/${book.id}`} className="book-card" style={{ display: "block" }}>
              <BookCover book={book} />
              <div className="meta">
                <div className="t">{book.title}</div>
                <div className="a">
                  {book.author}
                  {book.year ? `, ${book.year}` : ""}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Футер */}
      <footer style={{ background: "var(--paper-2)", borderTop: "1px solid var(--rule)" }}>
        <div className="container" style={{ paddingBottom: 56, paddingTop: 56 }}>
          <div
            style={{
              alignItems: "flex-end",
              display: "flex",
              flexWrap: "wrap",
              gap: 48,
              justifyContent: "space-between",
            }}
          >
            <div>
              <div className="logo" style={{ fontSize: 28 }}>
                ремарка<span className="dot">.</span>
              </div>
              <p className="muted" style={{ fontSize: 13, marginTop: 12, maxWidth: 320 }}>
                Литературный AI-сервис. На полях любой книги — ваш экземпляр с пометками, к которому можно вернуться.
              </p>
            </div>
            <div className="row-lg" style={{ fontSize: 13 }}>
              <Link className="nav-link" href="/explore">Каталог</Link>
              <Link className="nav-link" href="/explore">Блог</Link>
              <Link className="nav-link" href="/explore">Правовая информация</Link>
              <Link className="nav-link" href="/explore">Поддержка</Link>
            </div>
          </div>
          <div className="hr" style={{ marginBottom: 18, marginTop: 32 }} />
          <div className="row" style={{ flexWrap: "wrap", justifyContent: "space-between" }}>
            <div className="mono" style={{ color: "var(--ink-faint)" }}>© 2026 remarka · Made for readers</div>
            <div className="mono" style={{ color: "var(--ink-faint)" }}>Сделано для читателей</div>
          </div>
        </div>
      </footer>

      <style jsx>{`
        @media (max-width: 1024px) {
          .landing-hero-grid,
          .landing-chat-grid {
            grid-template-columns: 1fr !important;
          }
          .landing-hero-art {
            display: none !important;
          }
          .landing-principles-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
          .landing-books-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
          }
        }
        @media (max-width: 640px) {
          .landing-principles-grid {
            grid-template-columns: 1fr !important;
          }
          .landing-books-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
        }
      `}</style>
    </div>
  );
}
