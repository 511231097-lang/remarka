export function getEntityIdFromSearch(rawSearchParams: string): string | null {
  const params = new URLSearchParams(rawSearchParams);
  const value = params.get("entity")?.trim() || "";
  return value || null;
}

export function getMentionIdFromSearch(rawSearchParams: string): string | null {
  const params = new URLSearchParams(rawSearchParams);
  const value = params.get("mention")?.trim() || "";
  return value || null;
}

export function buildSearchWithEntity(rawSearchParams: string, entityId: string | null): string {
  const params = new URLSearchParams(rawSearchParams);

  if (entityId) {
    params.set("entity", entityId);
  } else {
    params.delete("entity");
  }
  params.delete("mention");

  const query = params.toString();
  return query ? `?${query}` : "";
}
