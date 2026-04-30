"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { X } from "lucide-react";

const COOKIE_NAME = "remarka_cookie_consent";
const COOKIE_VALUE = "saved";
const STORAGE_KEY = "remarka_cookie_consent";
const PREFS_KEY = "remarka_cookie_prefs";
const COOKIE_TTL_SECONDS = 60 * 60 * 24 * 365;

interface CookiePrefs {
  analytics: boolean;
  perso: boolean;
}

function hasCookieConsent(): boolean {
  if (typeof document === "undefined") return false;
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.split("=")[1];
  return value === COOKIE_VALUE || window.localStorage.getItem(STORAGE_KEY) === COOKIE_VALUE;
}

function persistCookieConsent(prefs: CookiePrefs) {
  if (typeof document === "undefined") return;
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  document.cookie = `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=${COOKIE_TTL_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`;
  window.localStorage.setItem(STORAGE_KEY, COOKIE_VALUE);
  window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function CookieRow({
  title,
  desc,
  checked,
  onChange,
  locked,
}: {
  title: string;
  desc: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  locked?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        padding: "16px 18px",
        background: "var(--paper-2)",
        border: "1px solid var(--rule)",
        borderRadius: "var(--r)",
      }}
    >
      <div className="grow">
        <div style={{ fontWeight: 500, fontSize: 15 }}>{title}</div>
        <div style={{ fontSize: 13, color: "var(--ink-muted)", marginTop: 4, lineHeight: 1.5 }}>
          {desc}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>
        {locked ? (
          <div className="chip active" style={{ fontSize: 11 }}>
            Всегда
          </div>
        ) : (
          <label className="switch">
            <input
              type="checkbox"
              checked={Boolean(checked)}
              onChange={(event) => onChange?.(event.target.checked)}
            />
            <span className="switch-track" />
          </label>
        )}
      </div>
    </div>
  );
}

function CookieSettings({
  initial,
  onClose,
  onSave,
}: {
  initial: CookiePrefs;
  onClose: () => void;
  onSave: (prefs: CookiePrefs) => void;
}) {
  const [analytics, setAnalytics] = useState(initial.analytics);
  const [perso, setPerso] = useState(initial.perso);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog"
        style={{ maxWidth: 520 }}
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
            <div className="mono eyebrow">Cookie-файлы</div>
            <h2 style={{ fontSize: 24, marginTop: 6 }}>Настройки cookie-файлов</h2>
          </div>
          <button
            className="btn-plain"
            style={{ padding: 6 }}
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X size={16} />
          </button>
        </div>
        <div className="stack">
          <CookieRow
            title="Необходимые"
            locked
            desc="Авторизация, сессия, защита от CSRF. Без них сайт не работает."
          />
          <CookieRow
            title="Аналитика"
            checked={analytics}
            onChange={setAnalytics}
            desc="Помогают понять, какие разделы полезны, а какие — нет. Обезличенные."
          />
          <CookieRow
            title="Персонализация"
            checked={perso}
            onChange={setPerso}
            desc="Рекомендации книг, недавние чаты, предпочтения отображения."
          />
        </div>
        <div className="row" style={{ justifyContent: "flex-end", gap: 10, marginTop: 24 }}>
          <button
            className="btn btn-plain btn-sm"
            onClick={() => onSave({ analytics: false, perso: false })}
          >
            Отклонить всё
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => onSave({ analytics, perso })}>
            Сохранить выбор
          </button>
        </div>
      </div>
    </div>
  );
}

export function CookieConsentBanner() {
  const [visible, setVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = useState<CookiePrefs>({ analytics: true, perso: true });

  useEffect(() => {
    setVisible(!hasCookieConsent());
    try {
      const saved = window.localStorage.getItem(PREFS_KEY);
      if (saved) setPrefs(JSON.parse(saved));
    } catch {
      setPrefs({ analytics: true, perso: true });
    }
  }, []);

  if (!visible && !settingsOpen) return null;

  const save = (nextPrefs: CookiePrefs) => {
    setPrefs(nextPrefs);
    persistCookieConsent(nextPrefs);
    setVisible(false);
    setSettingsOpen(false);
  };

  return (
    <>
      {visible && (
        <div className="cookie-banner">
          <div className="grow">
            <div
              style={{ fontSize: 14, color: "var(--ink)", marginBottom: 4, fontWeight: 500 }}
            >
              Про cookie-файлы
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-muted)", lineHeight: 1.5 }}>
              Необходимые cookie-файлы включены всегда — без них не работает вход и сессия.
              Аналитику и персонализацию включаем только по вашему согласию.{" "}
              <Link className="lnk" href="/legal/cookies">
                О cookie-файлах
              </Link>
              {" · "}
              <Link className="lnk" href="/legal/privacy">
                Политика ПДн
              </Link>
            </div>
          </div>
          <div className="row-sm" style={{ flexShrink: 0, flexWrap: "wrap", gap: 8 }}>
            <button className="btn btn-plain btn-sm" onClick={() => setSettingsOpen(true)}>
              Настроить
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => save({ analytics: true, perso: true })}
            >
              Принять всё
            </button>
          </div>
        </div>
      )}
      {settingsOpen && (
        <CookieSettings
          initial={prefs}
          onClose={() => setSettingsOpen(false)}
          onSave={save}
        />
      )}
    </>
  );
}
