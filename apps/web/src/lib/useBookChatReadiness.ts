"use client";

import { useEffect, useState } from "react";
import { getBookAnalysisStatus } from "@/lib/booksClient";
import type { BookAnalysisStatusDTO } from "@/lib/books";

interface UseBookChatReadinessResult {
  status: BookAnalysisStatusDTO | null;
  readiness: BookAnalysisStatusDTO["chatReadiness"] | null;
  loading: boolean;
  error: string | null;
}

export function useBookChatReadiness(bookId: string): UseBookChatReadinessResult {
  const [status, setStatus] = useState<BookAnalysisStatusDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bookId) {
      setStatus(null);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (delayMs: number) => {
      pollTimer = setTimeout(() => {
        void loadStatus(true);
      }, Math.max(1200, delayMs));
    };

    const loadStatus = async (isPoll: boolean) => {
      if (!isPoll && active) {
        setLoading(true);
        setError(null);
      }

      try {
        const nextStatus = await getBookAnalysisStatus(bookId);
        if (!active) return;

        setStatus(nextStatus);
        setError(null);
        setLoading(false);

        if (nextStatus.shouldPoll) {
          schedulePoll(nextStatus.pollIntervalMs || 3000);
        }
      } catch (loadError) {
        if (!active) return;
        setLoading(false);
        setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить состояние чата");
        if (isPoll) {
          schedulePoll(4000);
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
  }, [bookId]);

  return {
    status,
    readiness: status?.chatReadiness || null,
    loading,
    error,
  };
}
