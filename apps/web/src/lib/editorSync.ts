export interface ServerLoadSyncInput {
  currentDraft: string;
  previousServerContent: string;
  loadedServerContent: string;
}

export interface SaveResponseSyncInput {
  currentDraft: string;
  contentSnapshot: string;
  savedContent: string;
}

export interface DraftSyncResult {
  draftContent: string;
  hasUnsavedChanges: boolean;
}

export interface SaveResponseSyncResult extends DraftSyncResult {
  shouldReplaceDraft: boolean;
}

export function syncDraftAfterServerLoad(input: ServerLoadSyncInput): DraftSyncResult {
  const { currentDraft, previousServerContent, loadedServerContent } = input;

  if (currentDraft === previousServerContent) {
    return {
      draftContent: loadedServerContent,
      hasUnsavedChanges: false,
    };
  }

  return {
    draftContent: currentDraft,
    hasUnsavedChanges: currentDraft !== loadedServerContent,
  };
}

export function syncDraftAfterSaveResponse(input: SaveResponseSyncInput): SaveResponseSyncResult {
  const { currentDraft, contentSnapshot, savedContent } = input;
  const shouldReplaceDraft = currentDraft === contentSnapshot;
  const draftContent = shouldReplaceDraft ? savedContent : currentDraft;

  return {
    draftContent,
    shouldReplaceDraft,
    hasUnsavedChanges: draftContent !== savedContent,
  };
}
