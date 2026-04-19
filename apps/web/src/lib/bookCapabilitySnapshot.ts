import type { BookAnalysisStatusDTO, BookCapabilitySnapshotDTO, BookToolCapabilityLevelDTO } from "@/lib/books";

function level(params: { available: boolean; strong?: boolean; weak?: boolean }): BookToolCapabilityLevelDTO {
  if (!params.available) return "disabled";
  if (params.strong) return "high";
  if (params.weak) return "low";
  return "medium";
}

export function buildBookCapabilitySnapshot(status: {
  bookId: string;
  contentVersion: number | null;
  overallState: BookAnalysisStatusDTO["overallState"];
  coverage: BookAnalysisStatusDTO["coverage"];
  analyzers: BookAnalysisStatusDTO["analyzers"];
  counts: BookAnalysisStatusDTO["counts"];
}): BookCapabilitySnapshotDTO {
  const analysisState =
    status.overallState === "completed" ? "completed" : status.overallState === "failed" ? "failed" : "processing";
  const coverage = status.coverage === "unknown" ? "none" : status.coverage;

  const sourceReady = status.analyzers.ingest_normalize.state === "completed" && status.counts.source.paragraphs > 0;
  const entitiesReady = status.analyzers.entity_resolution.state === "completed" && status.counts.canonical.entities > 0;
  const presenceReady = status.analyzers.scene_assembly.state === "completed" && status.counts.readLayer.presenceMaps > 0;
  const evidenceReady = status.analyzers.index_build.state === "completed" && status.counts.readLayer.evidenceHits > 0;
  const statusReady = Boolean(status.contentVersion);

  const capabilities = {
    resolve_target: level({
      available: status.counts.canonical.entities > 0,
      strong: entitiesReady,
      weak: status.counts.canonical.entities > 0 && !entitiesReady,
    }),
    get_entity: level({
      available: status.counts.canonical.entities > 0,
      strong: entitiesReady,
      weak: status.counts.canonical.entities > 0 && !entitiesReady,
    }),
    get_presence: level({
      available: status.counts.readLayer.presenceMaps > 0,
      strong: presenceReady,
      weak: status.counts.readLayer.presenceMaps > 0 && !presenceReady,
    }),
    get_evidence: level({
      available: status.counts.readLayer.evidenceHits > 0,
      strong: evidenceReady,
      weak: status.counts.readLayer.evidenceHits > 0 && !evidenceReady,
    }),
    read_passages: level({
      available: status.counts.source.paragraphs > 0,
      strong: sourceReady,
      weak: status.counts.source.paragraphs > 0 && !sourceReady,
    }),
    get_processing_status: level({
      available: statusReady || analysisState !== "failed",
      strong: true,
    }),
  } satisfies BookCapabilitySnapshotDTO["capabilities"];

  const trustedTools = {
    resolve_target: capabilities.resolve_target === "high",
    get_entity: capabilities.get_entity === "high",
    get_presence: capabilities.get_presence === "high",
    get_evidence: capabilities.get_evidence === "high",
    read_passages: capabilities.read_passages === "high",
    get_processing_status: capabilities.get_processing_status === "high",
  };

  const warnings: string[] = [];
  if (coverage !== "full") {
    warnings.push(coverage === "none" ? "Анализ книги еще не собран." : "Coverage книги пока partial.");
  }
  if (!trustedTools.get_presence) {
    warnings.push("Presence-layer еще не полностью доверенный.");
  }
  if (analysisState !== "completed") {
    warnings.push("Анализ книги еще не завершен; ответы должны оставаться conservative.");
  }

  return {
    bookId: status.bookId,
    analysisVersion: status.contentVersion === null ? null : String(status.contentVersion),
    analysisState,
    coverage,
    capabilities,
    trustedTools,
    warnings,
  };
}

export function canUseMvpBookChat(snapshot: BookCapabilitySnapshotDTO): boolean {
  return (
    snapshot.capabilities.resolve_target !== "disabled" &&
    snapshot.capabilities.get_entity !== "disabled" &&
    snapshot.capabilities.get_presence !== "disabled" &&
    snapshot.capabilities.get_evidence !== "disabled" &&
    snapshot.capabilities.read_passages !== "disabled" &&
    snapshot.capabilities.get_processing_status !== "disabled"
  );
}
