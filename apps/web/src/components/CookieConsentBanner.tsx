"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const COOKIE_NAME = "remarka_cookie_consent";
const COOKIE_VALUE = "accepted";
const STORAGE_KEY = "remarka_cookie_consent";
const COOKIE_TTL_SECONDS = 60 * 60 * 24 * 365;

function hasCookieConsent(): boolean {
  if (typeof document === "undefined") return false;

  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.split("=")[1];

  if (value === COOKIE_VALUE) return true;

  if (typeof window !== "undefined") {
    return window.localStorage.getItem(STORAGE_KEY) === COOKIE_VALUE;
  }

  return false;
}

function persistCookieConsent() {
  if (typeof document === "undefined") return;

  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  const secureSuffix = secure ? "; Secure" : "";
  document.cookie = `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=${COOKIE_TTL_SECONDS}; SameSite=Lax${secureSuffix}`;

  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, COOKIE_VALUE);
  }
}

export function CookieConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(!hasCookieConsent());
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[70] border-t border-border bg-card/95 shadow-[0_-8px_24px_rgba(0,0,0,0.12)] backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6">
        <p className="text-sm leading-6 text-foreground">
          Мы используем cookie для авторизации и стабильной работы сервиса. Продолжая использовать сайт, вы
          соглашаетесь с условиями.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Link href="/cookie-policy" className="text-sm text-primary hover:underline">
            Соглашение по cookie
          </Link>
          <button
            onClick={() => {
              persistCookieConsent();
              setVisible(false);
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90"
          >
            Принять
          </button>
        </div>
      </div>
    </div>
  );
}
