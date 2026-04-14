"use client";

import { motion } from "motion/react";
import { Upload, FileText, Loader2, CheckCircle2, Globe, Lock, Crown, AlertCircle } from "lucide-react";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { currentUser } from "@/lib/mockData";
import { createBook } from "@/lib/booksClient";

type UploadStep = "select" | "metadata" | "processing" | "complete";

interface UploadFlowProps {
  defaultBookVisibilityPublic: boolean;
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
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);
    setFileName(file.name);
    setError(null);
    setStep("metadata");
  };

  const handleStartProcessing = async () => {
    if (!selectedFile) {
      setError("Выберите файл книги");
      return;
    }

    setError(null);
    setStep("processing");

    try {
      const created = await createBook({
        file: selectedFile,
        isPublic,
      });

      setCreatedBookId(created.id);
      setStep("complete");
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
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="max-w-md text-center space-y-6"
        >
          <div className="w-20 h-20 rounded-full bg-secondary mx-auto flex items-center justify-center">
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl text-foreground">Загружаем книгу</h2>
            <p className="text-muted-foreground">{fileName}</p>
          </div>

          <div className="space-y-3 pt-4">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span>Проверяем формат FB2/ZIP</span>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" style={{ animationDelay: "0.2s" }} />
              <span>Извлекаем метаданные книги</span>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" style={{ animationDelay: "0.4s" }} />
              <span>Сохраняем книгу в библиотеке</span>
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
            transition={{ delay: 0.2, type: "spring" }}
            className="w-20 h-20 rounded-full bg-secondary mx-auto flex items-center justify-center"
          >
            <CheckCircle2 className="w-10 h-10 text-primary" />
          </motion.div>

          <div className="space-y-2">
            <h2 className="text-2xl text-foreground">Книга загружена</h2>
            <p className="text-muted-foreground">
              Открыть страницу книги
            </p>
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
