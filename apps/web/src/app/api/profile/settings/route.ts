import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";

export async function GET() {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    { error: "Visibility settings are managed by admins only" },
    { status: 403 }
  );
}

export async function PATCH(request: Request) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  void request;
  return NextResponse.json(
    { error: "Visibility settings are managed by admins only" },
    { status: 403 }
  );
}
