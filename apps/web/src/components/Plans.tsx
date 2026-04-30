"use client";

import { useState } from "react";
import { ArrowRight, Check, Plus } from "lucide-react";

// TODO: replace this mock with real subscription state from session/billing
// when a paid tier is live. For now we hard-code "free" since billing is
// not wired yet — keeps the page rendering exactly as before with the
// removed mockData fixture.
const currentUser: { plan: { type: "free" | "plus" } } = {
  plan: { type: "free" },
};

const freeFeatures: ReadonlyArray<readonly [string, boolean]> = [
  ["Полный каталог из 98 книг", true],
  ["Чат с любой книгой из каталога", true],
  ["Разбор-витрина на странице книги", true],
  ["Добавление книг из каталога в «Мои книги»", true],
  ["Чат по всей библиотеке — до 10 книг", true],
  ["Загрузка своих книг (EPUB · FB2 · PDF)", false],
  ["Персональный анализ загруженных книг", false],
  ["Разговор со смешанной полкой (свои + каталог)", false],
];

const plusFeatures: readonly string[] = [
  "Всё из бесплатного тарифа",
  "Загрузка своих книг в любом формате",
  "Глубокий анализ загруженных книг",
  "Чат по смешанной библиотеке без ограничений",
  "До 200 книг в личной полке",
  "Экспорт разбора и цитат в Markdown",
  "Приоритетная обработка — ~1 мин на книгу",
  "Поддержка по email в течение 24 часов",
];

const faqItems: ReadonlyArray<readonly [string, string]> = [
  [
    "Можно ли пользоваться бесплатно всегда?",
    "Да. Бесплатный тариф — бессрочный. Каталог из 98 книг, чат с каждой из них и общий чат по вашей полке из каталога доступны без ограничений по времени.",
  ],
  [
    "Что происходит с загруженными книгами, если отменить Плюс?",
    "Книги остаются в вашей библиотеке и доступны для чтения и экспорта цитат. Чат по ним ставится на паузу до следующей подписки. Никто кроме вас эти файлы не видит.",
  ],
  [
    "Используются ли мои книги для обучения моделей?",
    "Нет. Загруженные файлы обрабатываются только для построения вашего разбора и не передаются ни в тренировочные наборы, ни в общий каталог.",
  ],
  [
    "Как отменить подписку?",
    "В профиле в разделе «Подписка» — одной кнопкой. Подписка действует до конца оплаченного периода, автопродления не будет.",
  ],
  [
    "Есть ли годовой тариф?",
    "Пока нет. Мы хотим, чтобы вы платили только за месяцы, когда читаете активно.",
  ],
];

export function Plans() {
  const isPlus = currentUser.plan.type === "plus";

  return (
    <div className="screen-fade">
      <div
        className="container-narrow"
        style={{ paddingBottom: 24, paddingTop: 72, textAlign: "center" }}
      >
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>
          Тарифы · выберите полку
        </div>
        <h1
          style={{
            fontSize: "clamp(42px, 7vw, 56px)",
            letterSpacing: "-0.025em",
            lineHeight: 1.02,
            textWrap: "balance",
          }}
        >
          Читайте бесплатно.
          <br />
          <span style={{ color: "var(--mark)", fontStyle: "italic" }}>Пишите</span> на Плюсе.
        </h1>
        <p
          className="soft"
          style={{
            fontSize: 17,
            lineHeight: 1.6,
            margin: "22px auto 0",
            maxWidth: 560,
            textWrap: "pretty",
          }}
        >
          Каталог и разговор с книгами — бесплатно и без ограничений. Плюс открывает возможность
          загружать и анализировать собственные книги.
        </p>
      </div>

      <div className="container" style={{ paddingBottom: 96, paddingTop: 48 }}>
        <div
          style={{
            display: "grid",
            gap: 28,
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            margin: "0 auto",
            maxWidth: 960,
          }}
        >
          <PlanCard
            eyebrow="Тариф · 01"
            title="Читатель"
            price="0"
            suffix="₽ / бессрочно"
            current={!isPlus}
            body="Читайте, спрашивайте, собирайте цитаты. Всё, что есть в каталоге ремарки, — ваше."
            features={freeFeatures.map(([t, on]) => ({ t, on }))}
            action={isPlus ? "Перейти на Читателя" : "Текущий план"}
            disabled={!isPlus}
          />
          <PlanCard
            eyebrow="Тариф · 02"
            title="Плюс"
            price="390"
            suffix="₽ / месяц"
            current={isPlus}
            mark
            body="Вся ремарка плюс загрузка собственных книг. Отмена в один клик — без сроков и штрафов."
            features={plusFeatures.map((t) => ({ t, on: true }))}
            action={isPlus ? "Вы на Плюсе" : "Перейти на Плюс"}
            disabled={isPlus}
          />
        </div>

        <div style={{ margin: "96px auto 0", maxWidth: 720 }}>
          <div
            className="mono"
            style={{ color: "var(--mark)", marginBottom: 12, textAlign: "center" }}
          >
            Частые вопросы
          </div>
          <h2
            style={{
              fontSize: 32,
              letterSpacing: "-0.02em",
              marginBottom: 40,
              textAlign: "center",
            }}
          >
            Коротко о тарифах
          </h2>
          {faqItems.map(([q, a]) => (
            <FAQRow key={q} q={q} a={a} />
          ))}
        </div>

        <div
          className="mono"
          style={{
            color: "var(--ink-faint)",
            fontSize: 11,
            letterSpacing: ".06em",
            marginTop: 64,
            textAlign: "center",
          }}
        >
          Оплата принимается через защищённый платёжный шлюз. НДС включён. Отмена в один клик.
        </div>
      </div>
    </div>
  );
}

function PlanCard({
  eyebrow,
  title,
  price,
  suffix,
  body,
  features,
  current,
  mark,
  action,
  disabled,
}: {
  eyebrow: string;
  title: string;
  price: string;
  suffix: string;
  body: string;
  features: Array<{ t: string; on: boolean }>;
  current: boolean;
  mark?: boolean;
  action: string;
  disabled: boolean;
}) {
  return (
    <div
      className="card"
      style={{
        background: mark ? "var(--paper-2)" : "var(--cream)",
        border: mark ? "1px solid var(--mark)" : undefined,
        boxShadow: mark ? "0 0 0 1px var(--mark-soft) inset, var(--shadow-lg)" : undefined,
        padding: 36,
        position: "relative",
      }}
    >
      <div
        className="mono"
        style={{
          alignItems: "center",
          color: mark ? "var(--mark)" : "var(--ink-muted)",
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span>{eyebrow}</span>
        {mark && (
          <span
            style={{
              background: "var(--mark)",
              borderRadius: 100,
              color: "#fff",
              fontSize: 9.5,
              letterSpacing: ".08em",
              padding: "3px 10px",
            }}
          >
            Для пишущих
          </span>
        )}
      </div>
      <div
        style={{
          alignItems: "baseline",
          display: "flex",
          gap: 12,
          justifyContent: "space-between",
        }}
      >
        <h2 style={{ fontSize: 36, letterSpacing: "-0.02em" }}>{title}</h2>
        {current && <div className="badge mark">Ваш план</div>}
      </div>
      <div style={{ alignItems: "baseline", display: "flex", gap: 8, marginTop: 20 }}>
        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 56,
            fontWeight: 500,
            letterSpacing: "-0.02em",
          }}
        >
          {price}
          <span style={{ color: "var(--mark)" }}>.</span>
        </div>
        <div className="mono" style={{ color: "var(--ink-muted)" }}>
          {suffix}
        </div>
      </div>
      <p className="soft" style={{ fontSize: 14, lineHeight: 1.55, marginTop: 14 }}>
        {body}
      </p>
      <div className="hr" style={{ margin: "28px 0 24px" }} />
      <ul
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          listStyle: "none",
          margin: 0,
          padding: 0,
        }}
      >
        {features.map((feature) => (
          <FeatureLine key={feature.t} {...feature} mark={mark} />
        ))}
      </ul>
      <button
        className={`btn ${mark ? "btn-mark" : "btn-ghost"} btn-lg btn-block`}
        disabled={disabled}
        style={{
          justifyContent: "center",
          marginTop: 32,
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {action} {!disabled && mark && <ArrowRight size={14} />}
      </button>
    </div>
  );
}

function FeatureLine({ on, t, mark }: { on: boolean; t: string; mark?: boolean }) {
  return (
    <li
      style={{
        alignItems: "flex-start",
        color: on ? "var(--ink)" : "var(--ink-faint)",
        display: "flex",
        fontSize: 14,
        gap: 12,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: on ? (mark ? "var(--mark)" : "var(--ink)") : "transparent",
          border: on ? "none" : "1px solid var(--rule)",
          borderRadius: "50%",
          color: "#fff",
          display: "flex",
          flexShrink: 0,
          height: 18,
          justifyContent: "center",
          marginTop: 2,
          width: 18,
        }}
      >
        {on ? (
          <Check size={12} strokeWidth={2.5} />
        ) : (
          <span style={{ background: "var(--ink-faint)", height: 1, width: 8 }} />
        )}
      </div>
      <span
        style={{
          textDecoration: on ? "none" : "line-through",
          textDecorationColor: "var(--ink-faint)",
        }}
      >
        {t}
      </span>
    </li>
  );
}

function FAQRow({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid var(--rule)", padding: "20px 0" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          alignItems: "center",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          display: "flex",
          gap: 20,
          justifyContent: "space-between",
          padding: 0,
          width: "100%",
        }}
      >
        <div
          style={{
            color: "var(--ink)",
            fontFamily: "var(--font-serif)",
            fontSize: 18,
            textAlign: "left",
          }}
        >
          {q}
        </div>
        <div
          style={{
            alignItems: "center",
            border: "1px solid var(--rule)",
            borderRadius: "50%",
            display: "flex",
            flexShrink: 0,
            height: 28,
            justifyContent: "center",
            transform: open ? "rotate(45deg)" : "none",
            transition: "transform .2s",
            width: 28,
          }}
        >
          <Plus size={16} />
        </div>
      </button>
      {open && (
        <p className="soft" style={{ fontSize: 15, lineHeight: 1.6, marginTop: 14, maxWidth: 600 }}>
          {a}
        </p>
      )}
    </div>
  );
}
