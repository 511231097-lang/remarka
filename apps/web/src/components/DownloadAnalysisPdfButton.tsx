"use client";

import { Download } from "lucide-react";

interface DownloadAnalysisPdfButtonProps {
  bookId: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function DownloadAnalysisPdfButton({
  bookId,
  disabled = false,
  disabledReason,
}: DownloadAnalysisPdfButtonProps) {
  const href = `/api/books/${bookId}/literary-analysis/pdf`;
  const title = disabled ? disabledReason || "PDF станет доступен после завершения анализа" : "Скачать анализ в PDF";

  const classes =
    "inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors";

  if (disabled) {
    return (
      <button
        type="button"
        disabled
        title={title}
        className={`${classes} cursor-not-allowed opacity-60`}
      >
        <Download className="h-4 w-4" />
        PDF
      </button>
    );
  }

  return (
    <a href={href} download className={`${classes} hover:border-primary/30 hover:bg-secondary/40`} title={title}>
      <Download className="h-4 w-4" />
      PDF
    </a>
  );
}
