"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { Sparkles } from "lucide-react";
import { currentUser } from "@/lib/mockData";
import { useTheme } from "@/lib/ThemeContext";

interface ProfileProps {
  authUser: {
    name: string | null;
    email: string | null;
    image: string | null;
  };
}

export function Profile({ authUser }: ProfileProps) {
  const displayName = authUser.name?.trim() || currentUser.name;
  const displayEmail = authUser.email?.trim() || currentUser.email;
  const initial = displayName.slice(0, 1).toUpperCase() || "А";
  const plan = currentUser.plan.type === "plus" ? "plus" : "free";
  const isPlus = plan === "plus";
  const { theme, setTheme } = useTheme();

  return (
    <div className="screen-fade">
      <div className="container-narrow" style={{ paddingBottom: 96, paddingTop: 56 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>
          Профиль
        </div>
        <div className="row" style={{ alignItems: "center", gap: 24 }}>
          <div className="avatar" style={{ fontSize: 28, height: 72, width: 72 }}>
            {authUser.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={authUser.image}
                alt=""
                style={{ height: "100%", objectFit: "cover", width: "100%" }}
              />
            ) : (
              initial
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ alignItems: "baseline", flexWrap: "wrap", gap: 12 }}>
              <h1 style={{ fontSize: 36, letterSpacing: "-0.02em", lineHeight: 1.08 }}>
                {displayName}
              </h1>
              {isPlus && (
                <div className="plan-pill plus">
                  <Sparkles size={14} /> Плюс
                </div>
              )}
            </div>
            <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 6 }}>
              {displayEmail} · Google
            </div>
          </div>
        </div>

        <div className="hr" style={{ margin: "40px 0" }} />

        <Section title="Оформление">
          <Row label="Тема">
            <div className="row-sm">
              {(["light", "dark"] as const).map((item) => (
                <button
                  key={item}
                  className={`chip ${theme === item ? "active" : ""}`}
                  onClick={() => setTheme(item)}
                >
                  {item === "light" ? "Светлая" : "Тёмная"}
                </button>
              ))}
            </div>
          </Row>
        </Section>

        <Section title="Приватность">
          <Row
            label="Cookie-файлы"
            sub="Необходимые cookie-файлы включены всегда. Аналитика — по согласию."
          >
            <Link className="chip active" href="/legal/cookies">
              Настройки
            </Link>
          </Row>
          <Row
            label="Загруженные книги"
            sub="Видны только вам. Не попадают в каталог, не используются для обучения моделей."
          >
            <div className="chip" style={{ cursor: "default" }}>
              Только для вас
            </div>
          </Row>
          <Row
            label="Документы"
            sub="Пользовательское соглашение, политика ПДн, условия загрузки."
          >
            <div className="row-sm" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Link className="chip" href="/legal/terms">
                Соглашение
              </Link>
              <Link className="chip" href="/legal/privacy">
                ПДн
              </Link>
              <Link className="chip" href="/legal/upload">
                Загрузка
              </Link>
            </div>
          </Row>
        </Section>

        <Section title="Подписка">
          <div style={{ padding: 24 }}>
            <div
              className="row"
              style={{
                alignItems: "flex-start",
                flexWrap: "wrap",
                gap: 20,
                justifyContent: "space-between",
              }}
            >
              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-serif)",
                      fontSize: 26,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {isPlus ? "Плюс" : "Читатель"}
                  </div>
                  <div className="mono" style={{ color: "var(--ink-muted)" }}>
                    {isPlus ? "390 ₽ / мес · активен" : "бесплатный · бессрочно"}
                  </div>
                </div>
                <p
                  className="soft"
                  style={{ fontSize: 14, lineHeight: 1.55, marginTop: 10, maxWidth: 440 }}
                >
                  {isPlus
                    ? "Полный доступ к ремарке: каталог, чат, загрузка и анализ собственных книг. Следующее списание 14 марта."
                    : "Вы можете читать, задавать вопросы и добавлять книги из каталога. Загрузка собственных книг — на тарифе Плюс."}
                </p>
              </div>
              <div
                className="row-sm"
                style={{ alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}
              >
                {isPlus ? (
                  <>
                    <Link className="btn btn-ghost btn-sm" href="/plans">
                      Сравнить
                    </Link>
                    <button
                      className="btn btn-plain btn-sm"
                      disabled
                      title="Billing backend пока не подключён"
                    >
                      Отменить подписку
                    </button>
                  </>
                ) : (
                  <>
                    <Link className="btn btn-plain btn-sm" href="/plans">
                      Сравнить тарифы
                    </Link>
                    <Link className="btn btn-mark" href="/plans">
                      <Sparkles size={14} /> Перейти на Плюс
                    </Link>
                  </>
                )}
              </div>
            </div>

            {!isPlus && (
              <div
                style={{
                  alignItems: "flex-start",
                  background: "var(--paper-2)",
                  border: "1px solid var(--rule)",
                  borderRadius: "var(--r)",
                  display: "flex",
                  gap: 12,
                  marginTop: 20,
                  padding: "14px 16px",
                }}
              >
                <div style={{ color: "var(--mark)", marginTop: 2 }}>
                  <Sparkles size={16} />
                </div>
                <div>
                  <div style={{ color: "var(--ink)", fontSize: 14 }}>Что откроет Плюс</div>
                  <div className="soft" style={{ fontSize: 13, lineHeight: 1.55, marginTop: 4 }}>
                    Загрузку книг в EPUB, FB2, PDF · персональный AI-разбор каждой · чат по
                    смешанной полке.
                  </div>
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section title="Аккаунт">
          <div className="row" style={{ flexWrap: "wrap", gap: 12, padding: "20px 20px" }}>
            <button className="btn btn-ghost" disabled title="Функция готовится">
              Выгрузить данные
            </button>
            <button
              className="btn btn-plain"
              onClick={() => void signOut({ callbackUrl: "/signin" })}
            >
              Выйти
            </button>
            <button
              className="btn btn-plain"
              disabled
              title="Функция готовится"
              style={{ color: "var(--mark)" }}
            >
              Удалить аккаунт
            </button>
          </div>
          <div
            className="soft"
            style={{
              borderTop: "1px solid var(--rule-soft)",
              fontSize: 13,
              lineHeight: 1.55,
              padding: "14px 20px",
            }}
          >
            Выгрузка данных и удаление аккаунта пока недоступны в интерфейсе. Эти функции готовятся.
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 40 }}>
      <h3 style={{ fontSize: 22, marginBottom: 18 }}>{title}</h3>
      <div className="card" style={{ padding: 4 }}>
        {children}
      </div>
    </div>
  );
}

function Row({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="profile-row">
      <div>
        <div style={{ color: "var(--ink)", fontSize: 15 }}>{label}</div>
        {sub && (
          <div className="soft" style={{ fontSize: 13, marginTop: 4, maxWidth: 420 }}>
            {sub}
          </div>
        )}
      </div>
      <div>{children}</div>
      <style jsx>{`
        .profile-row {
          align-items: center;
          border-bottom: 1px solid var(--rule-soft);
          display: flex;
          gap: 20px;
          justify-content: space-between;
          padding: 18px 20px;
        }

        @media (max-width: 680px) {
          .profile-row {
            align-items: flex-start;
            flex-direction: column;
          }
        }
      `}</style>
    </div>
  );
}
