import { prisma } from "@remarka/db";
import {
  toBookCoreDTO,
  toBookShowcaseDTO,
  type BookCoreDTO,
  type BookShowcaseDTO,
} from "@/lib/books";

/**
 * Server-side book detail visibility resolution. Single source of truth for
 * «can this viewer see this book at the overview level» — used by the SSR
 * `/book/[bookId]` page (including `generateMetadata`) and the
 * `GET /api/books/[bookId]` route handler.
 *
 * Privacy matrix (returns `null` ⇒ caller should respond 404, NOT redirect to
 * /signin — redirects leak existence of private books to anonymous probes):
 *
 *   | viewer            | public+completed | other's private | own private |
 *   |-------------------|------------------|-----------------|-------------|
 *   | anonymous         | visible          | null            | null        |
 *   | non-owner authed  | visible          | null            | null        |
 *   | owner             | visible          | null            | visible     |
 *
 * `analysisStatus !== "completed"` always returns null at this layer — the
 * overview page is for completed books only. In-progress analyses use
 * separate UX flows under `/book/[id]/analysis`.
 */

export interface BookViewer {
  id: string;
}

export interface BookViewResult {
  book: BookCoreDTO;
  isOwner: boolean;
  /** true ⇒ book itself is `isPublic=true`; controls whether the page is indexable. */
  isPublic: boolean;
}

/**
 * Lean visibility check for routes that only need the ownership/public flags
 * (e.g. showcase, chapters, chapter content) without loading the full Book
 * record. Returns true iff the viewer is allowed to read derived overview
 * data for this book. Mirrors the privacy contract of `fetchBookForViewer`
 * minus the `analysisStatus=completed` gate, which only the overview page
 * itself should enforce.
 */
export function isBookVisibleToViewer(
  book: { isPublic: boolean; ownerUserId: string },
  viewer: BookViewer | null,
): boolean {
  if (book.isPublic) return true;
  return Boolean(viewer && book.ownerUserId === viewer.id);
}

export async function fetchBookForViewer(params: {
  bookId: string;
  viewer: BookViewer | null;
}): Promise<BookViewResult | null> {
  const bookId = String(params.bookId || "").trim();
  if (!bookId) return null;

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    include: {
      owner: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      _count: {
        select: { likes: true },
      },
    },
  });

  if (!book) return null;

  const viewer = params.viewer;
  if (!isBookVisibleToViewer(book, viewer)) return null;
  if (book.analysisStatus !== "completed") return null;
  const isOwner = Boolean(viewer && book.ownerUserId === viewer.id);

  const existingLike = viewer
    ? await prisma.bookLike.findUnique({
        where: {
          bookId_userId: {
            bookId: book.id,
            userId: viewer.id,
          },
        },
        select: { bookId: true },
      })
    : null;
  const hasLibraryEntry = Boolean(existingLike);

  const dto = toBookCoreDTO(book);
  dto.canManage = isOwner;
  dto.isInLibrary = isOwner || hasLibraryEntry;
  dto.canAddToLibrary = Boolean(viewer) && !isOwner && book.isPublic && !hasLibraryEntry;
  dto.canRemoveFromLibrary = Boolean(viewer) && !isOwner && hasLibraryEntry;
  dto.libraryUsersCount = book._count.likes;

  return {
    book: dto,
    isOwner,
    isPublic: book.isPublic,
  };
}

/**
 * Loads the showcase artifact (themes/characters/events/quotes) for the
 * given book. Caller is responsible for visibility — only call this after
 * `fetchBookForViewer` has returned a non-null result.
 */
export async function fetchBookShowcase(bookId: string): Promise<BookShowcaseDTO | null> {
  const trimmed = String(bookId || "").trim();
  if (!trimmed) return null;
  const artifact = await prisma.bookSummaryArtifact.findUnique({
    where: {
      bookId_kind_key: {
        bookId: trimmed,
        kind: "book_brief",
        key: "showcase_v2",
      },
    },
    select: {
      bookId: true,
      summary: true,
      metadataJson: true,
      updatedAt: true,
    },
  });
  if (!artifact) return null;
  return toBookShowcaseDTO(artifact);
}
