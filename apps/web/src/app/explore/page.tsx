import type { Metadata } from "next";
import { Explore } from "@/components/Explore";
import { resolveAuthUser } from "@/lib/authUser";
import {
  DEFAULT_CATALOG_PAGE_SIZE,
  listCatalogBooks,
  parseCatalogSort,
} from "@/lib/server/catalog";

// Public, indexable. Bot fetches `/explore` and gets the first page of public
// books server-rendered (titles, authors, summaries, internal links to each
// `/book/[id]`). Filters and pagination are URL-driven so deep-links and
// crawlers can hit `/explore?sort=recent&page=2` and still get hydrated HTML.
//
// Privacy: `listCatalogBooks` filters by `isPublic=true && analysisStatus=completed`
// for the explore scope — anonymous and authenticated viewers see the same
// public catalog (auth only matters for the per-card `isInLibrary` flags).
export const metadata: Metadata = {
  title: "Каталог · ремарка.",
  description:
    "Курируемая библиотека книг с готовым AI-разбором. Откройте любую — и задайте вопрос автору и героям.",
  alternates: {
    canonical: "/explore",
  },
  openGraph: {
    title: "Открытая библиотека ремарка.",
    description:
      "Курируемая коллекция книг с готовым разбором и чатом. Откройте любую — и задайте вопрос.",
    url: "/explore",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Открытая библиотека ремарка.",
    description: "Книги с AI-разбором и чатом по тексту.",
  },
};

interface ExplorePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function parsePageParam(value: string | null): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

export default async function ExplorePage({ searchParams }: ExplorePageProps) {
  const sp = await searchParams;
  const sort = parseCatalogSort(firstString(sp.sort));
  const q = String(firstString(sp.q) || "").trim();
  const page = parsePageParam(firstString(sp.page));

  const authUser = await resolveAuthUser();
  const result = await listCatalogBooks({
    scope: "explore",
    viewer: authUser ? { id: authUser.id } : null,
    q,
    sort,
    page,
    pageSize: DEFAULT_CATALOG_PAGE_SIZE,
  });

  return (
    <Explore
      isAuthenticated={Boolean(authUser)}
      initialData={{
        items: result.items,
        total: result.total,
        page: result.page,
        sort,
        q,
      }}
    />
  );
}
