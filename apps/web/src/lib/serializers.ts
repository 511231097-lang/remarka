import type { EntityType } from "@remarka/contracts";

type MentionWithEntity = {
  id: string;
  entityId: string;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  sourceText: string;
  entity: {
    id: string;
    type: EntityType;
    name: string;
  };
};

type AnnotationWithEntity = {
  id: string;
  paragraphIndex: number;
  label: string;
  type: EntityType;
  entityId: string | null;
  entity: {
    id: string;
    type: EntityType;
    name: string;
  } | null;
};

export type DocumentWithRelations = {
  id: string;
  projectId: string;
  chapterId: string;
  content: string;
  richContent: unknown;
  contentVersion: number;
  analysisStatus: "idle" | "queued" | "running" | "completed" | "failed";
  lastAnalyzedVersion: number | null;
  mentions: MentionWithEntity[];
  annotations: AnnotationWithEntity[];
};

export function toDocumentPayload(document: DocumentWithRelations) {
  return {
    id: document.id,
    projectId: document.projectId,
    chapterId: document.chapterId,
    content: document.content,
    richContent: document.richContent,
    contentVersion: document.contentVersion,
    analysisStatus: document.analysisStatus,
    lastAnalyzedVersion: document.lastAnalyzedVersion,
    mentions: document.mentions.map((mention: MentionWithEntity) => ({
      id: mention.id,
      entityId: mention.entityId,
      paragraphIndex: mention.paragraphIndex,
      startOffset: mention.startOffset,
      endOffset: mention.endOffset,
      sourceText: mention.sourceText,
      entity: mention.entity,
    })),
    annotations: document.annotations.map((annotation: AnnotationWithEntity) => ({
      id: annotation.id,
      paragraphIndex: annotation.paragraphIndex,
      label: annotation.label,
      type: annotation.type,
      entityId: annotation.entityId,
      entity: annotation.entity,
    })),
  };
}
