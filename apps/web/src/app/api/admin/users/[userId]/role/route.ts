import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";

interface RouteContext {
  params: Promise<{ userId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const params = await context.params;
  const userId = String(params.userId || "").trim();
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  if (userId === auth.authUser.id) {
    return NextResponse.json({ error: "You cannot change your own role" }, { status: 409 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const nextRole = String(body.role || "")
    .trim()
    .toLowerCase();
  if (nextRole !== "user" && nextRole !== "admin") {
    return NextResponse.json({ error: "role must be one of: user, admin" }, { status: 400 });
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      name: true,
      email: true,
      image: true,
    },
  });

  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (target.role === "admin" && nextRole === "user") {
    const adminsCount = await prisma.user.count({
      where: {
        role: "admin",
      },
    });
    if (adminsCount <= 1) {
      return NextResponse.json({ error: "Cannot demote the last admin" }, { status: 409 });
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      role: nextRole,
    },
    select: {
      id: true,
      role: true,
      name: true,
      email: true,
      image: true,
    },
  });

  return NextResponse.json({
    user: updated,
  });
}
