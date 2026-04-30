"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { AlertCircle, ArrowRight, BookOpen, Check, Library, Loader2, MessageCircle, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createBook, getBookAnalysisStatus } from "@/lib/booksClient";
import type { BookAnalysisStatusDTO } from "@/lib/books";

type UploadStep = "select" | "consents" | "processing" | "complete";

interface SelectedFileMeta {
  file: File;
  name: string;
  size: string;
  format: string;
}

const ACCEPTED_FORMATS = ["EPUB", "FB2", "PDF"] as const;

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 КБ";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function detectFormat(name: string): string {
  const ext = name.split(".").pop()?.toUpperCase() || "";
  if (ext === "EPUB" || ext === "FB2" || ext === "PDF" || ext === "ZIP") return ext;
  return ext || "Файл";
}

function progressLabel(progress: number): string {
  if (progress < 25) return "Извлекаем текст…";
  if (progress < 55) return "Разбиваем на фрагменты…";
  if (progress < 85) return "Индексируем для поиска…";
  return "Собираем разбор…";
}

export function UploadFlow() {
  const [step, setStep] = useState<UploadStep>("select");
  const [selectedFile, setSelectedFile] = useState<SelectedFileMeta | null>(null);
  const [createdBookId, setCreatedBookId] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<BookAnalysisStatusDTO | null>(null);
  // Один объединённый чекбокс: законное основание + принятие условий загрузки.
  // Юридический разбор: rights warranty (заверение о законности) и license
  // grant (предоставление сервису права хранить и анализировать) разной природы,
  // но в клик-врапе российская и зарубежная практика их регулярно объединяют —
  // важна доказуемость явного волеизъявления, а не количество галок.
  // Обещания сервиса ("не публикуется, не для обучения, видна только тебе")
  // живут в самом документе /legal/upload — пользователь соглашается с ними
  // принятием условий по ссылке.
  const [uploadConsent, setUploadConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();

  const canStart = Boolean(selectedFile) && uploadConsent;

  useEffect(() => {
    if (step !== "processing" || !createdBookId) return;
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const schedulePoll = (delayMs: number) => {
      pollTimer = setTimeout(() => void loadStatus(true), Math.max(1200, delayMs));
    };
    const loadStatus = async (isPoll: boolean) => {
      try {
        const nextStatus = await getBookAnalysisStatus(createdBookId);
        if (!active) return;
        setAnalysisStatus(nextStatus);
        setError(null);
        if (nextStatus.overallState === "completed") {
          setStep("complete");
          return;
        }
        if (nextStatus.overallState === "failed") {
          setError("Анализ не завершился. Книга останется скрытой, пока не пройдет полный анализ.");
          return;
        }
        if (nextStatus.shouldPoll) schedulePoll(nextStatus.pollIntervalMs || 3000);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить статус анализа");
        schedulePoll(isPoll ? 4000 : 2500);
      }
    };
    void loadStatus(false);
    return () => {
      active = false;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [createdBookId, step]);

  useEffect(() => {
    if (step !== "complete" || !createdBookId) return;
    const timer = setTimeout(() => router.push(`/book/${createdBookId}`), 1600);
    return () => clearTimeout(timer);
  }, [createdBookId, router, step]);

  const chapterStats = analysisStatus?.chapterStats ?? [];
  const checkedBlocks = useMemo(() => chapterStats.reduce((sum, chapter) => sum + chapter.checkedBlocks, 0), [chapterStats]);
  const totalBlocks = useMemo(() => chapterStats.reduce((sum, chapter) => sum + chapter.totalBlocks, 0), [chapterStats]);
  const progress = totalBlocks > 0 ? Math.round((checkedBlocks / totalBlocks) * 100) : createdBookId ? 18 : 6;

  const acceptFile = (file: File | null | undefined) => {
    if (!file) return;
    setSelectedFile({
      file,
      name: file.name,
      size: formatFileSize(file.size),
      format: detectFormat(file.name),
    });
    setCreatedBookId(null);
    setAnalysisStatus(null);
    setError(null);
    setStep("consents");
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    acceptFile(event.target.files?.[0]);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    acceptFile(event.dataTransfer.files?.[0]);
  };

  const handleStartProcessing = async () => {
    if (!selectedFile || !canStart) return;
    setError(null);
    setAnalysisStatus(null);
    setCreatedBookId(null);
    setStep("processing");
    try {
      const created = await createBook({ file: selectedFile.file });
      setCreatedBookId(created.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Не удалось загрузить книгу");
      setStep("consents");
    }
  };

  const stepNumber = step === "select" ? 1 : step === "consents" ? 2 : 3;
  const stepTitle =
    step === "select"
      ? "Добавить собственную книгу"
      : step === "consents"
        ? "Небольшие согласия"
        : step === "processing"
          ? "Ремарка читает книгу"
          : "Готово — книга в библиотеке";

  return (
    <div className="screen-fade">
      <div className="container-narrow" style={{ paddingBottom: 96, paddingTop: 56 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>
          Загрузка · шаг {stepNumber} из 3
        </div>
        <h1 style={{ fontSize: "clamp(36px, 6vw, 44px)", letterSpacing: "-0.02em", lineHeight: 1.05 }}>
          {stepTitle}
        </h1>

        <motion.div
          key={step}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          style={{ marginTop: 40 }}
        >
          {step === "select" && (
            <div>
              <div
                className="card"
                onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
                style={{
                  background: "var(--paper-2)",
                  border: `2px dashed ${dragActive ? "var(--mark)" : "var(--rule)"}`,
                  cursor: "pointer",
                  padding: 48,
                  textAlign: "center",
                  transition: "border-color .15s",
                }}
              >
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 28, color: "var(--ink)" }}>
                  Перетащите файл сюда
                </div>
                <div className="soft" style={{ fontSize: 14, marginTop: 8 }}>
                  или нажмите, чтобы выбрать
                </div>
                <button
                  type="button"
                  className="btn btn-mark btn-lg"
                  style={{ marginTop: 24 }}
                  onClick={(event) => { event.stopPropagation(); inputRef.current?.click(); }}
                >
                  <Upload size={16} /> Выбрать файл
                </button>
                <div className="row" style={{ gap: 12, justifyContent: "center", marginTop: 24 }}>
                  {ACCEPTED_FORMATS.map((format) => (
                    <div key={format} className="badge">{format}</div>
                  ))}
                  <span className="mono" style={{ color: "var(--ink-faint)" }}>до 50 МБ</span>
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  className="sr-only"
                  accept=".fb2,.epub,.pdf,.zip"
                  onChange={handleFileSelect}
                />
              </div>
              <p className="soft" style={{ fontSize: 13, lineHeight: 1.6, marginTop: 20 }}>
                После загрузки Ремарка построит разбор и сделает книгу доступной для чата.
                Обработка занимает 1–3 минуты на книгу объёмом 400 страниц.
              </p>
            </div>
          )}

          {step === "consents" && selectedFile && (
            <div>
              <div className="card" style={{ padding: 24 }}>
                <div className="row">
                  <div
                    style={{
                      alignItems: "center",
                      background: "var(--paper-2)",
                      border: "1px solid var(--rule)",
                      borderRadius: 4,
                      color: "var(--ink-muted)",
                      display: "flex",
                      flexShrink: 0,
                      height: 64,
                      justifyContent: "center",
                      width: 48,
                    }}
                  >
                    <BookOpen size={20} />
                  </div>
                  <div>
                    <div style={{ fontFamily: "var(--font-serif)", fontSize: 17 }}>{selectedFile.name}</div>
                    <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 4 }}>
                      {selectedFile.format} · {selectedFile.size}
                    </div>
                  </div>
                </div>
              </div>

              {error && (
                <div
                  className="card"
                  style={{ alignItems: "center", borderColor: "var(--mark)", color: "var(--mark)", display: "flex", gap: 10, marginTop: 18, padding: 14 }}
                >
                  <AlertCircle size={16} /> {error}
                </div>
              )}

              <div className="stack-lg" style={{ marginTop: 28 }}>
                <ConsentRow
                  checked={uploadConsent}
                  onChange={setUploadConsent}
                  label={
                    <>
                      Я подтверждаю, что у меня есть законное основание загрузить
                      этот файл и использовать его через сервис, и принимаю{" "}
                      <Link className="lnk" href="/legal/upload">
                        Условия загрузки произведения
                      </Link>
                      .
                    </>
                  }
                  sub="Законное основание — это законно приобретённый экземпляр, ваша рукопись, произведение в общественном достоянии или иное законное основание. Файл хранится приватно: не публикуется, не передаётся другим пользователям и не используется для обучения моделей. Подробности — в Условиях загрузки."
                />
              </div>

              <div className="row" style={{ justifyContent: "space-between", marginTop: 36 }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setStep("select");
                    setSelectedFile(null);
                    setError(null);
                  }}
                >
                  Назад
                </button>
                <button
                  type="button"
                  className="btn btn-mark"
                  disabled={!canStart}
                  onClick={handleStartProcessing}
                  style={{ opacity: canStart ? 1 : 0.5 }}
                >
                  Продолжить <ArrowRight size={14} />
                </button>
              </div>
            </div>
          )}

          {step === "processing" && (
            <div className="card" style={{ padding: 48, textAlign: "center" }}>
              <Loader2 className="animate-spin" size={28} style={{ color: "var(--mark)" }} />
              <div
                style={{
                  color: "var(--mark)",
                  fontFamily: "var(--font-serif)",
                  fontSize: 52,
                  lineHeight: 1,
                  marginTop: 18,
                }}
              >
                {progress}%
              </div>
              <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 8 }}>
                {progressLabel(progress)}
              </div>
              <div
                style={{
                  background: "var(--paper-2)",
                  borderRadius: 100,
                  height: 6,
                  marginTop: 32,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    background: "var(--mark)",
                    height: "100%",
                    transition: "width .25s ease",
                    width: `${progress}%`,
                  }}
                />
              </div>
              {error && (
                <p style={{ color: "var(--mark)", fontSize: 13, marginTop: 18 }}>{error}</p>
              )}
            </div>
          )}

          {step === "complete" && (
            <div className="card" style={{ padding: 48, textAlign: "center" }}>
              <div
                style={{
                  alignItems: "center",
                  background: "var(--mark-soft)",
                  borderRadius: "50%",
                  color: "var(--mark)",
                  display: "inline-flex",
                  height: 64,
                  justifyContent: "center",
                  width: 64,
                }}
              >
                <Check size={28} />
              </div>
              <h3 style={{ fontSize: 28, marginTop: 20 }}>Книга в вашей библиотеке</h3>
              <p className="soft" style={{ fontSize: 15, marginTop: 12 }}>
                Разбор построен, чат готов отвечать. Приятного чтения.
              </p>
              <div className="row" style={{ justifyContent: "center", marginTop: 28 }}>
                <Link className="btn btn-ghost" href="/library">
                  <Library size={16} /> В библиотеку
                </Link>
                <Link className="btn btn-mark" href={createdBookId ? `/book/${createdBookId}/chat` : "/library"}>
                  <MessageCircle size={16} /> Открыть чат
                </Link>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

interface ConsentRowProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  sub: React.ReactNode;
}

function ConsentRow({ checked, onChange, label, sub }: ConsentRowProps) {
  return (
    <label
      style={{
        background: checked ? "var(--mark-soft)" : "var(--cream)",
        border: `1px solid ${checked ? "var(--mark)" : "var(--rule)"}`,
        borderRadius: "var(--r)",
        cursor: "pointer",
        display: "grid",
        gap: 14,
        gridTemplateColumns: "28px 1fr",
        padding: 20,
        transition: "all .15s",
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: checked ? "var(--mark)" : "transparent",
          border: `2px solid ${checked ? "var(--mark)" : "var(--ink-faint)"}`,
          borderRadius: 4,
          color: "#fff",
          display: "flex",
          height: 20,
          justifyContent: "center",
          marginTop: 2,
          width: 20,
        }}
      >
        {checked && <Check size={12} strokeWidth={3} />}
      </div>
      <div>
        <div style={{ color: "var(--ink)", fontFamily: "var(--font-serif)", fontSize: 16 }}>{label}</div>
        <div className="soft" style={{ fontSize: 13, lineHeight: 1.55, marginTop: 4 }}>{sub}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        style={{ display: "none" }}
      />
    </label>
  );
}
