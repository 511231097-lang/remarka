const DEV_AUTH_SECRET = "dev-insecure-secret";
const DEV_INTERNAL_WORKER_TOKEN = "remarka-internal-dev-token";

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

export const AUTH_SECRET = readSecretEnv("AUTH_SECRET", DEV_AUTH_SECRET);
export const INTERNAL_WORKER_TOKEN = readSecretEnv("INTERNAL_WORKER_TOKEN", DEV_INTERNAL_WORKER_TOKEN);
