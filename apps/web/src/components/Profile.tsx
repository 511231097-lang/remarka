"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { Sparkles, X, AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { currentUser } from "@/lib/mockData";
import { useTheme } from "@/lib/ThemeContext";

// Confirmation token must match the one enforced server-side in
// apps/web/src/app/api/profile/account/route.ts. Keep them in sync.
const DELETE_CONFIRMATION = "УДАЛИТЬ";

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
  const [deleteOpen, setDeleteOpen] = useState(false);

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
            <button
              className="btn btn-plain"
              onClick={() => void signOut({ callbackUrl: "/signin" })}
            >
              Выйти
            </button>
            <button
              className="btn btn-plain"
              onClick={() => setDeleteOpen(true)}
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
            При удалении аккаунта стираются все ваши книги, история чатов, результаты
            анализа и настройки. Восстановить эти данные после удаления невозможно.
          </div>
        </Section>
      </div>
      {deleteOpen && <DeleteAccountDialog onClose={() => setDeleteOpen(false)} />}
    </div>
  );
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete =
    confirmation.trim().toUpperCase() === DELETE_CONFIRMATION && !submitting;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose, submitting]);

  const handleDelete = async () => {
    if (!canDelete) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/profile/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: DELETE_CONFIRMATION }),
      });
      if (!res.ok && res.status !== 204) {
        let message = `Ошибка ${res.status}`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // Ignore — keep the generic message.
        }
        throw new Error(message);
      }
      // Drop the next-auth session and bounce to the landing page. We
      // pick / over /signin because the account no longer exists, and
      // /signin would be the immediate next step anyway from /.
      await signOut({ callbackUrl: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось удалить аккаунт");
      setSubmitting(false);
    }
  };

  return (
    <div className="overlay" onClick={() => !submitting && onClose()}>
      <div
        className="dialog"
        style={{ maxWidth: 480 }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 18,
          }}
        >
          <div>
            <div
              className="mono eyebrow"
              style={{ color: "var(--mark)", display: "flex", alignItems: "center", gap: 6 }}
            >
              <AlertTriangle size={12} /> Необратимое действие
            </div>
            <h2 style={{ fontSize: 24, marginTop: 6 }}>Удалить аккаунт</h2>
          </div>
          <button
            className="btn-plain"
            style={{ padding: 6 }}
            onClick={() => !submitting && onClose()}
            aria-label="Закрыть"
            disabled={submitting}
          >
            <X size={16} />
          </button>
        </div>

        <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink-soft)" }}>
          Будут безвозвратно удалены: ваша учётная запись, все загруженные книги,
          история чатов, результаты анализа и настройки. Файлы из активных хранилищ
          стираются сразу; из резервных копий — в течение 60 дней по графику.
        </p>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink-soft)", marginTop: 10 }}>
          Чтобы подтвердить, введите слово{" "}
          <span className="mono" style={{ color: "var(--mark)" }}>
            {DELETE_CONFIRMATION}
          </span>{" "}
          в поле ниже.
        </p>

        <input
          type="text"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={DELETE_CONFIRMATION}
          autoFocus
          disabled={submitting}
          style={{
            background: "var(--paper-2)",
            border: "1px solid var(--rule)",
            borderRadius: "var(--r)",
            color: "var(--ink)",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            marginTop: 14,
            padding: "10px 14px",
            width: "100%",
          }}
        />

        {error && (
          <div
            style={{
              alignItems: "center",
              borderColor: "var(--mark)",
              color: "var(--mark)",
              display: "flex",
              fontSize: 13,
              gap: 8,
              marginTop: 12,
            }}
          >
            <AlertTriangle size={14} />
            {error}
          </div>
        )}

        <div className="row" style={{ gap: 10, justifyContent: "flex-end", marginTop: 22 }}>
          <button
            type="button"
            className="btn btn-plain btn-sm"
            onClick={onClose}
            disabled={submitting}
          >
            Отмена
          </button>
          <button
            type="button"
            className="btn btn-mark btn-sm"
            onClick={() => void handleDelete()}
            disabled={!canDelete}
            style={{ opacity: canDelete ? 1 : 0.5 }}
          >
            {submitting ? "Удаление…" : "Удалить безвозвратно"}
          </button>
        </div>
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
