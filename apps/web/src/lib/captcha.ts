// Серверная верификация captcha-токенов. Сейчас поддерживаем
// Cloudflare Turnstile (бесплатный, privacy-friendly, без обязательной
// галки для большинства пользователей). Захотим заменить на hCaptcha
// или Yandex SmartCaptcha — переключаем по env CAPTCHA_PROVIDER.
//
// Без env'ов — verifyCaptcha возвращает { ok: true } и пропускает запрос.
// Это режим dev/локалки, чтобы не нужно было заводить тестовые ключи. На
// проде значения CAPTCHA_PROVIDER + CAPTCHA_SECRET_KEY обязаны быть
// заданы — иначе форма открывается всем ботам.

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface CaptchaResult {
  ok: boolean;
  error?: string;
}

export function isCaptchaConfigured(): boolean {
  const provider = String(process.env.CAPTCHA_PROVIDER || "").trim().toLowerCase();
  if (!provider || provider === "none") return false;
  const secret = String(process.env.CAPTCHA_SECRET_KEY || "").trim();
  return Boolean(secret);
}

export function getCaptchaSiteKey(): string | null {
  // CAPTCHA_SITE_KEY не секрет — рендерится в браузер. Используется
  // только клиентским widget'ом.
  const key = String(process.env.NEXT_PUBLIC_CAPTCHA_SITE_KEY || "").trim();
  return key || null;
}

export function getCaptchaProvider(): "turnstile" | "none" {
  const provider = String(process.env.CAPTCHA_PROVIDER || "").trim().toLowerCase();
  if (provider === "turnstile") return "turnstile";
  return "none";
}

export async function verifyCaptcha(params: {
  token: string | null | undefined;
  remoteIp?: string | null;
}): Promise<CaptchaResult> {
  const provider = getCaptchaProvider();

  if (provider === "none") {
    // Local/dev mode: не требуем captcha. На проде CAPTCHA_PROVIDER должен
    // быть выставлен — иначе форма принимает всё что прилетит.
    return { ok: true };
  }

  const token = String(params.token || "").trim();
  if (!token) {
    return { ok: false, error: "captcha_token_missing" };
  }

  if (provider === "turnstile") {
    const secret = String(process.env.CAPTCHA_SECRET_KEY || "").trim();
    if (!secret) {
      return { ok: false, error: "captcha_not_configured" };
    }

    const body = new URLSearchParams();
    body.set("secret", secret);
    body.set("response", token);
    if (params.remoteIp) body.set("remoteip", params.remoteIp);

    try {
      const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: "POST",
        body,
        // Не оставляем висеть — captcha-провайдер должен ответить быстро.
        signal: AbortSignal.timeout(5_000),
      });
      const json = (await response.json().catch(() => null)) as {
        success?: boolean;
        ["error-codes"]?: string[];
      } | null;

      if (json?.success) {
        return { ok: true };
      }
      const codes = Array.isArray(json?.["error-codes"]) ? json!["error-codes"]!.join(",") : "unknown";
      return { ok: false, error: `turnstile_failed:${codes}` };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? `turnstile_network:${error.message}` : "turnstile_network",
      };
    }
  }

  return { ok: false, error: "captcha_provider_unknown" };
}
