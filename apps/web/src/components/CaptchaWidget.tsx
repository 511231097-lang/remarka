"use client";

import { useEffect, useRef, useState } from "react";

// Cloudflare Turnstile widget. Inert если NEXT_PUBLIC_CAPTCHA_SITE_KEY
// не задан (dev/local) — тогда сразу же зовёт onVerify(null), и серверная
// верификация в /lib/captcha.ts тоже становится no-op. На проде siteKey
// должен быть выставлен — иначе форма открывается ботам.
//
// Ref API: вызывающий код может прокинуть resetRef и потом сделать
// resetRef.current?.() чтобы перерисовать widget после ошибки сабмита.

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const SCRIPT_ID = "cf-turnstile-script";

interface TurnstileGlobal {
  render: (
    container: string | HTMLElement,
    options: {
      sitekey: string;
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
      size?: "normal" | "compact" | "flexible";
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
  }
}

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (document.getElementById(SCRIPT_ID)) {
    return new Promise((resolve) => {
      const check = () => {
        if (window.turnstile) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Turnstile script"));
    document.head.appendChild(script);
  });
}

interface CaptchaWidgetProps {
  siteKey: string | null;
  onVerify: (token: string | null) => void;
  resetRef?: { current: (() => void) | null };
}

export function CaptchaWidget({ siteKey, onVerify, resetRef }: CaptchaWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Без siteKey — сразу сообщаем "проверка пройдена" (dev mode).
    if (!siteKey) {
      onVerify(null);
      return;
    }

    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled) return;
        const turnstile = window.turnstile;
        const container = containerRef.current;
        if (!turnstile || !container) {
          setError("Не удалось загрузить captcha");
          return;
        }

        widgetIdRef.current = turnstile.render(container, {
          sitekey: siteKey,
          theme: "auto",
          size: "flexible",
          callback: (token) => {
            setError(null);
            onVerify(token);
          },
          "expired-callback": () => onVerify(null),
          "error-callback": () => {
            setError("Captcha не прошла. Обновите страницу и попробуйте ещё раз.");
            onVerify(null);
          },
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Не удалось загрузить captcha");
      });

    if (resetRef) {
      resetRef.current = () => {
        const turnstile = window.turnstile;
        if (turnstile && widgetIdRef.current) {
          turnstile.reset(widgetIdRef.current);
        }
        onVerify(null);
      };
    }

    return () => {
      cancelled = true;
      const turnstile = window.turnstile;
      if (turnstile && widgetIdRef.current) {
        try {
          turnstile.remove(widgetIdRef.current);
        } catch {
          // best-effort
        }
        widgetIdRef.current = null;
      }
      if (resetRef) {
        resetRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  if (!siteKey) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <div ref={containerRef} />
      {error ? (
        <div style={{ color: "var(--danger, #c53030)", fontSize: 12, marginTop: 6 }}>{error}</div>
      ) : null}
    </div>
  );
}
