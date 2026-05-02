const DEV_AUTH_SECRET = "dev-insecure-secret";

function isProductionRuntime(): boolean {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function readSecretEnv(name: string, devFallback: string): string {
  const value = String(process.env[name] || "").trim();
  if (value) return value;
  if (isProductionRuntime()) {
    throw new Error(`${name} is required in production`);
  }
  return devFallback;
}

/**
 * Optional in production. Used only by the legacy showcase-builder internal
 * API (worker → web handshake). The route stays guarded — when the token is
 * empty every inbound request gets 403, which is the right default while
 * SHOWCASE_BUILD_ENABLED=false.
 *
 * If the showcase pipeline gets revived, set INTERNAL_WORKER_TOKEN as a
 * GitHub secret; the deploy template already forwards it through. Worker
 * config reads with the same default (apps/worker/src/config.ts), so both
 * sides agree on emptiness when the secret is absent.
 */
function readOptionalEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

export const AUTH_SECRET = readSecretEnv("AUTH_SECRET", DEV_AUTH_SECRET);
export const INTERNAL_WORKER_TOKEN = readOptionalEnv("INTERNAL_WORKER_TOKEN");
