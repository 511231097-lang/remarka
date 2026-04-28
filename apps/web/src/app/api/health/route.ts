import { NextResponse } from "next/server";

// Lightweight liveness probe.
//
// Intentionally does NOT check the database, S3, or Vertex API — we don't want
// transient external failures to take down the whole site, and the deploy
// pipeline shouldn't roll back over a hiccup in some upstream. systemd will
// restart the process on its own if Node itself crashes; this endpoint just
// confirms the process is up and the HTTP layer responds.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}
