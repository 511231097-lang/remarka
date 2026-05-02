import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookOverview } from "@/components/BookOverview";
import { resolveAuthUser } from "@/lib/authUser";
import { displayAuthor } from "@/lib/books";
import { fetchBookForViewer, fetchBookShowcase } from "@/lib/server/bookView";

// Public overview page. Anonymous users can read the page when the book is
// `isPublic=true && analysisStatus=completed`. Owner can additionally see
// their own private books (rendered with `noindex` — see generateMetadata).
//
// Privacy-critical contract:
// - For viewers without access we call `notFound()` → Next.js renders the
//   404 page. We deliberately DO NOT redirect to `/signin`: a redirect leaks
//   that "this URL exists, you just need to log in", which lets anonymous
//   probes enumerate private book ids. 404 keeps private books invisible.
// - `/book/[bookId]/chat/*` lives under `app/(protected)/...` and is
//   independently gated by its own layout — this page only renders the
//   read-only overview.

interface BookPageProps {
  params: Promise<{ bookId: string }>;
}

const SUMMARY_OG_LIMIT = 200;

function clampForMeta(value: string | null | undefined, limit = SUMMARY_OG_LIMIT): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export async function generateMetadata({ params }: BookPageProps): Promise<Metadata> {
  const { bookId } = await params;
  const authUser = await resolveAuthUser();
  const result = await fetchBookForViewer({
    bookId,
    viewer: authUser ? { id: authUser.id } : null,
  });

  // Hidden book → hand back a generic title with `noindex`. We don't call
  // `notFound()` here so the page-level handler decides 404 rendering — but
  // we also don't leak the book title or summary into HEAD.
  if (!result) {
    return {
      title: "Книга не найдена · ремарка.",
      robots: { index: false, follow: false },
    };
  }

  const author = displayAuthor(result.book.author);
  const title = `${result.book.title} — ${author} · ремарка.`;
  const description = clampForMeta(result.book.summary) ||
    `Краткий AI-разбор книги «${result.book.title}» — ${author}. Читайте обзор и общайтесь с книгой в чате.`;
  const canonical = `/book/${result.book.id}`;
  const coverUrl = result.book.coverUrl || undefined;

  // Owner's private book → render but tell crawlers to skip indexing. Public
  // catalog books stay indexable (the SEO target).
  const robots = result.isPublic
    ? undefined
    : { index: false, follow: false };

  return {
    title,
    description,
    alternates: { canonical },
    robots,
    openGraph: {
      title,
      description,
      url: canonical,
      type: "book",
      images: coverUrl ? [{ url: coverUrl }] : undefined,
    },
    twitter: {
      card: coverUrl ? "summary_large_image" : "summary",
      title,
      description,
      images: coverUrl ? [coverUrl] : undefined,
    },
  };
}

export default async function BookOverviewPage({ params }: BookPageProps) {
  const { bookId } = await params;
  const authUser = await resolveAuthUser();
  const result = await fetchBookForViewer({
    bookId,
    viewer: authUser ? { id: authUser.id } : null,
  });

  if (!result) {
    notFound();
  }

  // Showcase is best-effort: if the artifact doesn't exist (analysis still
  // in progress, showcase pipeline disabled, etc.) the component renders
  // its built-in «витрина собирается» placeholder.
  const showcase = await fetchBookShowcase(bookId);

  return <BookOverview initialBook={result.book} initialShowcase={showcase} />;
}
