"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { AlertCircle, Check, FileText, Loader2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createBook, getBookAnalysisStatus } from "@/lib/booksClient";
import type { BookAnalysisStatusDTO } from "@/lib/books";

type UploadStep = "select" | "consents" | "processing" | "complete";

export function UploadFlow() {
  const [step, setStep] = useState<UploadStep>("select");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [createdBookId, setCreatedBookId] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<BookAnalysisStatusDTO | null>(null);
  const [consents, setConsents] = useState({ rights: false, license: false, process: false });
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const canStart = selectedFile && consents.rights && consents.license && consents.process;

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
    const timer = setTimeout(() => router.push(`/book/${createdBookId}`), 1200);
    return () => clearTimeout(timer);
  }, [createdBookId, router, step]);

  const chapterStats = analysisStatus?.chapterStats ?? [];
  const checkedBlocks = useMemo(() => chapterStats.reduce((sum, chapter) => sum + chapter.checkedBlocks, 0), [chapterStats]);
  const totalBlocks = useMemo(() => chapterStats.reduce((sum, chapter) => sum + chapter.totalBlocks, 0), [chapterStats]);
  const progress = totalBlocks > 0 ? Math.round((checkedBlocks / totalBlocks) * 100) : createdBookId ? 18 : 6;

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setCreatedBookId(null);
    setAnalysisStatus(null);
    setError(null);
    setStep("consents");
  };

  const handleStartProcessing = async () => {
    if (!selectedFile || !canStart) return;
    setError(null);
    setAnalysisStatus(null);
    setCreatedBookId(null);
    setStep("processing");
    try {
      const created = await createBook({ file: selectedFile });
      setCreatedBookId(created.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Не удалось загрузить книгу");
      setStep("consents");
    }
  };

  return (
    <div className="screen-fade">
      <div className="container-narrow" style={{ paddingBottom: 72, paddingTop: 64 }}>
        <div className="mono" style={{ color: "var(--mark)", marginBottom: 16 }}>Плюс · загрузка книги</div>
        <h1 style={{ fontSize: "clamp(40px, 7vw, 56px)", letterSpacing: 0, lineHeight: 1.02 }}>
          Загрузите книгу.<br />
          <span style={{ color: "var(--mark)", fontStyle: "italic" }}>Ремарка</span> разберёт её.
        </h1>
        <p className="soft" style={{ fontSize: 17, lineHeight: 1.65, marginTop: 22, maxWidth: 620 }}>
          Файл останется приватным. Перед обработкой нужно подтвердить права и согласие на технический анализ текста.
        </p>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="card" style={{ marginTop: 44, padding: 32 }}>
          {step === "select" && (
            <label style={{ alignItems: "center", border: "1px dashed var(--rule)", borderRadius: "var(--r-lg)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 14, padding: "56px 24px", textAlign: "center" }}>
              <Upload size={30} style={{ color: "var(--mark)" }} />
              <div>
                <h2 style={{ fontSize: 28 }}>Выберите файл</h2>
                <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>EPUB · FB2 · PDF · ZIP</p>
              </div>
              <span className="btn btn-mark">Открыть файл</span>
              <input type="file" className="sr-only" accept=".fb2,.epub,.pdf,.zip" onChange={handleFileSelect} />
            </label>
          )}

          {step === "consents" && selectedFile && (
            <div>
              <div className="row" style={{ alignItems: "flex-start", marginBottom: 24 }}>
                <FileText size={24} style={{ color: "var(--mark)", flexShrink: 0 }} />
                <div>
                  <h2 style={{ fontSize: 28 }}>Подтверждение загрузки</h2>
                  <p className="muted" style={{ fontSize: 14, marginTop: 4 }}>{selectedFile.name}</p>
                </div>
              </div>
              {error && <div className="card" style={{ borderColor: "var(--mark)", color: "var(--mark)", marginBottom: 18, padding: 14 }}><AlertCircle size={16} /> {error}</div>}
              <div className="stack">
                <ConsentRow checked={consents.rights} onChange={(rights) => setConsents({ ...consents, rights })} label="У меня есть право использовать этот файл для личного чтения и анализа." />
                <ConsentRow checked={consents.license} onChange={(license) => setConsents({ ...consents, license })} label="Я предоставляю ремарке ограниченную лицензию на техническую обработку файла." />
                <ConsentRow checked={consents.process} onChange={(process) => setConsents({ ...consents, process })} label="Я согласен на автоматическое извлечение текста, индексацию и построение разбора." />
              </div>
              <div className="row" style={{ flexWrap: "wrap", justifyContent: "space-between", marginTop: 28 }}>
                <Link className="lnk" href="/legal/upload">Условия загрузки произведения</Link>
                <button className="btn btn-mark" disabled={!canStart} onClick={handleStartProcessing} style={{ opacity: canStart ? 1 : 0.5 }}>
                  Начать анализ
                </button>
              </div>
            </div>
          )}

          {step === "processing" && (
            <div style={{ textAlign: "center" }}>
              <Loader2 className="mx-auto animate-spin" size={34} style={{ color: "var(--mark)" }} />
              <h2 style={{ fontSize: 32, marginTop: 18 }}>{analysisStatus?.overallState === "running" ? "Анализируем книгу" : "Запускаем анализ"}</h2>
              <p className="muted" style={{ fontSize: 14, margin: "10px auto 0", maxWidth: 520 }}>
                Книга станет доступна после завершения обработки. Можно оставить страницу открытой.
              </p>
              <div style={{ background: "var(--paper-3)", borderRadius: 999, height: 8, marginTop: 28, overflow: "hidden" }}>
                <div style={{ background: "var(--mark)", height: "100%", transition: "width .25s ease", width: `${progress}%` }} />
              </div>
              <div className="mono" style={{ color: "var(--ink-muted)", marginTop: 12 }}>{progress}%</div>
              {error && <p style={{ color: "var(--mark)", fontSize: 13, marginTop: 18 }}>{error}</p>}
            </div>
          )}

          {step === "complete" && (
            <div style={{ textAlign: "center" }}>
              <div className="complaint-check"><Check size={18} /></div>
              <h2 style={{ fontSize: 32, marginTop: 18 }}>Книга готова</h2>
              <p className="muted" style={{ marginTop: 10 }}>Переводим на страницу разбора.</p>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

function ConsentRow({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="complaint-sworn" style={{ marginTop: 0 }}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
