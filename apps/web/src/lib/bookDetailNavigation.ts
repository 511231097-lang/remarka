export type BookDetailSource = "library" | "explore";

export function resolveBookDetailSource(value: string | null | undefined): BookDetailSource | null {
  if (value === "library") return "library";
  if (value === "explore") return "explore";
  return null;
}

export function appendBookDetailSource(path: string, source: BookDetailSource | null): string {
  if (!source) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}from=${source}`;
}
