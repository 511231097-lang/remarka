import type { MetadataRoute } from "next";
import { prisma } from "@remarka/db";

/**
 * Public sitemap. Privacy-critical: only emits books that are
 * `isPublic=true && analysisStatus=completed`. Private books and
 * in-progress analyses are explicitly excluded — double layer of defense
 * on top of the per-page `noindex` metadata for owner-viewed private pages.
 *
 * Static landing entries are listed first; per-book entries follow.
 *
 * If catalog grows past Google's 50k-URL / 50 MiB sitemap limit we'll need
 * to switch to a sitemap index — see backlog "Техническое SEO".
 */

// Render at request time — DATABASE_URL is unavailable during the Docker
// build stage, so prerendering would fail. Crawler hits are rare enough
// that runtime DB query is fine; if traffic grows we can add a short
// `revalidate` window.
export const dynamic = "force-dynamic";

const STATIC_ROUTES: Array<{ path: string; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }> = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/explore", changeFrequency: "daily", priority: 0.9 },
  { path: "/plans", changeFrequency: "monthly", priority: 0.5 },
  { path: "/about", changeFrequency: "monthly", priority: 0.4 },
  { path: "/cookie-policy", changeFrequency: "yearly", priority: 0.2 },
];

function resolveBaseUrl(): string {
  const explicit = String(process.env.NEXTAUTH_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return "http://localhost:3000";
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = resolveBaseUrl();

  const publicBooks = await prisma.book.findMany({
    where: {
      isPublic: true,
      analysisStatus: "completed",
    },
    select: {
      id: true,
      updatedAt: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((route) => ({
    url: `${base}${route.path}`,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
    lastModified: new Date(),
  }));

  const bookEntries: MetadataRoute.Sitemap = publicBooks.map((book) => ({
    url: `${base}/book/${book.id}`,
    changeFrequency: "weekly",
    priority: 0.7,
    lastModified: book.updatedAt,
  }));

  return [...staticEntries, ...bookEntries];
}
