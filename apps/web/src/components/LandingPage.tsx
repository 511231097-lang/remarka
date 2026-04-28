"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight, Quote, Upload } from "lucide-react";

const SAMPLE_BOOKS = [
  { id: "master", title: "Мастер и Маргарита", author: "Михаил Булгаков", tag: "Русская классика", cover: { bg: "oklch(42% 0.11 25)", fg: "oklch(96% 0.02 80)" } },
  { id: "anna", title: "Анна Каренина", author: "Лев Толстой", tag: "Русская классика", cover: { bg: "oklch(48% 0.09 55)", fg: "oklch(96% 0.02 85)" } },
  { id: "hundred", title: "Сто лет одиночества", author: "Габриэль Гарсиа Маркес", tag: "Зарубежная проза", cover: { bg: "oklch(52% 0.14 50)", fg: "oklch(97% 0.015 85)" } },
  { id: "crime", title: "Преступление и наказание", author: "Фёдор Достоевский", tag: "Русская классика", cover: { bg: "oklch(28% 0.04 260)", fg: "oklch(94% 0.03 85)" } },
  { id: "1984", title: "1984", author: "Джордж Оруэлл", tag: "Зарубежная проза", cover: { bg: "oklch(32% 0.03 30)", fg: "oklch(95% 0.02 85)" } },
  { id: "sapiens", title: "Sapiens. Краткая история человечества", author: "Юваль Ной Харари", tag: "Нон-фикшн", cover: { bg: "oklch(88% 0.04 85)", fg: "oklch(22% 0.02 60)" } },
];

function BookCover({ book, size = "md" }: { book: (typeof SAMPLE_BOOKS)[number]; size?: "sm" | "md" | "lg" }) {
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
    <div className="hidden lg:block" style={{ height: 520, position: "relative" }}>
      <div style={{ left: 0, position: "absolute", top: 40, transform: "rotate(-6deg)", width: 200 }}>
        <BookCover book={SAMPLE_BOOKS[1]} size="lg" />
      </div>
      <div style={{ left: 140, position: "absolute", top: 0, width: 240, zIndex: 2 }}>
        <BookCover book={SAMPLE_BOOKS[0]} size="lg" />
      </div>
      <div style={{ position: "absolute", right: 0, top: 60, transform: "rotate(5deg)", width: 200 }}>
        <BookCover book={SAMPLE_BOOKS[2]} size="lg" />
      </div>
      <div style={{ left: 220, pointerEvents: "none", position: "absolute", top: 240, zIndex: 4 }}>
        <svg width="280" height="120" viewBox="0 0 280 120" fill="none" aria-hidden="true">
          <path d="M 10 60 C 60 20, 120 90, 200 50 S 270 70, 270 70" stroke="var(--mark)" strokeLinecap="round" strokeWidth="3" />
        </svg>
      </div>
      <div style={{ background: "var(--cream)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", bottom: 10, boxShadow: "var(--shadow)", padding: 16, position: "absolute", right: -10, transform: "rotate(3deg)", width: 220, zIndex: 5 }}>
        <div className="mono" style={{ color: "var(--mark)", fontSize: 9, marginBottom: 8 }}>Ремарка AI · стр. 247</div>
        <div style={{ color: "var(--ink)", fontFamily: "var(--font-serif)", fontSize: 14, lineHeight: 1.4 }}>
          «Трусость - самый страшный порок», - говорит Иешуа. Это не случайная фраза, а камертон всего романа.
        </div>
      </div>
    </div>
  );
}

function LandingChatDemo() {
  return (
    <div className="card" style={{ boxShadow: "var(--shadow-lg)", padding: 28 }}>
      <div className="row" style={{ marginBottom: 20 }}>
        <div style={{ width: 36 }}><BookCover book={SAMPLE_BOOKS[0]} size="sm" /></div>
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
          Не ради величия, а ради надежды: Азазелло обещает вернуть Мастера. Маргарита соглашается на любое испытание, только бы обрести его обратно.
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

export function LandingPage() {
  return (
    <div className="screen-fade">
      <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="container" style={{ paddingBottom: 64, paddingTop: 64 }}>
        <div style={{ alignItems: "center", display: "grid", gap: 64, gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr)" }} className="landing-hero-grid">
          <div>
            <div className="mono" style={{ color: "var(--mark)", marginBottom: 24 }}>№ 001 · AI-чтение</div>
            <h1 style={{ fontSize: "clamp(46px, 7vw, 68px)", letterSpacing: 0, lineHeight: 1.02 }}>
              Разговор с книгой,<br />
              как с автором, <span style={{ color: "var(--mark)", fontStyle: "italic" }}>лично</span>.
            </h1>
            <p className="soft" style={{ fontSize: 18, lineHeight: 1.55, marginTop: 28, maxWidth: 520 }}>
              Ремарка читает книгу за вас - и остаётся рядом, чтобы ответить на сложные вопросы,
              найти цитату, сравнить героев и свести всю вашу библиотеку в один диалог.
            </p>
            <div className="row" style={{ flexWrap: "wrap", marginTop: 36 }}>
              <Link className="btn btn-mark btn-lg" href="/explore">Открыть каталог <ArrowRight size={14} /></Link>
              <Link className="btn btn-ghost btn-lg" href="/upload"><Upload size={16} /> Загрузить свою книгу</Link>
            </div>
            <div className="row" style={{ gap: 32, marginTop: 48 }}>
              <div>
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 32, fontWeight: 500 }}>98<span style={{ color: "var(--mark)" }}>.</span></div>
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

      <div className="hr" />
      <section className="container" style={{ paddingBottom: 72, paddingTop: 72 }}>
        <div style={{ marginBottom: 20 }}>
          <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>Как это устроено</div>
          <h2 style={{ fontSize: 28 }}>Четыре разворота</h2>
        </div>
        <div style={{ display: "grid", gap: 32, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
          {[
            ["i", "Каталог", "Сто книг - от Достоевского до Канемана. Открываете страницу книги и сразу видите анализ.", "/explore", "В каталог"],
            ["ii", "Анализ-витрина", "Описание, ключевая идея, герои, события - на одной странице, как авторский разбор.", "/explore", "Пример разбора"],
            ["iii", "Диалог с книгой", "AI-эксперт отвечает с цитатами и ссылками на страницы - ни слова без источника.", "/explore", "Открыть чат"],
            ["iv", "Вся библиотека", "Загрузите свои книги и задавайте вопросы сразу по всей полке.", "/library", "Мои книги"],
          ].map(([n, title, desc, href, action]) => (
            <div key={n} className="stack-sm" style={{ paddingRight: 24 }}>
              <div className="mono" style={{ color: "var(--mark)", fontSize: 10 }}>{n}</div>
              <h3 style={{ fontSize: 22, marginTop: 4 }}>{title}</h3>
              <p className="soft" style={{ fontSize: 14, lineHeight: 1.55 }}>{desc}</p>
              <Link className="btn btn-plain btn-sm" style={{ justifyContent: "flex-start", marginTop: 8, paddingLeft: 0 }} href={href}>
                {action} <ArrowRight size={14} />
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section style={{ background: "var(--paper-2)", borderBottom: "1px solid var(--rule)", borderTop: "1px solid var(--rule)" }}>
        <div className="container" style={{ paddingBottom: 80, paddingTop: 80 }}>
          <div style={{ alignItems: "center", display: "grid", gap: 64, gridTemplateColumns: "minmax(0,1fr) minmax(0,1.1fr)" }} className="landing-chat-grid">
            <div>
              <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>Пример</div>
              <h2 style={{ fontSize: 40, letterSpacing: 0, lineHeight: 1.1 }}>
                Задайте вопрос, на который страница <span style={{ fontStyle: "italic" }}>не отвечает прямо</span>.
              </h2>
              <p className="soft" style={{ fontSize: 16, lineHeight: 1.6, marginTop: 18, maxWidth: 440 }}>
                Каждое утверждение модель подкрепляет цитатой с точным местом в книге.
              </p>
              <Link className="btn btn-primary btn-lg" style={{ marginTop: 28 }} href="/explore">
                Попробовать на «Мастере и Маргарите» <ArrowRight size={14} />
              </Link>
            </div>
            <LandingChatDemo />
          </div>
        </div>
      </section>

      <section className="container" style={{ paddingBottom: 80, paddingTop: 80 }}>
        <div className="row" style={{ alignItems: "flex-end", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <div className="mono" style={{ color: "var(--mark)", marginBottom: 8 }}>В каталоге</div>
            <h2 style={{ fontSize: 28 }}>Свежие разборы</h2>
          </div>
          <Link className="btn btn-ghost btn-sm" href="/explore">Все книги <ArrowRight size={14} /></Link>
        </div>
        <div style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
          {SAMPLE_BOOKS.map((book) => (
            <div key={book.id} className="book-card">
              <BookCover book={book} />
              <div className="meta">
                <div className="t">{book.title}</div>
                <div className="a">{book.author}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <style jsx>{`
        @media (max-width: 1024px) {
          .landing-hero-grid,
          .landing-chat-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
