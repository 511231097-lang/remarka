import { LocalBlobStore, S3BlobStore, prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toBookCoreDTO } from "@/lib/books";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveLocalBlobRoots(): string[] {
  const importRoot = String(process.env.IMPORT_BLOB_DIR || "/tmp/remarka-imports").trim() || "/tmp/remarka-imports";
  const booksRoot = String(process.env.BOOKS_LOCAL_DIR || `${importRoot}/books`).trim() || `${importRoot}/books`;
  return Array.from(new Set([booksRoot, importRoot]));
}

async function deleteBookBlob(params: { storageProvider: string; storageKey: string }): Promise<void> {
  const storageProvider = String(params.storageProvider || "").trim().toLowerCase();
  const storageKey = String(params.storageKey || "").trim();
  if (!storageKey) return;

  if (storageProvider === "s3") {
    const bucket = String(process.env.BOOKS_S3_BUCKET || "").trim();
    if (!bucket) return;

    const store = new S3BlobStore({
      bucket,
      region: String(process.env.BOOKS_S3_REGION || "us-east-1").trim() || "us-east-1",
      endpoint: String(process.env.BOOKS_S3_ENDPOINT || "").trim() || undefined,
      keyPrefix: String(process.env.BOOKS_S3_KEY_PREFIX || "remarka/books").trim() || "remarka/books",
      forcePathStyle: parseBooleanEnv(process.env.BOOKS_S3_FORCE_PATH_STYLE, true),
      credentials:
        String(process.env.BOOKS_S3_ACCESS_KEY_ID || "").trim() && String(process.env.BOOKS_S3_SECRET_ACCESS_KEY || "").trim()
          ? {
              accessKeyId: String(process.env.BOOKS_S3_ACCESS_KEY_ID || "").trim(),
              secretAccessKey: String(process.env.BOOKS_S3_SECRET_ACCESS_KEY || "").trim(),
              sessionToken: String(process.env.BOOKS_S3_SESSION_TOKEN || "").trim() || undefined,
            }
          : undefined,
      provider: "s3",
    });

    await store.delete(storageKey);
    return;
  }

  let lastError: unknown = null;
  for (const rootDir of resolveLocalBlobRoots()) {
    try {
      const store = new LocalBlobStore({
        rootDir,
        provider: "local",
      });
      await store.delete(storageKey);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    return;
  }
}

async function resolveBook(context: RouteContext) {
  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    return { bookId, error: NextResponse.json({ error: "bookId is required" }, { status: 400 }) };
  }

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
      analyzerTasks: {
        where: {
          analyzerType: "literary",
        },
        select: {
          state: true,
        },
        take: 1,
      },
    },
  });

  if (!book) {
    return { bookId, error: NextResponse.json({ error: "Book not found" }, { status: 404 }) };
  }

  return { bookId, book };
}

export async function GET(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolved = await resolveBook(context);
  if (resolved.error) return resolved.error;
  const { book } = resolved;

  if (!book.isPublic && book.ownerUserId !== authUser.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  const dto = toBookCoreDTO(book);
  dto.analysisState = book.analyzerTasks[0]?.state || dto.analysisState;
  dto.canManage = book.ownerUserId === authUser.id;
  return NextResponse.json(dto);
}

export async function PATCH(request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolved = await resolveBook(context);
  if (resolved.error) return resolved.error;
  const { book, bookId } = resolved;

  if (book.ownerUserId !== authUser.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const isPublic = (payload as { isPublic?: unknown })?.isPublic;
  if (typeof isPublic !== "boolean") {
    return NextResponse.json({ error: "isPublic must be a boolean" }, { status: 400 });
  }

  const updated = await prisma.book.update({
    where: { id: bookId },
    data: { isPublic },
    include: {
      owner: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      analyzerTasks: {
        where: {
          analyzerType: "literary",
        },
        select: {
          state: true,
        },
        take: 1,
      },
    },
  });

  const dto = toBookCoreDTO(updated);
  dto.analysisState = updated.analyzerTasks[0]?.state || dto.analysisState;
  dto.canManage = true;
  return NextResponse.json(dto);
}

export async function DELETE(_request: Request, context: RouteContext) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolved = await resolveBook(context);
  if (resolved.error) return resolved.error;
  const { book, bookId } = resolved;

  if (book.ownerUserId !== authUser.id) {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }

  await prisma.book.delete({
    where: { id: bookId },
  });

  try {
    await deleteBookBlob({
      storageProvider: book.storageProvider,
      storageKey: book.storageKey,
    });
  } catch {
    // Blob cleanup failures should not block successful book deletion.
  }

  return new NextResponse(null, { status: 204 });
}
