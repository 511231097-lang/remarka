/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 *
 * We use it to start the Postgres LISTEN bridge so the web process can
 * receive cross-process events (NOTIFY from worker).
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Skip during build phase — DATABASE_URL may be set to a placeholder.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // eslint-disable-next-line no-console
    console.warn("[instrumentation] DATABASE_URL not set; LISTEN bridge skipped");
    return;
  }

  const { listenBridge } = await import("./lib/events/listenBridge");
  await listenBridge.start(databaseUrl);
}
