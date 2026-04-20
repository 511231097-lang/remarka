import { NextResponse } from "next/server";
import { resolveAuthUser, type AuthUser } from "@/lib/authUser";

export type RequireAdminUserResult = { authUser: AuthUser } | { error: NextResponse };

export async function requireAdminUser(): Promise<RequireAdminUserResult> {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (authUser.role !== "admin") {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { authUser };
}
