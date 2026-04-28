"use client";

import { useEffect, useMemo, useState } from "react";
import type { AdminMetricsWindow } from "@/lib/adminMetrics";
import {
  WINDOW_OPTIONS,
  clampPercent,
  fetchJson,
  formatInt,
  formatIso,
  formatMs,
  formatUsd,
} from "@/components/admin/adminClientUtils";

interface SeriesItem {
  bucketStart: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  avgMs: number;
}

interface OverviewResponse {
  window: AdminMetricsWindow;
  windowStart: string | null;
  seriesBucket: "hour" | "day" | "week" | "month";
  totals: {
    users: number;
    books: number;
    chatThreads: number;
    chatMessages: number;
  };
  analysis: {
    runs: number;
    tokens: {
      llm: number;
      embedding: number;
      total: number;
      input: number;
      output: number;
    };
    costUsd: number;
    speed: {
      avgMs: number;
      p95Ms: number;
      tokensPerSec: number;
    };
  };
  chat: {
    turns: number;
    tokens: {
      model: number;
      embedding: number;
      total: number;
      input: number;
      output: number;
    };
    costUsd: number;
    speed: {
      avgMs: number;
      p95Ms: number;
      tokensPerSec: number;
    };
  };
  queue: {
    pending: number;
    active: number;
    retrying: number;
    deadLetter: number;
    oldestPendingAgeMs: number;
    dispatchLagMs: number;
  };
  models: {
    analysisLlm: Array<{
      model: string;
      runs: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costUsd: number;
      avgMs: number;
    }>;
    analysisEmbedding: Array<{
      model: string;
      runs: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costUsd: number;
      avgMs: number;
    }>;
    chatModel: Array<{
      model: string;
      turns: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costUsd: number;
      avgMs: number;
    }>;
    chatEmbedding: Array<{
      model: string;
      turns: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costUsd: number;
      avgMs: number;
    }>;
  };
  series: {
    analysis: SeriesItem[];
    chat: SeriesItem[];
  };
}

function StatCard(props: { title: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{props.title}</p>
      <p className="mt-2 text-2xl text-foreground">{props.value}</p>
      {props.sub ? <p className="mt-1 text-xs text-muted-foreground">{props.sub}</p> : null}
    </div>
  );
}

function TimelineBars(props: {
  title: string;
  items: SeriesItem[];
  unitLabel: string;
  getValue: (row: SeriesItem) => number;
  toneClass: string;
}) {
  const maxValue = useMemo(() => {
    const values = props.items.map((item) => Math.max(0, Number(props.getValue(item) || 0)));
    return Math.max(1, ...values);
  }, [props]);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-foreground">{props.title}</p>
          <p className="text-xs text-muted-foreground">По окнам времени</p>
        </div>
        <p className="text-xs text-muted-foreground">max {props.unitLabel}: {props.getValue(props.items.at(-1) || {
          bucketStart: "",
          count: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          avgMs: 0,
        }).toFixed(2)}</p>
      </div>

      {props.items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Нет данных в выбранном окне.</p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <div className="flex h-36 min-w-[640px] items-end gap-1">
              {props.items.map((item) => {
                const value = Math.max(0, Number(props.getValue(item) || 0));
                const height = Math.max(4, clampPercent((value / maxValue) * 100));
                return (
                  <div key={item.bucketStart} className="group relative flex-1" title={`${formatIso(item.bucketStart)} • ${value.toFixed(2)} ${props.unitLabel}`}>
                    <div
                      className={`w-full rounded-t-sm ${props.toneClass}`}
                      style={{ height: `${height}%` }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{formatIso(props.items[0].bucketStart)}</span>
            <span>{formatIso(props.items[props.items.length - 1].bucketStart)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function ModelSpendTable(props: {
  title: string;
  rows: Array<{
    model: string;
    count: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    avgMs: number;
  }>;
  countLabel: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm text-foreground">{props.title}</h3>
      {props.rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Нет данных.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-left uppercase text-muted-foreground">
                <th className="py-2 pr-2">Модель</th>
                <th className="py-2 pr-2">{props.countLabel}</th>
                <th className="py-2 pr-2">Input</th>
                <th className="py-2 pr-2">Output</th>
                <th className="py-2 pr-2">Total</th>
                <th className="py-2 pr-2">Cost</th>
                <th className="py-2 pr-2">Avg</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.slice(0, 12).map((row) => (
                <tr key={row.model} className="border-b border-border/60">
                  <td className="py-2 pr-2 text-foreground">{row.model}</td>
                  <td className="py-2 pr-2 text-foreground">{formatInt(row.count)}</td>
                  <td className="py-2 pr-2 text-foreground">{formatInt(row.inputTokens)}</td>
                  <td className="py-2 pr-2 text-foreground">{formatInt(row.outputTokens)}</td>
                  <td className="py-2 pr-2 text-foreground">{formatInt(row.totalTokens)}</td>
                  <td className="py-2 pr-2 text-foreground">{formatUsd(row.costUsd)}</td>
                  <td className="py-2 pr-2 text-foreground">{formatMs(row.avgMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AdminDashboardPage() {
  const [window, setWindow] = useState<AdminMetricsWindow>("30d");
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    void fetchJson<OverviewResponse>(`/api/admin/overview?window=${window}`)
      .then((payload) => {
        if (!active) return;
        setData(payload);
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить dashboard");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [window]);

  const analysisModelRows = useMemo(
    () =>
      (data?.models.analysisLlm || []).map((row) => ({
        model: row.model,
        count: row.runs,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        costUsd: row.costUsd,
        avgMs: row.avgMs,
      })),
    [data]
  );

  const chatModelRows = useMemo(
    () =>
      (data?.models.chatModel || []).map((row) => ({
        model: row.model,
        count: row.turns,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        costUsd: row.costUsd,
        avgMs: row.avgMs,
      })),
    [data]
  );

  const analysisEmbeddingRows = useMemo(
    () =>
      (data?.models.analysisEmbedding || []).map((row) => ({
        model: row.model,
        count: row.runs,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        costUsd: row.costUsd,
        avgMs: row.avgMs,
      })),
    [data]
  );

  const chatEmbeddingRows = useMemo(
    () =>
      (data?.models.chatEmbedding || []).map((row) => ({
        model: row.model,
        count: row.turns,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        costUsd: row.costUsd,
        avgMs: row.avgMs,
      })),
    [data]
  );

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-xl text-foreground">Общий дашборд</h2>
            <p className="text-sm text-muted-foreground">Расходы, токены, latency и проверка стабильности по окну.</p>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="window" className="text-sm text-muted-foreground">
              Окно
            </label>
            <select
              id="window"
              value={window}
              onChange={(event) => setWindow(event.target.value as AdminMetricsWindow)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {WINDOW_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {loading ? <p className="text-sm text-muted-foreground">Загрузка...</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {data ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard title="Пользователи" value={formatInt(data.totals.users)} sub="Всего аккаунтов" />
            <StatCard title="Книги" value={formatInt(data.totals.books)} sub={`Чаты: ${formatInt(data.totals.chatThreads)}`} />
            <StatCard
              title="Analysis cost"
              value={formatUsd(data.analysis.costUsd)}
              sub={`runs ${formatInt(data.analysis.runs)} • ${formatMs(data.analysis.speed.avgMs)} avg`}
            />
            <StatCard
              title="Chat cost"
              value={formatUsd(data.chat.costUsd)}
              sub={`turns ${formatInt(data.chat.turns)} • ${formatMs(data.chat.speed.avgMs)} avg`}
            />
            <StatCard
              title="Analysis tokens"
              value={formatInt(data.analysis.tokens.total)}
              sub={`in ${formatInt(data.analysis.tokens.input)} / out ${formatInt(data.analysis.tokens.output)}`}
            />
            <StatCard
              title="Chat tokens"
              value={formatInt(data.chat.tokens.total)}
              sub={`in ${formatInt(data.chat.tokens.input)} / out ${formatInt(data.chat.tokens.output)}`}
            />
            <StatCard
              title="Analysis p95"
              value={formatMs(data.analysis.speed.p95Ms)}
              sub={`${data.analysis.speed.tokensPerSec.toFixed(2)} tok/s`}
            />
            <StatCard
              title="Chat p95"
              value={formatMs(data.chat.speed.p95Ms)}
              sub={`${data.chat.speed.tokensPerSec.toFixed(2)} tok/s`}
            />
            <StatCard
              title="Queue pending"
              value={formatInt(data.queue.pending)}
              sub={`active ${formatInt(data.queue.active)} • retry ${formatInt(data.queue.retrying)}`}
            />
            <StatCard
              title="Queue lag"
              value={formatMs(data.queue.oldestPendingAgeMs)}
              sub={`dispatch lag ${formatMs(data.queue.dispatchLagMs)} • DLQ ${formatInt(data.queue.deadLetter)}`}
            />
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <TimelineBars
              title="Analysis cost"
              items={data.series.analysis}
              unitLabel="USD"
              getValue={(item) => item.costUsd}
              toneClass="bg-sky-500"
            />
            <TimelineBars
              title="Chat cost"
              items={data.series.chat}
              unitLabel="USD"
              getValue={(item) => item.costUsd}
              toneClass="bg-emerald-500"
            />
            <TimelineBars
              title="Analysis total tokens"
              items={data.series.analysis}
              unitLabel="tokens"
              getValue={(item) => item.totalTokens}
              toneClass="bg-indigo-500"
            />
            <TimelineBars
              title="Chat total tokens"
              items={data.series.chat}
              unitLabel="tokens"
              getValue={(item) => item.totalTokens}
              toneClass="bg-amber-500"
            />
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <ModelSpendTable title="Analysis LLM модели" rows={analysisModelRows} countLabel="runs" />
            <ModelSpendTable title="Chat модели" rows={chatModelRows} countLabel="turns" />
            <ModelSpendTable title="Analysis embedding модели" rows={analysisEmbeddingRows} countLabel="runs" />
            <ModelSpendTable title="Chat embedding модели" rows={chatEmbeddingRows} countLabel="turns" />
          </section>
        </>
      ) : null}
    </div>
  );
}
