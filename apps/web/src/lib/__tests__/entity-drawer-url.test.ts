import { describe, expect, it } from "vitest";
import { buildSearchWithEntity, getEntityIdFromSearch, getMentionIdFromSearch } from "../entityDrawerUrl";

describe("entity drawer url helpers", () => {
  it("reads entity id from query string", () => {
    expect(getEntityIdFromSearch("entity=abc123&foo=bar")).toBe("abc123");
  });

  it("returns null when entity param is empty", () => {
    expect(getEntityIdFromSearch("entity=&foo=bar")).toBeNull();
    expect(getEntityIdFromSearch("foo=bar")).toBeNull();
  });

  it("reads mention id from query string", () => {
    expect(getMentionIdFromSearch("mention=ment_1&entity=abc123")).toBe("ment_1");
    expect(getMentionIdFromSearch("mention=&entity=abc123")).toBeNull();
  });

  it("sets entity while preserving other query params", () => {
    expect(buildSearchWithEntity("foo=bar", "ent_1")).toBe("?foo=bar&entity=ent_1");
  });

  it("removes entity/mention while preserving other query params", () => {
    expect(buildSearchWithEntity("foo=bar&entity=ent_1&mention=ment_1", null)).toBe("?foo=bar");
  });
});
