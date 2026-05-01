// Простой in-memory rate-limiter для unauth endpoints (форма жалобы
// правообладателя, contact, и т.п.). Память single-process, при горизонтальном
// масштабировании на N инстансов лимит фактически становится N×configured.
// Для текущего трафика (1 web-инстанс на старте) этого достаточно. Когда будем
// масштабироваться — подменим backend на Redis с тем же интерфейсом.
//
// Алгоритм — фиксированное окно: bucket(key, windowStart=floor(now/windowMs))
// → count. Бакеты старее текущего окна вычищаются лениво при попадании на
// новый ключ.

interface Bucket {
  count: number;
  expiresAt: number;
}

const STORE = new Map<string, Bucket>();

function gc(now: number) {
  if (STORE.size < 1024) return;
  for (const [key, bucket] of STORE) {
    if (bucket.expiresAt <= now) {
      STORE.delete(key);
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function checkRateLimit(params: {
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
}): RateLimitResult {
  const now = Date.now();
  const windowStart = Math.floor(now / params.windowMs) * params.windowMs;
  const composite = `${params.bucket}:${params.key}:${windowStart}`;

  gc(now);

  const existing = STORE.get(composite);
  const expiresAt = windowStart + params.windowMs;

  const nextCount = (existing?.count || 0) + 1;
  STORE.set(composite, { count: nextCount, expiresAt });

  if (nextCount > params.limit) {
    const retryAfter = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
  }

  return {
    allowed: true,
    remaining: Math.max(0, params.limit - nextCount),
    retryAfterSeconds: 0,
  };
}

export function getClientIpFromRequest(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return null;
}
