import type { MetadataRoute } from "next";

/**
 * Public robots.txt. Strategy:
 * - Allow `/`, the catalog, and book overview pages — that's our SEO surface.
 * - Disallow API, auth flows, and personal/admin sections wholesale. Even if
 *   middleware would 401 a bot, telling crawlers not to bother saves crawl
 *   budget and avoids junk URLs in the index.
 * - Private books are gated at the per-page metadata level via `robots:
 *   { index: false }` from `generateMetadata` — we deliberately do NOT
 *   blacklist `/book/<id>` patterns here, because the public ones live on
 *   the same path prefix.
 */
function resolveBaseUrl(): string {
  const explicit = String(process.env.NEXTAUTH_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return "http://localhost:3000";
}

export default function robots(): MetadataRoute.Robots {
  const base = resolveBaseUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        disallow: [
          "/api/",
          "/signin",
          "/library",
          "/profile",
          "/admin",
          "/upload",
          "/settings",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
