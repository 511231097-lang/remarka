import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";

interface RouteContext {
  params: Promise<{ userId: string }>;
}

/**
 * PATCH /api/admin/users/[userId]/tier
 *
 * Manual subscription override — admin-only path used until ЮKassa
 * integration ships. Body: `{ tier: "free" | "plus" }`.
 *
 * Side-effects:
 * - Promoting `free → plus` sets `tierActivatedAt = now()` so the new
 *   billing period anchors on the upgrade moment.
 * - Demoting `plus → free` clears `tierActivatedAt` so a future re-upgrade
 *   gets a fresh anchor (and doesn't accidentally inherit a stale one).
 * - No-op when the requested tier matches the current tier.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const params = await context.params;
  const userId = String(params.userId || "").trim();
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const nextTier = String(body.tier || "")
    .trim()
    .toLowerCase();
  if (nextTier !== "free" && nextTier !== "plus") {
    return NextResponse.json(
      { error: "tier must be one of: free, plus" },
      { status: 400 },
    );
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      tier: true,
      tierActivatedAt: true,
    },
  });

  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (target.tier === nextTier) {
    return NextResponse.json({
      user: {
        id: target.id,
        tier: target.tier,
        tierActivatedAt: target.tierActivatedAt
          ? target.tierActivatedAt.toISOString()
          : null,
      },
      noop: true,
    });
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      tier: nextTier,
      // Reset the period anchor on every tier change. Promotion → now() so
      // the user's first Plus period starts immediately. Demotion → null so
      // the next promotion gets a clean anchor.
      tierActivatedAt: nextTier === "plus" ? new Date() : null,
    },
    select: {
      id: true,
      tier: true,
      tierActivatedAt: true,
    },
  });

  return NextResponse.json({
    user: {
      id: updated.id,
      tier: updated.tier,
      tierActivatedAt: updated.tierActivatedAt
        ? updated.tierActivatedAt.toISOString()
        : null,
    },
  });
}
