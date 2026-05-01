"use client";

import { useEffect, useRef, useState } from "react";

// Captcha widget с поддержкой двух провайдеров:
//  - Cloudflare Turnstile (NEXT_PUBLIC_CAPTCHA_PROVIDER=turnstile)
//  - Yandex SmartCaptcha (NEXT_PUBLIC_CAPTCHA_PROVIDER=smartcaptcha) — RU-домашний
//
// Inert если NEXT_PUBLIC_CAPTCHA_SITE_KEY не задан (dev/local) — тогда сразу
// зовёт onVerify(null), и серверная верификация в /lib/captcha.ts тоже становится no-op.
// На проде siteKey + provider должны быть выставлены.
//
// Ref API: вызывающий код может прокинуть resetRef и потом сделать
// resetRef.current?.() чтобы перерисовать widget после ошибки сабмита.

type CaptchaProvider = "turnstile" | "smartcaptcha";

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const TURNSTILE_SCRIPT_ID = "cf-turnstile-script";
const SMARTCAPTCHA_SCRIPT_SRC = "https://smartcaptcha.yandexcloud.net/captcha.js";
const SMARTCAPTCHA_SCRIPT_ID = "ya-smartcaptcha-script";

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

interface SmartCaptchaGlobal {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback?: (token: string) => void;
      // У SmartCaptcha есть additional options: hl (язык), test, webview, и т.д.
      hl?: "ru" | "en" | "be" | "kk" | "tt" | "uk" | "uz" | "tr";
      invisible?: boolean;
      shieldPosition?: "top-left" | "center-left" | "bottom-left" | "top-right" | "center-right" | "bottom-right";
      hideShield?: boolean;
    },
  ) => number;
  reset: (widgetId?: number) => void;
  destroy: (widgetId?: number) => void;
  getResponse: (widgetId?: number) => string;
  subscribe: (
    widgetId: number,
    eventName: "challenge-visible" | "challenge-hidden" | "network-error" | "success" | "token-expired",
    callback: (data?: unknown) => void,
  ) => () => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal;
    smartCaptcha?: SmartCaptchaGlobal;
  }
}

function loadScript(src: string, id: string, globalKey: "turnstile" | "smartCaptcha"): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window[globalKey]) return Promise.resolve();
  if (document.getElementById(id)) {
    return new Promise((resolve) => {
      const check = () => {
        if (window[globalKey]) {
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
    script.id = id;
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load captcha script: ${src}`));
    document.head.appendChild(script);
  });
}

function resolveProvider(): CaptchaProvider | null {
  const raw = String(process.env.NEXT_PUBLIC_CAPTCHA_PROVIDER || "")
    .trim()
    .toLowerCase();
  if (raw === "turnstile") return "turnstile";
  if (raw === "smartcaptcha" || raw === "smart_captcha" || raw === "yandex_smartcaptcha") {
    return "smartcaptcha";
  }
  // Heuristic fallback — некоторые форматы site-key безошибочно
  // идентифицируют провайдера. SmartCaptcha начинаются с ysc1_, Turnstile —
  // с 0x. Не полагаемся слепо, но фолбэк удобный.
  return null;
}

interface CaptchaWidgetProps {
  siteKey: string | null;
  onVerify: (token: string | null) => void;
  resetRef?: { current: (() => void) | null };
}

export function CaptchaWidget({ siteKey, onVerify, resetRef }: CaptchaWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);
  const smartCaptchaWidgetIdRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Определяем провайдера по env. Если не задан — пробуем распознать по
  // префиксу site-key (ysc1_ → smartcaptcha, иначе turnstile).
  const explicitProvider = resolveProvider();
  const inferredFromKey: CaptchaProvider | null = siteKey?.startsWith("ysc1_")
    ? "smartcaptcha"
    : siteKey
      ? "turnstile"
      : null;
  const provider = explicitProvider || inferredFromKey;

  useEffect(() => {
    // Без siteKey или без провайдера — сразу сообщаем "проверка пройдена" (dev mode).
    if (!siteKey || !provider) {
      onVerify(null);
      return;
    }

    let cancelled = false;

    if (provider === "turnstile") {
      loadScript(TURNSTILE_SCRIPT_SRC, TURNSTILE_SCRIPT_ID, "turnstile")
        .then(() => {
          if (cancelled) return;
          const turnstile = window.turnstile;
          const container = containerRef.current;
          if (!turnstile || !container) {
            setError("Не удалось загрузить captcha");
            return;
          }

          turnstileWidgetIdRef.current = turnstile.render(container, {
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
          if (turnstile && turnstileWidgetIdRef.current) {
            turnstile.reset(turnstileWidgetIdRef.current);
          }
          onVerify(null);
        };
      }
    } else if (provider === "smartcaptcha") {
      loadScript(SMARTCAPTCHA_SCRIPT_SRC, SMARTCAPTCHA_SCRIPT_ID, "smartCaptcha")
        .then(() => {
          if (cancelled) return;
          const smartCaptcha = window.smartCaptcha;
          const container = containerRef.current;
          if (!smartCaptcha || !container) {
            setError("Не удалось загрузить captcha");
            return;
          }

          const widgetId = smartCaptcha.render(container, {
            sitekey: siteKey,
            hl: "ru",
          });
          smartCaptchaWidgetIdRef.current = widgetId;

          // Подписки на события — предпочитаем subscribe API, callback option
          // тоже работает но subscribe позволяет ловить token-expired.
          const unsubSuccess = smartCaptcha.subscribe(widgetId, "success", (token) => {
            setError(null);
            onVerify(typeof token === "string" ? token : null);
          });
          const unsubExpired = smartCaptcha.subscribe(widgetId, "token-expired", () => {
            onVerify(null);
          });
          const unsubError = smartCaptcha.subscribe(widgetId, "network-error", () => {
            setError("Captcha не прошла. Обновите страницу и попробуйте ещё раз.");
            onVerify(null);
          });

          // Сохраняем cleanup'ы в closure через ref
          if (resetRef) {
            resetRef.current = () => {
              const sc = window.smartCaptcha;
              if (sc && smartCaptchaWidgetIdRef.current !== null) {
                sc.reset(smartCaptchaWidgetIdRef.current);
              }
              onVerify(null);
            };
          }

          // Сохраняем для cleanup в return useEffect'a
          (containerRef as { unsubscribers?: Array<() => void> }).unsubscribers = [
            unsubSuccess,
            unsubExpired,
            unsubError,
          ];
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Не удалось загрузить captcha");
        });
    }

    return () => {
      cancelled = true;
      if (provider === "turnstile") {
        const turnstile = window.turnstile;
        if (turnstile && turnstileWidgetIdRef.current) {
          try {
            turnstile.remove(turnstileWidgetIdRef.current);
          } catch {
            // best-effort
          }
          turnstileWidgetIdRef.current = null;
        }
      }
      if (provider === "smartcaptcha") {
        const smartCaptcha = window.smartCaptcha;
        const subs = (containerRef as { unsubscribers?: Array<() => void> }).unsubscribers;
        if (subs) {
          for (const unsub of subs) {
            try {
              unsub();
            } catch {
              // best-effort
            }
          }
        }
        if (smartCaptcha && smartCaptchaWidgetIdRef.current !== null) {
          try {
            smartCaptcha.destroy(smartCaptchaWidgetIdRef.current);
          } catch {
            // best-effort
          }
          smartCaptchaWidgetIdRef.current = null;
        }
      }
      if (resetRef) {
        resetRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, provider]);

  if (!siteKey || !provider) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <div ref={containerRef} />
      {error ? (
        <div style={{ color: "var(--danger, #c53030)", fontSize: 12, marginTop: 6 }}>{error}</div>
      ) : null}
    </div>
  );
}
