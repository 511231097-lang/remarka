import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { getBucketUsage } from "@/lib/bucketUsage";

/**
 * GET /api/me/usage
 *
 * Returns the authenticated user's subscription tier, current billing
 * period window, per-bucket usage, and static tier-level limits (library
 * slot count, upload max size).
 *
 * Powers UI counters (analysis X/N, pro X/N, lite X/N) and is the source
 * of truth that gate-handlers consult before allowing chat / upload /
 * library-save operations.
 *
 * Response shape mirrors `UsageSnapshot` from `@/lib/bucketUsage`.
 */
export async function GET() {
  const user = await resolveAuthUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const usage = await getBucketUsage({
    id: user.id,
    tier: user.tier,
    createdAt: user.createdAt,
    tierActivatedAt: user.tierActivatedAt,
  });

  return NextResponse.json(usage);
}
