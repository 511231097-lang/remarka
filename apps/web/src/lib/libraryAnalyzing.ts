export interface AnalyzingBookDTO {
  id: string;
  title: string;
  author: string | null;
  format: string;
  progress: number;
  eta: string;
  stageLabel: string;
}

export interface AnalyzingBookSource {
  id: string;
  title: string;
  author: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  analysisStatus: "queued" | "running" | "completed" | "failed" | "not_started";
  analysisTotalBlocks: number | null;
  analysisCheckedBlocks: number | null;
  analysisStartedAt: Date | null;
  analysisRequestedAt: Date | null;
  createdAt: Date;
}

const STAGE_THRESHOLDS: Array<{ max: number; label: string }> = [
  { max: 25, label: "Извлечение текста" },
  { max: 55, label: "Разбивка на фрагменты" },
  { max: 85, label: "Индексация для поиска" },
  { max: 100, label: "Сборка разбора" },
];

function resolveStageLabel(progress: number): string {
  const stage = STAGE_THRESHOLDS.find((item) => progress <= item.max);
  return stage ? stage.label : STAGE_THRESHOLDS[STAGE_THRESHOLDS.length - 1].label;
}

function resolveProgress(book: AnalyzingBookSource): number {
  const total = Number(book.analysisTotalBlocks || 0);
  const checked = Number(book.analysisCheckedBlocks || 0);

  if (total > 0) {
    const ratio = checked / total;
    const pct = Math.round(ratio * 100);
    return Math.max(0, Math.min(99, pct));
  }

  if (book.analysisStatus === "running") return 5;
  return 0;
}

function resolveEta(book: AnalyzingBookSource, progress: number, now: Date = new Date()): string {
  if (book.analysisStartedAt && progress > 5) {
    const startedMs = book.analysisStartedAt.getTime();
    const elapsedMs = Math.max(0, now.getTime() - startedMs);
    if (elapsedMs > 0 && progress > 0 && progress < 100) {
      const remainingMs = (elapsedMs * (100 - progress)) / progress;
      const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
      return `~${minutes} мин`;
    }
  }
  return "~2 мин";
}

function resolveFormat(book: AnalyzingBookSource): string {
  const mime = String(book.mimeType || "").trim().toLowerCase();
  const fileName = String(book.fileName || "").trim().toLowerCase();

  if (mime === "application/epub+zip") return "EPUB";
  if (
    mime === "application/x-fictionbook+xml" ||
    mime === "application/x-fictionbook" ||
    mime === "text/fb2"
  ) {
    return "FB2";
  }
  if (mime.startsWith("application/zip") && fileName.endsWith(".fb2.zip")) return "FB2";
  if (mime === "application/pdf") return "PDF";
  if (mime === "text/plain") return "TXT";

  if (fileName) {
    if (fileName.endsWith(".fb2.zip")) return "FB2";
    const ext = fileName.split(".").pop();
    if (ext) return ext.toUpperCase();
  }

  return "FILE";
}

export function toAnalyzingBookDTO(book: AnalyzingBookSource, now: Date = new Date()): AnalyzingBookDTO {
  const progress = resolveProgress(book);
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    format: resolveFormat(book),
    progress,
    eta: resolveEta(book, progress, now),
    stageLabel: resolveStageLabel(progress),
  };
}
