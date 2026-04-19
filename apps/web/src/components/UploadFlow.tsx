"use client";

import { motion } from "motion/react";
import { AlertCircle, CheckCircle2, Crown, FileText, Globe, Loader2, Lock, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createBook, getBookAnalysisStatus } from "@/lib/booksClient";
import type { BookAnalysisChapterStatusDTO, BookAnalysisStatusDTO } from "@/lib/books";
import { currentUser } from "@/lib/mockData";

type UploadStep = "select" | "metadata" | "processing" | "complete";

interface UploadFlowProps {
  defaultBookVisibilityPublic: boolean;
}

function resolveChapterStateLabel(state: BookAnalysisChapterStatusDTO["state"]) {
  if (state === "completed") return "Прошла";
  if (state === "running") return "В анализе";
  if (state === "failed") return "Не прошла";
  return "Ждет очередь";
}

function resolveChapterStateTone(state: BookAnalysisChapterStatusDTO["state"]) {
  if (state === "completed") return "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
  if (state === "running") return "text-primary border-primary/30 bg-primary/10";
  if (state === "failed") return "text-destructive border-destructive/30 bg-destructive/10";
  return "text-muted-foreground border-border bg-secondary/40";
}

function ChapterStatusIcon({ state }: { state: BookAnalysisChapterStatusDTO["state"] }) {
  if (state === "completed") {
    return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  }

  if (state === "running") {
    return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  }

  if (state === "failed") {
    return <AlertCircle className="h-4 w-4 text-destructive" />;
  }

  return <div className="h-2.5 w-2.5 rounded-full bg-muted-foreground/50" />;
}

function resolveProcessingState(status: BookAnalysisStatusDTO | null, hasCreatedBook: boolean) {
  if (!hasCreatedBook) {
    return {
      title: "Сохраняем книгу",
      subtitle: "Создаем запись и подготавливаем анализ.",
    };
  }

  if (!status) {
    return {
      title: "Запускаем анализ",
      subtitle: "Формируем главы и ставим книгу в очередь.",
    };
  }

  if (status.overallState === "completed") {
    return {
      title: "Анализ завершен",
      subtitle: "Книга готова, переводим на страницу книги.",
    };
  }

  if (status.overallState === "failed") {
    return {
      title: "Анализ остановился",
      subtitle: "Проверьте статусы глав ниже. Книга не будет опубликована, пока анализ не завершится полностью.",
    };
  }

  if (status.overallState === "running") {
    return {
      title: "Анализируем книгу",
      subtitle: "Книга станет доступна только после завершения всех глав.",
    };
  }

  return {
    title: "Книга в очереди",
    subtitle: "Ожидаем старт анализа по главам.",
  };
}

export function UploadFlow({ defaultBookVisibilityPublic }: UploadFlowProps) {
  const canCreatePrivate = currentUser.plan.features.privateBooks;
  const [step, setStep] = useState<UploadStep>("select");
  const [fileName, setFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isPublic, setIsPublic] = useState(
    canCreatePrivate ? defaultBookVisibilityPublic : true,
  );
  const [createdBookId, setCreatedBookId] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<BookAnalysisStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (step !== "processing" || !createdBookId) return;

    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (delayMs: number) => {
      pollTimer = setTimeout(() => {
        void loadStatus(true);
      }, Math.max(1200, delayMs));
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

        if (nextStatus.shouldPoll) {
          schedulePoll(nextStatus.pollIntervalMs || 3000);
        }
      } catch (loadError) {
        if (!active) return;

        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить статус анализа");
        if (isPoll) {
          schedulePoll(4000);
        } else {
          schedulePoll(2500);
        }
      }
    };

    void loadStatus(false);

    return () => {
      active = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
  }, [createdBookId, step]);

  useEffect(() => {
    if (step !== "complete" || !createdBookId) return;

    const timer = setTimeout(() => {
      router.push(`/book/${createdBookId}`);
    }, 1200);

    return () => clearTimeout(timer);
  }, [createdBookId, router, step]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);
    setFileName(file.name);
    setCreatedBookId(null);
    setAnalysisStatus(null);
    setError(null);
    setStep("metadata");
  };

  const handleStartProcessing = async () => {
    if (!selectedFile) {
      setError("Выберите файл книги");
      return;
    }

    setError(null);
    setAnalysisStatus(null);
    setCreatedBookId(null);
    setStep("processing");

    try {
      const created = await createBook({
        file: selectedFile,
        isPublic,
      });

      setCreatedBookId(created.id);
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : "Не удалось загрузить книгу";
      setError(message);
      setStep("metadata");
    }
  };

  const handleComplete = () => {
    if (createdBookId) {
      router.push(`/book/${createdBookId}`);
      return;
    }

    router.push("/library");
  };

  const chapterStats = analysisStatus?.chapterStats ?? [];
  const completedChapters = useMemo(
    () => chapterStats.filter((chapter) => chapter.state === "completed").length,
    [chapterStats]
  );
  const failedChapters = useMemo(
    () => chapterStats.filter((chapter) => chapter.state === "failed").length,
    [chapterStats]
  );
  const checkedBlocks = useMemo(
    () => chapterStats.reduce((sum, chapter) => sum + chapter.checkedBlocks, 0),
    [chapterStats]
  );
  const totalBlocks = useMemo(
    () => chapterStats.reduce((sum, chapter) => sum + chapter.totalBlocks, 0),
    [chapterStats]
  );
  const runningChapter = useMemo(
    () => chapterStats.find((chapter) => chapter.state === "running") ?? null,
    [chapterStats]
  );
  const chapterProgress = totalBlocks > 0 ? Math.round((checkedBlocks / totalBlocks) * 100) : 0;
  const processingCopy = resolveProcessingState(analysisStatus, Boolean(createdBookId));

  if (step === "metadata") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6 py-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full space-y-6"
        >
          <div className="text-center space-y-2 mb-8">
            <h1 className="text-2xl text-foreground">Настройки публикации</h1>
            <p className="text-muted-foreground">{fileName}</p>
          </div>

          <div className="p-6 bg-card border border-border rounded-lg space-y-6">
            {error && (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <h3 className="text-foreground mb-4">Видимость анализа</h3>
              <div className="space-y-3">
                <label className="flex items-start gap-3 p-4 border border-border rounded-lg cursor-pointer hover:border-primary/30 transition-colors">
                  <input
                    type="radio"
                    name="visibility"
                    checked={isPublic}
                    onChange={() => setIsPublic(true)}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Globe className="w-4 h-4 text-primary" />
                      <span className="text-foreground">Публичная</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Анализ будет доступен всем пользователям в каталоге
                    </p>
                  </div>
                </label>

                <label
                  className={`flex items-start gap-3 p-4 border border-border rounded-lg ${
                    canCreatePrivate
                      ? "cursor-pointer hover:border-primary/30"
                      : "opacity-60 cursor-not-allowed"
                  } transition-colors`}
                >
                  <input
                    type="radio"
                    name="visibility"
                    checked={!isPublic}
                    onChange={() => canCreatePrivate && setIsPublic(false)}
                    disabled={!canCreatePrivate}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Lock className="w-4 h-4" />
                      <span className="text-foreground">Приватная</span>
                      {!canCreatePrivate && (
                        <span className="flex items-center gap-1 text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-full">
                          <Crown className="w-3 h-3" />
                          Плюс
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Только вы сможете видеть этот анализ
                    </p>
                    {!canCreatePrivate && (
                      <Link
                        href="/plans"
                        className="text-xs text-primary hover:underline mt-2 inline-block"
                      >
                        Обновить до тарифа Плюс
                      </Link>
                    )}
                  </div>
                </label>
              </div>
            </div>

            <button
              onClick={handleStartProcessing}
              className="w-full px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
            >
              Начать анализ
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  if (step === "processing") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6 py-12">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-3xl w-full space-y-6"
        >
          <div className="text-center space-y-4">
            <div className="w-20 h-20 rounded-full bg-secondary mx-auto flex items-center justify-center">
              {analysisStatus?.overallState === "failed" ? (
                <AlertCircle className="w-10 h-10 text-destructive" />
              ) : (
                <Loader2 className="w-10 h-10 text-primary animate-spin" />
              )}
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl text-foreground">{processingCopy.title}</h2>
              <p className="text-muted-foreground">{processingCopy.subtitle}</p>
              <p className="text-sm text-muted-foreground/80">{fileName}</p>
            </div>
          </div>

          {error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="rounded-3xl border border-border bg-card/90 p-6 lg:p-8 space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="space-y-1">
                <h3 className="text-lg text-foreground">Статус анализа по главам</h3>
                <p className="text-sm text-muted-foreground">
                  {chapterStats.length > 0
                    ? `${completedChapters} из ${chapterStats.length} глав завершены, ${checkedBlocks} из ${totalBlocks} блоков обработаны`
                    : "Подготавливаем главы и первый прогресс."}
                </p>
              </div>

              {chapterStats.length > 0 ? (
                <div className="text-sm text-muted-foreground">
                  {failedChapters > 0 ? `Ошибки: ${failedChapters}` : runningChapter ? "Идет обработка" : "Ждем запуск"}
                </div>
              ) : null}
            </div>

            <div className="h-2 rounded-full bg-secondary overflow-hidden">
              <div
                className={`h-full transition-all ${
                  analysisStatus?.overallState === "failed" ? "bg-destructive" : "bg-primary"
                }`}
                style={{ width: `${chapterProgress}%` }}
              />
            </div>

            <div className="space-y-3">
              {chapterStats.length === 0 ? (
                <div className="rounded-2xl border border-border bg-background/70 px-4 py-4 text-sm text-muted-foreground">
                  После старта анализа здесь появится состояние каждой главы.
                </div>
              ) : (
                chapterStats.map((chapter) => (
                  <div
                    key={chapter.chapterId}
                    className="rounded-2xl border border-border bg-background/70 px-4 py-4"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-3">
                          <ChapterStatusIcon state={chapter.state} />
                          <p className="text-sm text-foreground">
                            Глава {chapter.chapterOrderIndex}. {chapter.chapterTitle}
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Блоков обработано: {chapter.checkedBlocks} из {chapter.totalBlocks}
                        </p>
                      </div>

                      <span
                        className={`inline-flex items-center rounded-full border px-3 py-1 text-xs ${resolveChapterStateTone(chapter.state)}`}
                      >
                        {resolveChapterStateLabel(chapter.state)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  if (step === "complete") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md text-center space-y-6"
        >
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.15, type: "spring" }}
            className="w-20 h-20 rounded-full bg-secondary mx-auto flex items-center justify-center"
          >
            <CheckCircle2 className="w-10 h-10 text-primary" />
          </motion.div>

          <div className="space-y-2">
            <h2 className="text-2xl text-foreground">Книга добавлена</h2>
            <p className="text-muted-foreground">Переводим на страницу книги.</p>
          </div>

          <button
            onClick={handleComplete}
            className="px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
          >
            Перейти к книге
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full space-y-6"
      >
        <div className="text-center space-y-2">
          <h1 className="text-2xl text-foreground">Загрузите книгу</h1>
          <p className="text-muted-foreground">
            Поддерживаются форматы FB2 и ZIP с одним файлом FB2
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <label className="block">
          <input
            type="file"
            accept=".fb2,.zip,.fb2.zip"
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="border-2 border-dashed border-border rounded-lg p-12 text-center cursor-pointer hover:border-primary/50 hover:bg-secondary/50 transition-colors">
            <Upload className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-foreground mb-2">Нажмите для выбора файла</p>
            <p className="text-sm text-muted-foreground">или перетащите файл сюда</p>
          </div>
        </label>

        <div className="space-y-3 pt-4">
          <div className="flex gap-3 items-start">
            <FileText className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-foreground">Из файла автоматически извлечем название и автора</p>
              <p className="text-xs text-muted-foreground">Для FB2 / FB2 ZIP</p>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
