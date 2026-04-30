"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, X } from "lucide-react";

export type PaywallFeature = "upload" | "analyze";

interface PaywallModalProps {
  open: boolean;
  feature?: PaywallFeature;
  onClose: () => void;
  /** Optional: override the upgrade CTA (defaults to a Link to /plans). */
  onUpgrade?: () => void;
}

interface CopyEntry {
  eyebrow: string;
  title: string;
  body: string;
}

const COPY: Record<PaywallFeature, CopyEntry> = {
  upload: {
    eyebrow: "Только на Плюсе",
    title: "Загрузка своих книг — возможность Плюса",
    body: "Бесплатный тариф позволяет читать и обсуждать любые книги из каталога. Чтобы загрузить собственный EPUB, FB2 или PDF и получить по нему личный разбор — перейдите на Плюс.",
  },
  analyze: {
    eyebrow: "Только на Плюсе",
    title: "Персональный анализ — возможность Плюса",
    body: "Глубокий разбор загруженных книг доступен на тарифе Плюс. На бесплатном — чат и каталог, и этого часто хватает.",
  },
};

const PLUS_BENEFITS = [
  "Загрузка своих книг в EPUB · FB2 · PDF",
  "Персональный AI-разбор каждой книги",
  "Отдельный чат с каждой вашей книгой",
];

export function PaywallModal({ open, feature = "upload", onClose, onUpgrade }: PaywallModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Esc to close + body scroll lock
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  const copy = COPY[feature];

  return createPortal(
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paywall-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" style={{ maxWidth: 520, padding: 36 }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -16 }}>
          <button
            type="button"
            className="btn-plain"
            style={{ background: "transparent", border: "none", borderRadius: 6, cursor: "pointer", padding: 6 }}
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: "8px 0 4px", textAlign: "center" }}>
          <div className="mono" style={{ color: "var(--mark)", marginBottom: 14 }}>{copy.eyebrow}</div>
          <h2
            id="paywall-title"
            style={{
              fontSize: 28,
              letterSpacing: "-0.02em",
              lineHeight: 1.15,
              textWrap: "balance",
            }}
          >
            {copy.title}
          </h2>
          <p
            className="soft"
            style={{ fontSize: 15, lineHeight: 1.6, marginTop: 14, textWrap: "pretty" }}
          >
            {copy.body}
          </p>
        </div>

        <div
          style={{
            background: "var(--paper-2)",
            border: "1px solid var(--mark)",
            borderRadius: "var(--r-lg)",
            marginTop: 28,
            padding: "20px 22px",
          }}
        >
          <div
            style={{
              alignItems: "baseline",
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <div>
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 22, letterSpacing: "-0.01em" }}>
                Плюс
              </div>
              <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 2 }}>
                Отмена в один клик
              </div>
            </div>
            <div style={{ fontFamily: "var(--font-serif)", fontSize: 28, fontWeight: 500 }}>
              390<span style={{ color: "var(--mark)", fontSize: 20 }}>.</span>
              <span className="mono" style={{ color: "var(--ink-muted)", fontSize: 12, marginLeft: 4 }}>
                ₽/мес
              </span>
            </div>
          </div>
          <ul
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              listStyle: "none",
              margin: 0,
              padding: 0,
            }}
          >
            {PLUS_BENEFITS.map((benefit) => (
              <li
                key={benefit}
                style={{
                  alignItems: "center",
                  color: "var(--ink)",
                  display: "flex",
                  fontSize: 13.5,
                  gap: 10,
                }}
              >
                <div
                  style={{
                    alignItems: "center",
                    background: "var(--mark)",
                    borderRadius: "50%",
                    color: "#fff",
                    display: "flex",
                    flexShrink: 0,
                    height: 16,
                    justifyContent: "center",
                    width: 16,
                  }}
                >
                  <Check size={11} strokeWidth={2.5} />
                </div>
                {benefit}
              </li>
            ))}
          </ul>
        </div>

        <div
          className="row"
          style={{ gap: 12, justifyContent: "center", marginTop: 24 }}
        >
          <Link
            className="btn btn-plain"
            href="/plans"
            onClick={onClose}
          >
            Сравнить тарифы
          </Link>
          {onUpgrade ? (
            <button
              type="button"
              className="btn btn-mark btn-lg"
              onClick={onUpgrade}
              style={{ flex: 1, justifyContent: "center" }}
            >
              Перейти на Плюс <ArrowRight size={14} />
            </button>
          ) : (
            <Link
              className="btn btn-mark btn-lg"
              href="/plans"
              onClick={onClose}
              style={{ flex: 1, justifyContent: "center" }}
            >
              Перейти на Плюс <ArrowRight size={14} />
            </Link>
          )}
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
          Без автопродления · отмена в любой момент
        </div>
      </div>
    </div>,
    document.body
  );
}
