// Client helper для логирования юридически-значимых акцептов.
// Никогда не блокирует основной user flow — вызывается best-effort,
// ошибки только в консоль.

export type LegalConsentType =
  | "signin_acceptance"
  | "upload_acceptance"
  | "cookie_settings";

interface LogConsentParams {
  consentType: LegalConsentType;
  relatedResourceId?: string;
  cookieCategories?: { analytics: boolean; perso: boolean };
}

export async function logLegalConsent(params: LogConsentParams): Promise<void> {
  try {
    await fetch("/api/legal/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      // Не блокируем закрытие вкладки — это аудит-лог, не критично
      // если отправка чуть запоздает.
      keepalive: true,
    });
  } catch (err) {
    // Sentry бы зарелогировал тут ошибку, но пока nope — пишем в консоль.
    console.warn("Failed to log legal consent:", params.consentType, err);
  }
}
