"use client";

import { motion } from "motion/react";
import { Settings, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteBook } from "@/lib/booksClient";
import type { BookCoreDTO } from "@/lib/books";

interface BookSettingsProps {
  book: BookCoreDTO;
  triggerClassName?: string;
  triggerLabel?: string;
}

export function BookSettings({ book, triggerClassName, triggerLabel }: BookSettingsProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!book.canManage) {
    return null;
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
    setShowDeleteConfirm(false);
    setError(null);
    setIsOpen(true);
  }

  function closeModal() {
    if (deleting) return;
    setIsOpen(false);
  }

  return (
    <>
      <button
        onClick={openModal}
        className={triggerClassName || "p-2 rounded-lg hover:bg-secondary transition-colors"}
        title="Настройки книги"
      >
        {triggerClassName ? (
          <>
            <Settings size={16} />
            {triggerLabel ? <span>{triggerLabel}</span> : null}
          </>
        ) : (
          <Settings className="w-5 h-5 text-muted-foreground hover:text-foreground" />
        )}
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
                disabled={deleting}
              >
                <X className="h-5 w-5 text-muted-foreground" />
              </button>
            </div>

            <div className="space-y-6">
              {error ? (
                <div className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <div className="border-t border-border pt-6">
                <h3 className="mb-2 text-foreground">Опасная зона</h3>
                <p className="mb-4 text-sm text-muted-foreground">
                  Удаление книги необратимо. Все данные анализа будут потеряны.
                </p>

                {!showDeleteConfirm ? (
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    disabled={deleting}
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
                        disabled={deleting}
                        className="flex-1 rounded-lg border border-border px-6 py-3 text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Отмена
                      </button>

                      <button
                        onClick={handleDelete}
                        disabled={deleting}
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
