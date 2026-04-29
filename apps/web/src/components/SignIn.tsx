"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { X } from "lucide-react";
import { useState } from "react";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.27-4.74 3.27-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.15-4.53H2.17v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.85 14.1a6.6 6.6 0 0 1 0-4.2V7.07H2.17a11 11 0 0 0 0 9.87l3.68-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.1 14.97 1 12 1 7.7 1 3.99 3.47 2.17 7.07l3.68 2.84C6.71 7.3 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

export function SignIn() {
  const searchParams = useSearchParams();
  const [consent, setConsent] = useState(false);

  const handleSignIn = () => {
    if (!consent) return;
    const callbackUrl = searchParams.get("callbackUrl") || "/explore";
    void signIn("google", { callbackUrl });
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
            Вход через Google — без паролей. Библиотека и история чата сохранятся между устройствами.
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
          <GoogleIcon /> Войти через Google
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
              Я принимаю{" "}
              <Link className="lnk" href="/legal/terms">
                Пользовательское соглашение
              </Link>{" "}
              и ознакомился с{" "}
              <Link className="lnk" href="/legal/privacy">
                Политикой обработки персональных данных
              </Link>
              . Обработка данных аккаунта, авторизации и истории чата — для исполнения договора об
              оказании услуг.
            </span>
          </label>
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
