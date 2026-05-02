import { prisma } from "@remarka/db";
import type { Prisma } from "@prisma/client";
import { toBookCardDTO } from "@/lib/books";
import type { BookCardDTO } from "@/lib/books";

/**
 * Server-side catalog query. Single source of truth for «who sees what» in
 * the books listing — used by the SSR `/explore` page and `GET /api/books`
 * so the two cannot drift on privacy/visibility rules.
 *
 * Privacy contract:
 * - `scope=explore` → only `isPublic=true && analysisStatus=completed` books,
 *   regardless of viewer auth status.
 * - `scope=library` → owner's books + books they liked (must be authenticated;
 *   throws if `viewer` is null). Still requires `analysisStatus=completed` —
 *   in-progress analyses go through a separate flow.
 */

export interface CatalogViewer {
  id: string;
}

export type CatalogScope = "explore" | "library";
export type CatalogSort = "recent" | "popular";

export const DEFAULT_CATALOG_PAGE_SIZE = 10;
export const MAX_CATALOG_PAGE_SIZE = 50;

export interface ListBooksParams {
  scope: CatalogScope;
  viewer: CatalogViewer | null;
  q?: string | null;
  sort?: CatalogSort | null;
  page?: number | null;
  pageSize?: number | null;
}

export interface ListBooksResult {
  items: BookCardDTO[];
  page: number;
  pageSize: number;
  total: number;
}

export class LibraryRequiresAuthError extends Error {
  constructor() {
    super("Library scope requires authenticated viewer");
    this.name = "LibraryRequiresAuthError";
  }
}

function clampPage(value: number | null | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return 1;
  return Math.floor(value);
}

function clampPageSize(value: number | null | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return DEFAULT_CATALOG_PAGE_SIZE;
  return Math.min(Math.floor(value), MAX_CATALOG_PAGE_SIZE);
}

export function parseCatalogScope(value: string | null | undefined): CatalogScope {
  if (value === "library") return "library";
  if (value === "favorites") return "library";
  return "explore";
}

export function parseCatalogSort(value: string | null | undefined): CatalogSort {
  return value === "popular" ? "popular" : "recent";
}

export async function listCatalogBooks(params: ListBooksParams): Promise<ListBooksResult> {
  if (params.scope === "library" && !params.viewer) {
    throw new LibraryRequiresAuthError();
  }

  const page = clampPage(params.page ?? undefined);
  const pageSize = clampPageSize(params.pageSize ?? undefined);
  const skip = (page - 1) * pageSize;
  const sort = params.sort === "popular" ? "popular" : "recent";
  const q = String(params.q ?? "").trim();

  const andFilters: Prisma.BookWhereInput[] = [{ analysisStatus: "completed" }];
  if (params.scope === "library") {
    andFilters.push({
      OR: [
        { ownerUserId: params.viewer!.id },
        { likes: { some: { userId: params.viewer!.id } } },
      ],
    });
  } else {
    andFilters.push({ isPublic: true });
  }

  if (q) {
    andFilters.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { author: { contains: q, mode: "insensitive" } },
        { owner: { name: { contains: q, mode: "insensitive" } } },
        { owner: { email: { contains: q, mode: "insensitive" } } },
      ],
    });
  }

  const where: Prisma.BookWhereInput =
    andFilters.length > 1 ? { AND: andFilters } : andFilters[0] || {};

  const orderBy: Prisma.BookOrderByWithRelationInput[] =
    sort === "popular"
      ? [{ likes: { _count: "desc" } }, { createdAt: "desc" }]
      : [{ createdAt: "desc" }];

  const viewerUserId = params.viewer?.id || "__anonymous__";

  const [total, rows] = await prisma.$transaction([
    prisma.book.count({ where }),
    prisma.book.findMany({
      where,
      orderBy,
      skip,
      take: pageSize,
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        likes: {
          where: { userId: viewerUserId },
          select: { bookId: true },
        },
        _count: {
          select: { likes: true },
        },
      },
    }),
  ]);

  return {
    items: rows.map((row) => toBookCardDTO(row, params.viewer?.id || null)),
    page,
    pageSize,
    total,
  };
}
