"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { X } from "lucide-react";
import { useState } from "react";
import { logLegalConsent } from "@/lib/legalConsentClient";

function YandexIcon() {
  // Иконическая буква «Я» Yandex'а в его фирменном красном квадрате.
  // Делается inline-стилем — без SVG-зависимостей и без image hotlinking.
  return (
    <span
      aria-hidden="true"
      style={{
        alignItems: "center",
        background: "#FC3F1D",
        borderRadius: 4,
        color: "#fff",
        display: "inline-flex",
        flexShrink: 0,
        fontSize: 13,
        fontWeight: 700,
        height: 18,
        justifyContent: "center",
        lineHeight: 1,
        width: 18,
      }}
    >
      Я
    </span>
  );
}

export function SignIn() {
  const searchParams = useSearchParams();
  const [consent, setConsent] = useState(false);

  const handleSignIn = () => {
    if (!consent) return;
    // Log the consent BEFORE the OAuth redirect — даже если пользователь
    // не завершит OAuth flow, у нас будет запись что галку он поставил.
    // Endpoint связывает по userId post-hoc когда session появится.
    void logLegalConsent({ consentType: "signin_acceptance" });
    const callbackUrl = searchParams.get("callbackUrl") || "/explore";
    void signIn("yandex", { callbackUrl });
  };

  return (
    <div
      className="screen-fade"
      style={{
        alignItems: "center",
        display: "flex",
        justifyContent: "center",
        minHeight: "calc(100svh - 64px)",
        padding: "48px 20px",
      }}
    >
      <div className="dialog" style={{ maxWidth: 440, width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -16 }}>
          <Link
            href="/"
            className="btn-plain"
            style={{ borderRadius: 6, padding: 6 }}
            aria-label="Закрыть"
          >
            <X size={16} />
          </Link>
        </div>

        <div style={{ marginBottom: 24, textAlign: "center" }}>
          <Link
            href="/"
            className="logo"
            style={{ display: "inline-flex", fontSize: 28, justifyContent: "center" }}
          >
            ремарка<span className="dot">.</span>
          </Link>
          <h1 style={{ fontSize: 24, marginTop: 14, textWrap: "balance" }}>
            Войдите, чтобы начать разговор с книгой
          </h1>
          <p
            className="muted"
            style={{ fontSize: 14, lineHeight: 1.55, marginTop: 10, textWrap: "balance" }}
          >
            Вход через Яндекс ID — без паролей. Библиотека и история чата сохранятся между устройствами.
          </p>
        </div>

        <button
          type="button"
          className={`btn btn-lg btn-block ${consent ? "btn-ghost" : ""}`}
          disabled={!consent}
          onClick={handleSignIn}
          style={{
            cursor: consent ? "pointer" : "not-allowed",
            gap: 12,
            justifyContent: "center",
            opacity: consent ? 1 : 0.55,
          }}
        >
          <YandexIcon /> Войти через Яндекс
        </button>

        <div style={{ marginTop: 18 }}>
          <label
            style={{
              alignItems: "flex-start",
              color: "var(--ink-soft)",
              cursor: "pointer",
              display: "flex",
              fontSize: 13,
              gap: 10,
              lineHeight: 1.55,
            }}
          >
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              style={{ accentColor: "var(--ink)", flexShrink: 0, marginTop: 3 }}
            />
            <span>
              Мне 18 лет или больше. Я принимаю{" "}
              <Link className="lnk" href="/legal/terms">
                Пользовательское соглашение
              </Link>{" "}
              и{" "}
              <Link className="lnk" href="/legal/privacy">
                Политику обработки персональных данных
              </Link>
              . Я согласен(-на) на передачу содержимого моих запросов и фрагментов
              загруженных файлов компании Google LLC (США) для работы AI-ассистента — это
              трансграничная передача персональных данных в страну, не входящую в перечень
              государств с адекватной защитой прав субъектов персональных данных.
              Идентификационные данные (имя, e-mail) при этом в США не передаются.
            </span>
          </label>
        </div>

        <div
          className="muted"
          style={{
            color: "var(--ink-faint)",
            fontSize: 12,
            lineHeight: 1.5,
            marginTop: 16,
            textAlign: "center",
          }}
        >
          Защита от ботов работает на технологии Yandex SmartCaptcha. При прохождении
          проверки обрабатываются IP-адрес и поведенческие сигналы — подробнее в{" "}
          <Link className="lnk" href="/legal/privacy">
            Политике обработки персональных данных
          </Link>
          .
        </div>

        <div
          className="mono"
          style={{
            color: "var(--ink-faint)",
            fontSize: 10,
            letterSpacing: "0.08em",
            marginTop: 20,
            textAlign: "center",
          }}
        >
          OAuth 2.0 · защищённое соединение
        </div>
      </div>
    </div>
  );
}
