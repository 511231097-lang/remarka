"use client";

import { motion } from "motion/react";
import { Globe, Lock, Settings, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteBook, updateBookVisibility } from "@/lib/booksClient";
import type { BookCoreDTO } from "@/lib/books";

interface BookSettingsProps {
  book: BookCoreDTO;
  onBookUpdated: (book: BookCoreDTO) => void;
}

export function BookSettings({ book, onBookUpdated }: BookSettingsProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isPublic, setIsPublic] = useState(book.isPublic);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!book.canManage) {
    return null;
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateBookVisibility(book.id, isPublic);
      onBookUpdated(updated);
      setIsOpen(false);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Не удалось сохранить настройки";
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteBook(book.id);
      router.push("/library");
      router.refresh();
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "Не удалось удалить книгу";
      setError(message);
      setDeleting(false);
    }
  }

  function openModal() {
    setIsPublic(book.isPublic);
    setShowDeleteConfirm(false);
    setError(null);
    setIsOpen(true);
  }

  function closeModal() {
    if (saving || deleting) return;
    setIsOpen(false);
  }

  return (
    <>
      <button
        onClick={openModal}
        className="p-2 rounded-lg hover:bg-secondary transition-colors"
        title="Настройки книги"
      >
        <Settings className="w-5 h-5 text-muted-foreground hover:text-foreground" />
      </button>

      {isOpen ? (
        <div className="fixed inset-0 z-50">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/50"
            onClick={closeModal}
          />

          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="absolute left-1/2 top-1/2 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-6 shadow-xl"
          >
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-2xl text-foreground">Настройки книги</h2>
              <button
                onClick={closeModal}
                className="rounded-lg p-2 transition-colors hover:bg-secondary"
                disabled={saving || deleting}
              >
                <X className="h-5 w-5 text-muted-foreground" />
              </button>
            </div>

            <div className="space-y-6">
              <div>
                <h3 className="mb-4 text-foreground">Видимость</h3>
                <div className="space-y-3">
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 transition-colors hover:border-primary/30">
                    <input
                      type="radio"
                      name="visibility"
                      checked={isPublic}
                      onChange={() => setIsPublic(true)}
                      className="mt-1"
                      disabled={saving || deleting}
                    />
                    <div className="flex-1">
                      <div className="mb-1 flex items-center gap-2">
                        <Globe className="h-4 w-4 text-primary" />
                        <span className="text-foreground">Публичная</span>
                      </div>
                      <p className="text-sm text-muted-foreground">Анализ доступен всем пользователям в каталоге</p>
                    </div>
                  </label>

                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 transition-colors hover:border-primary/30">
                    <input
                      type="radio"
                      name="visibility"
                      checked={!isPublic}
                      onChange={() => setIsPublic(false)}
                      className="mt-1"
                      disabled={saving || deleting}
                    />
                    <div className="flex-1">
                      <div className="mb-1 flex items-center gap-2">
                        <Lock className="h-4 w-4" />
                        <span className="text-foreground">Приватная</span>
                      </div>
                      <p className="text-sm text-muted-foreground">Только вы можете видеть этот анализ</p>
                    </div>
                  </label>
                </div>
              </div>

              {error ? (
                <div className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <button
                onClick={handleSave}
                disabled={saving || deleting}
                className="w-full rounded-lg bg-primary px-6 py-3 text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Сохраняем..." : "Сохранить изменения"}
              </button>

              <div className="border-t border-border pt-6">
                <h3 className="mb-2 text-foreground">Опасная зона</h3>
                <p className="mb-4 text-sm text-muted-foreground">
                  Удаление книги необратимо. Все данные анализа будут потеряны.
                </p>

                {!showDeleteConfirm ? (
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    disabled={saving || deleting}
                    className="w-full rounded-lg border border-destructive px-6 py-3 text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Удалить книгу
                  </button>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
                      <p className="text-sm text-destructive">Вы уверены? Это действие нельзя отменить.</p>
                    </div>

                    <div className="flex gap-3">
                      <button
                        onClick={() => setShowDeleteConfirm(false)}
                        disabled={saving || deleting}
                        className="flex-1 rounded-lg border border-border px-6 py-3 text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Отмена
                      </button>

                      <button
                        onClick={handleDelete}
                        disabled={saving || deleting}
                        className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-destructive px-6 py-3 text-destructive-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Trash2 className="h-4 w-4" />
                        {deleting ? "Удаляем..." : "Удалить"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      ) : null}
    </>
  );
}
