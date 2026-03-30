import {
  normalizeEntityName,
  type EntityType,
  type ExtractionResult,
} from "@remarka/contracts";

export interface CandidateEntity {
  entityRef: string;
  type: EntityType;
  name: string;
  summary: string;
}

const UPSERT_PRIORITY: Record<EntityType, number> = {
  location: 0,
  character: 1,
  event: 2,
  time_marker: 3,
};

export function toCandidateKey(type: EntityType, name: string): string {
  return `${type}::${normalizeEntityName(name)}`;
}

export function orderCandidatesForUpsert(candidates: CandidateEntity[]): CandidateEntity[] {
  return [...candidates].sort((a, b) => {
    const byPriority = UPSERT_PRIORITY[a.type] - UPSERT_PRIORITY[b.type];
    if (byPriority !== 0) return byPriority;

    const byName = a.name.localeCompare(b.name, "ru", { sensitivity: "base" });
    if (byName !== 0) return byName;

    return a.entityRef.localeCompare(b.entityRef, "ru", { sensitivity: "base" });
  });
}

export function collectEntityCandidates(result: ExtractionResult): CandidateEntity[] {
  const byRef = new Map<string, CandidateEntity>();
  const mentionBackedRefs = new Set(result.mentions.map((mention) => mention.entityRef));
  const entityMetaByRef = new Map<string, Pick<CandidateEntity, "summary" | "name" | "type">>();

  const addCandidate = (entity: CandidateEntity) => {
    const entityRef = String(entity.entityRef || "").trim();
    const trimmedName = String(entity.name || "").trim();
    if (!entityRef || !trimmedName) return;

    const existing = byRef.get(entityRef);
    if (!existing) {
      byRef.set(entityRef, {
        entityRef,
        type: entity.type,
        name: trimmedName,
        summary: String(entity.summary || "").trim(),
      });
      return;
    }

    if (!existing.summary && entity.summary.trim()) {
      existing.summary = entity.summary.trim();
    }

    if (trimmedName.length && trimmedName.length < existing.name.length) {
      existing.name = trimmedName;
    }
  };

  for (const entity of result.entities) {
    entityMetaByRef.set(entity.entityRef, {
      summary: entity.summary || "",
      name: entity.name,
      type: entity.type,
    });

    if (!mentionBackedRefs.has(entity.entityRef)) continue;

    addCandidate({
      entityRef: entity.entityRef,
      type: entity.type,
      name: entity.name,
      summary: entity.summary || "",
    });
  }

  for (const mention of result.mentions) {
    const entityMeta = entityMetaByRef.get(mention.entityRef);

    addCandidate({
      entityRef: mention.entityRef,
      type: mention.type,
      name: mention.name,
      summary: entityMeta?.summary || "",
    });
  }

  for (const annotation of result.annotations) {
    if (!annotation.entityRef) continue;
    if (!mentionBackedRefs.has(annotation.entityRef)) continue;

    const entityMeta = entityMetaByRef.get(annotation.entityRef);
    addCandidate({
      entityRef: annotation.entityRef,
      type: annotation.type,
      name: annotation.name || entityMeta?.name || "",
      summary: entityMeta?.summary || "",
    });
  }

  return Array.from(byRef.values());
}
