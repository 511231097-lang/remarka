import { describe, expect, it } from "vitest";
import { syncDraftAfterSaveResponse, syncDraftAfterServerLoad } from "../editorSync";

describe("editor sync rules", () => {
  it("keeps local draft on server load when draft is dirty", () => {
    const synced = syncDraftAfterServerLoad({
      currentDraft: "local draft changed",
      previousServerContent: "server v1",
      loadedServerContent: "server v2",
    });

    expect(synced.draftContent).toBe("local draft changed");
    expect(synced.hasUnsavedChanges).toBe(true);
  });

  it("applies server content on server load when draft is clean", () => {
    const synced = syncDraftAfterServerLoad({
      currentDraft: "server v1",
      previousServerContent: "server v1",
      loadedServerContent: "server v2",
    });

    expect(synced.draftContent).toBe("server v2");
    expect(synced.hasUnsavedChanges).toBe(false);
  });

  it("does not overwrite newer local input with delayed save response", () => {
    const synced = syncDraftAfterSaveResponse({
      currentDraft: "local newer text",
      contentSnapshot: "local old text",
      savedContent: "server saved old text",
    });

    expect(synced.shouldReplaceDraft).toBe(false);
    expect(synced.draftContent).toBe("local newer text");
    expect(synced.hasUnsavedChanges).toBe(true);
  });

  it("applies canonical saved content if user did not type after save started", () => {
    const synced = syncDraftAfterSaveResponse({
      currentDraft: "  text with spaces  ",
      contentSnapshot: "  text with spaces  ",
      savedContent: "text with spaces",
    });

    expect(synced.shouldReplaceDraft).toBe(true);
    expect(synced.draftContent).toBe("text with spaces");
    expect(synced.hasUnsavedChanges).toBe(false);
  });
});
