"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { fetchJson, formatInt } from "@/components/admin/adminClientUtils";

interface SearchResponse {
  book: {
    id: string;
    title: string;
    author: string | null;
    analysisStatus: string;
  };
  query: string;
  mode: string;
  sort: string;
  range: {
    chapter: number;
    start: number;
    end: number;
  } | null;
  limit: number;
  debug: {
    semanticEnabled: boolean;
    lexicalEnabled: boolean;
    rerankRequested: boolean;
    embedding: {
      model: string;
      dimensions: number;
      inputTokens: number;
    } | null;
    rerank: Record<
      string,
      {
        enabled: boolean;
        used: boolean;
        model: string | null;
        candidateCount: number;
        returned: number;
        error?: string;
      }
    >;
    versions: Record<string, number>;
  };
  chapters: Array<{
    id: string;
    orderIndex: number;
    title: string;
  }>;
  paragraphs: Array<{
    id: string;
    chapterId: string;
    chapterOrderIndex: number;
    chapterTitle: string;
    paragraphIndex: number;
    orderIndex: number;
    text: string;
    textPreview: string;
    sceneId: string | null;
    sceneIndex: number | null;
    sceneCard: string | null;
    matchedBy: string[];
    semanticScore: number | null;
    lexicalRank: number | null;
    rerankScore: number | null;
    score: number;
  }>;
  scenes: Array<{
    id: string;
    chapterId: string;
    chapterOrderIndex: number;
    chapterTitle: string;
    sceneIndex: number;
    paragraphStart: number;
    paragraphEnd: number;
    sceneCard: string;
    sceneSummary: string;
    participants: string[];
    mentionedEntities: string[];
    eventLabels: string[];
    facts: string[];
    excerptText: string;
    matchedBy: string[];
    semanticScore: number | null;
    lexicalRank: number | null;
    rerankScore: number | null;
    score: number;
  }>;
  fragments: Array<{
    id: string;
    chapterId: string;
    chapterOrderIndex: number;
    chapterTitle: string;
    fragmentType: string;
    primarySceneId: string | null;
    sceneIndex: number | null;
    sceneCard: string | null;
    paragraphStart: number;
    paragraphEnd: number;
    text: string;
    textPreview: string;
    matchedBy: string[];
    semanticScore: number | null;
    lexicalRank: number | null;
    rerankScore: number | null;
    score: number;
  }>;
  sceneGroups: Array<{
    scene: SearchResponse["scenes"][number];
    hitParagraphCount: number;
    paragraphCount: number;
    fragments: Array<{
      id: string;
      fragmentType: string;
      paragraphStart: number;
      paragraphEnd: number;
      textPreview: string;
      matchedBy: string[];
      semanticScore: number | null;
      lexicalRank: number | null;
      rerankScore: number | null;
      score: number;
    }>;
    paragraphs: Array<{
      id: string;
      chapterId: string;
      chapterOrderIndex: number;
      paragraphIndex: number;
      orderIndex: number;
      text: string;
      textPreview: string;
      matchedBy: string[];
      semanticScore: number | null;
      lexicalRank: number | null;
      rerankScore: number | null;
      score: number;
      isHit: boolean;
    }>;
  }>;
}

function makeRangeLink(bookId: string, chapter: number, start: number, end: number) {
  const params = new URLSearchParams();
  params.set("bookId", bookId);
  params.set("chapter", String(chapter));
  params.set("start", String(start));
  params.set("end", String(end));
  params.set("limit", "100");
  return `/admin/book-search?${params.toString()}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
    >
      {copied ? "Скопировано" : "Копировать"}
    </button>
  );
}

function ScoreBadges({
  matchedBy,
  semanticScore,
  lexicalRank,
  rerankScore,
  score,
}: {
  matchedBy: string[];
  semanticScore: number | null;
  lexicalRank: number | null;
  rerankScore: number | null;
  score: number;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {matchedBy.map((item) => (
        <span key={item} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {item}
        </span>
      ))}
      {semanticScore !== null ? (
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          sem {semanticScore.toFixed(3)}
        </span>
      ) : null}
      {rerankScore !== null ? (
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          rerank {rerankScore.toFixed(3)}
        </span>
      ) : null}
      {lexicalRank !== null ? (
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">lex #{lexicalRank}</span>
      ) : null}
      <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">score {score.toFixed(3)}</span>
    </div>
  );
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function AdminBookSearchPage() {
  const searchParams = useSearchParams();
  const [bookId, setBookId] = useState(searchParams.get("bookId") || "");
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [chapter, setChapter] = useState(searchParams.get("chapter") || "");
  const [start, setStart] = useState(searchParams.get("start") || "");
  const [end, setEnd] = useState(searchParams.get("end") || "");
  const [limit, setLimit] = useState(searchParams.get("limit") || "50");
  const [mode, setMode] = useState(searchParams.get("mode") || "hybrid");
  const [sort, setSort] = useState(searchParams.get("sort") || "rerank");
  const [rerank, setRerank] = useState(searchParams.get("rerank") || "true");
  const [minScore, setMinScore] = useState(searchParams.get("minScore") || "");
  const [minSemantic, setMinSemantic] = useState(searchParams.get("minSemantic") || "");
  const [minRerank, setMinRerank] = useState(searchParams.get("minRerank") || "");
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [selectedParagraphId, setSelectedParagraphId] = useState<string | null>(null);
  const [submittedParams, setSubmittedParams] = useState<URLSearchParams | null>(null);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiPath = useMemo(() => {
    if (!submittedParams) return null;
    return `/api/admin/book-search?${submittedParams.toString()}`;
  }, [submittedParams]);

  useEffect(() => {
    if (!apiPath) return;
    let active = true;
    setLoading(true);
    setError(null);

    void fetchJson<SearchResponse>(apiPath)
      .then((payload) => {
        if (!active) return;
        setData(payload);
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Не удалось выполнить поиск");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [apiPath]);

  const submit = () => {
    const params = new URLSearchParams();
    if (bookId.trim()) params.set("bookId", bookId.trim());
    if (query.trim()) params.set("q", query.trim());
    if (chapter.trim()) params.set("chapter", chapter.trim());
    if (start.trim()) params.set("start", start.trim());
    if (end.trim()) params.set("end", end.trim());
    if (limit.trim()) params.set("limit", limit.trim());
    if (mode.trim()) params.set("mode", mode.trim());
    if (sort.trim()) params.set("sort", sort.trim());
    params.set("rerank", rerank);
    setSubmittedParams(params);
    window.history.replaceState(null, "", `/admin/book-search?${params.toString()}`);
  };

  const localThresholds = useMemo(
    () => ({
      score: Number.parseFloat(minScore),
      semantic: Number.parseFloat(minSemantic),
      rerank: Number.parseFloat(minRerank),
    }),
    [minRerank, minScore, minSemantic]
  );

  const passesLocalFilter = (item: { score: number; semanticScore: number | null; rerankScore: number | null }) => {
    if (Number.isFinite(localThresholds.score) && item.score < localThresholds.score) return false;
    if (Number.isFinite(localThresholds.semantic) && (item.semanticScore === null || item.semanticScore < localThresholds.semantic)) return false;
    if (Number.isFinite(localThresholds.rerank) && (item.rerankScore === null || item.rerankScore < localThresholds.rerank)) return false;
    return true;
  };

  const filteredData = useMemo(() => {
    if (!data) return null;
    const scenes = data.scenes.filter(passesLocalFilter);
    const fragments = data.fragments.filter(passesLocalFilter);
    const sceneGroups = data.sceneGroups
      .map((group) => {
        const scenePasses = passesLocalFilter(group.scene);
        const groupFragments = group.fragments.filter(passesLocalFilter);
        const paragraphs = group.paragraphs.filter((paragraph) => !paragraph.isHit || passesLocalFilter(paragraph));
        const hasHitParagraph = paragraphs.some((paragraph) => paragraph.isHit);
        if (!scenePasses && !groupFragments.length && !hasHitParagraph) return null;
        return {
          ...group,
          fragments: groupFragments,
          paragraphs,
          hitParagraphCount: paragraphs.filter((paragraph) => paragraph.isHit).length,
          paragraphCount: paragraphs.length,
        };
      })
      .filter((group): group is SearchResponse["sceneGroups"][number] => Boolean(group));
    return {
      ...data,
      scenes,
      fragments,
      sceneGroups,
      totalScenes: data.scenes.length,
      totalFragments: data.fragments.length,
      totalSceneGroups: data.sceneGroups.length,
    };
  }, [data, localThresholds]);

  const selectedSceneGroup = useMemo(() => {
    if (!filteredData || !selectedSceneId) return null;
    return filteredData.sceneGroups.find((group) => group.scene.id === selectedSceneId) || null;
  }, [filteredData, selectedSceneId]);

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-xl text-foreground">Поиск по книге</h2>
            <p className="text-sm text-muted-foreground">
              Ручной поиск по параграфам и сценам. Используй для проверки островов, диапазонов и evidence.
            </p>
          </div>

          <div className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)_140px_140px_90px_90px_90px_90px_auto]">
            <input
              value={bookId}
              onChange={(event) => setBookId(event.target.value)}
              placeholder="bookId"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Поиск по тексту, сценам"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="hybrid">hybrid</option>
              <option value="semantic">semantic all</option>
              <option value="lexical">lexical</option>
              <option value="scenes">scenes</option>
              <option value="paragraphs">paragraphs</option>
              <option value="fragments">fragments</option>
            </select>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="rerank">sort: rerank</option>
              <option value="chronological">sort: chronological</option>
            </select>
            <input
              value={chapter}
              onChange={(event) => setChapter(event.target.value)}
              placeholder="Глава"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <input
              value={start}
              onChange={(event) => setStart(event.target.value)}
              placeholder="Параграф с"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <input
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              placeholder="Параграф по"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <input
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              placeholder="limit"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <select
              value={rerank}
              onChange={(event) => setRerank(event.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="true">rerank</option>
              <option value="false">no rerank</option>
            </select>
            <button
              type="button"
              onClick={submit}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Найти
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Подсказка: `Глава` ограничивает весь hybrid/semantic/lexical поиск. `Параграф с/по` дополнительно сужает диапазон.
            Запрос выполняется только по кнопке.
          </p>
          <div className="grid gap-2 md:grid-cols-[140px_140px_140px]">
            <input
              value={minScore}
              onChange={(event) => setMinScore(event.target.value)}
              placeholder="min score"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <input
              value={minSemantic}
              onChange={(event) => setMinSemantic(event.target.value)}
              placeholder="min semantic"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <input
              value={minRerank}
              onChange={(event) => setMinRerank(event.target.value)}
              placeholder="min rerank"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Локальные фильтры выше не делают новый запрос, а только скрывают результаты на странице.
          </p>
        </div>
      </section>

      {loading ? <p className="text-sm text-muted-foreground">Ищем...</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {filteredData ? (
        <>
          <section className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Книга</p>
                <h3 className="text-lg text-foreground">{filteredData.book.title}</h3>
                <p className="text-sm text-muted-foreground">
                  {filteredData.book.author || "Автор не указан"} · {filteredData.book.analysisStatus} · {filteredData.book.id}
                </p>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <p>Параграфы-hit: {formatInt(filteredData.paragraphs.length)}</p>
                <p>
                  Сцены: {formatInt(filteredData.scenes.length)} / {formatInt(filteredData.totalScenes)}
                </p>
                <p>
                  Фрагменты: {formatInt(filteredData.fragments.length)} / {formatInt(filteredData.totalFragments)}
                </p>
                <p>
                  Группы: {formatInt(filteredData.sceneGroups.length)} / {formatInt(filteredData.totalSceneGroups)}
                </p>
              </div>
            </div>
            <div className="mt-3 rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
              <p>
                mode: {filteredData.mode} · sort: {filteredData.sort} · semantic: {String(filteredData.debug.semanticEnabled)} · lexical:{" "}
                {String(filteredData.debug.lexicalEnabled)} · rerank: {String(filteredData.debug.rerankRequested)}
              </p>
              <p>
                embedding:{" "}
                {filteredData.debug.embedding
                  ? `${filteredData.debug.embedding.model}, dim ${filteredData.debug.embedding.dimensions}, tokens ${formatInt(
                      filteredData.debug.embedding.inputTokens
                    )}`
                  : "none"}
              </p>
              <p>
                rerank paragraphs: {filteredData.debug.rerank.paragraphs?.used ? "used" : "off"} · scenes:{" "}
                {filteredData.debug.rerank.scenes?.used ? "used" : "off"} · fragments:{" "}
                {filteredData.debug.rerank.fragments?.used ? "used" : "off"}
              </p>
              {Object.values(filteredData.debug.rerank).some((item) => item.error) ? (
                <p className="text-destructive">{Object.values(filteredData.debug.rerank).find((item) => item.error)?.error}</p>
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3">
              <h3 className="text-base text-foreground">Карта retrieval</h3>
              <p className="text-xs text-muted-foreground">
                Слева направо: главы, сцены и параграфы. Высота столбика = score параграфа, яркость сцены = score сцены.
              </p>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border bg-background p-3">
              <div className="flex min-w-max items-end gap-3">
                {Object.entries(
                  filteredData.sceneGroups.reduce<Record<string, typeof filteredData.sceneGroups>>((acc, group) => {
                    const key = `Глава ${group.scene.chapterOrderIndex}`;
                    acc[key] = acc[key] || [];
                    acc[key].push(group);
                    return acc;
                  }, {})
                ).map(([chapterLabel, groups]) => (
                  <div key={chapterLabel} className="flex flex-col gap-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{chapterLabel}</p>
                    <div className="flex items-end gap-1">
                      {groups.map((group) => {
                        const scene = group.scene;
                        const selected = selectedSceneId === scene.id;
                        const intensity = clamp01(scene.score);
                        return (
                          <button
                            key={scene.id}
                            type="button"
                            onClick={() => {
                              setSelectedSceneId(scene.id);
                              setSelectedParagraphId(null);
                            }}
                            title={`ch${scene.chapterOrderIndex}:p${scene.paragraphStart}-${scene.paragraphEnd} · scene ${scene.sceneIndex} · score ${scene.score.toFixed(3)}`}
                            className={`flex h-28 items-end gap-[2px] rounded-md border px-1 pb-1 transition-colors ${
                              selected ? "border-primary bg-primary/15" : "border-border hover:border-primary/50"
                            }`}
                            style={{
                              backgroundColor: selected
                                ? undefined
                                : `color-mix(in srgb, hsl(var(--primary)) ${Math.round(intensity * 55)}%, hsl(var(--card)))`,
                            }}
                          >
                            {group.paragraphs.map((paragraph) => {
                              const height = Math.max(4, Math.round(clamp01(paragraph.score) * 88));
                              const paragraphSelected = selectedParagraphId === paragraph.id;
                              return (
                                <span
                                  key={paragraph.id}
                                  role="button"
                                  tabIndex={0}
                                  title={`p${paragraph.paragraphIndex} · score ${paragraph.score.toFixed(3)}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setSelectedSceneId(scene.id);
                                    setSelectedParagraphId(paragraph.id);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter" && event.key !== " ") return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setSelectedSceneId(scene.id);
                                    setSelectedParagraphId(paragraph.id);
                                  }}
                                  className={`block w-2 rounded-t-sm ${
                                    paragraphSelected
                                      ? "bg-primary"
                                      : paragraph.isHit
                                        ? "bg-primary/80"
                                        : "bg-muted-foreground/25"
                                  }`}
                                  style={{ height }}
                                />
                              );
                            })}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              {!filteredData.sceneGroups.length ? <p className="text-sm text-muted-foreground">Группы не собраны.</p> : null}
            </div>

            {selectedSceneGroup ? (
              <article className="mt-4 rounded-lg border border-border bg-background p-3">
                {(() => {
                  const scene = selectedSceneGroup.scene;
                  const range = `ch${scene.chapterOrderIndex}:p${scene.paragraphStart}-${scene.paragraphEnd}`;
                  return (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs uppercase tracking-wide text-muted-foreground">
                            {range} · scene {scene.sceneIndex} · hits {selectedSceneGroup.hitParagraphCount}/{selectedSceneGroup.paragraphCount}
                          </p>
                          <h4 className="mt-1 text-sm text-foreground">{scene.sceneCard}</h4>
                          <p className="mt-1 text-xs text-muted-foreground">{scene.chapterTitle}</p>
                          <div className="mt-2">
                            <ScoreBadges
                              matchedBy={scene.matchedBy}
                              semanticScore={scene.semanticScore}
                              lexicalRank={scene.lexicalRank}
                              rerankScore={scene.rerankScore}
                              score={scene.score}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Link
                            href={makeRangeLink(filteredData.book.id, scene.chapterOrderIndex, scene.paragraphStart, scene.paragraphEnd)}
                            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                          >
                            Открыть range
                          </Link>
                          <CopyButton
                            value={`${range}\n${scene.sceneCard}\n\n${selectedSceneGroup.paragraphs.map((paragraph) => paragraph.text).join("\n\n")}`}
                          />
                        </div>
                      </div>

                      {scene.sceneSummary ? <p className="mt-3 text-sm text-foreground">{scene.sceneSummary}</p> : null}

                      {selectedSceneGroup.fragments.length ? (
                        <div className="mt-3 rounded-md border border-border bg-card p-3">
                          <p className="text-xs uppercase tracking-wide text-muted-foreground">Retrieval fragments in scene</p>
                          <div className="mt-2 space-y-2">
                            {selectedSceneGroup.fragments.map((fragment) => (
                              <div key={fragment.id} className="rounded-md border border-border bg-background p-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-xs text-muted-foreground">
                                    {fragment.fragmentType} · p{fragment.paragraphStart}-{fragment.paragraphEnd}
                                  </p>
                                  <ScoreBadges
                                    matchedBy={fragment.matchedBy}
                                    semanticScore={fragment.semanticScore}
                                    lexicalRank={fragment.lexicalRank}
                                    rerankScore={fragment.rerankScore}
                                    score={fragment.score}
                                  />
                                </div>
                                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{fragment.textPreview}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div className="mt-3 space-y-2">
                        {selectedSceneGroup.paragraphs.map((paragraph) => {
                          const ref = `p${paragraph.paragraphIndex}`;
                          const selected = selectedParagraphId === paragraph.id;
                          return (
                            <div
                              key={paragraph.id}
                              className={`rounded-md border p-2 ${
                                selected
                                  ? "border-primary bg-primary/10"
                                  : paragraph.isHit
                                    ? "border-primary/45 bg-primary/5"
                                    : "border-border bg-card"
                              }`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                                  {ref} · order {paragraph.orderIndex}
                                </p>
                                {paragraph.isHit ? (
                                  <ScoreBadges
                                    matchedBy={paragraph.matchedBy}
                                    semanticScore={paragraph.semanticScore}
                                    lexicalRank={paragraph.lexicalRank}
                                    rerankScore={paragraph.rerankScore}
                                    score={paragraph.score}
                                  />
                                ) : null}
                              </div>
                              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{paragraph.text}</p>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  );
                })()}
              </article>
            ) : null}
          </section>

        </>
      ) : null}
    </div>
  );
}
