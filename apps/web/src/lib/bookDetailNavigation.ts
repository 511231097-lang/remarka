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

export function resolveBookDetailBackTarget(
  source: BookDetailSource | null,
  fallbackSource: BookDetailSource = "explore"
): {
  source: BookDetailSource;
  href: string;
  label: string;
} {
  const resolved = source || fallbackSource;
  if (resolved === "library") {
    return {
      source: resolved,
      href: "/library",
      label: "К моим книгам",
    };
  }

  return {
    source: resolved,
    href: "/explore",
    label: "К каталогу",
  };
}
