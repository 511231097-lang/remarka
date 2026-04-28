import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";

interface RouteContext {
  params: Promise<{ bookId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const params = await context.params;
  const bookId = String(params.bookId || "").trim();
  if (!bookId) {
    return NextResponse.json({ error: "bookId is required" }, { status: 400 });
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

  try {
    const updated = await prisma.book.update({
      where: { id: bookId },
      data: { isPublic },
      select: {
        id: true,
        isPublic: true,
      },
    });

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Book not found" }, { status: 404 });
  }
}
