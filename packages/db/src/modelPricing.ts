const DEFAULT_USD_TO_EUR_RATE = 0.92;
const DEFAULT_EUR_TO_RUB_RATE = 107;
const DEFAULT_PRICING_VERSION = "book-pricing-v1";

export type CurrencyRates = {
  usdToEur: number;
  eurToRub: number;
};

export type TokenPricing = {
  chatInputPer1MUsd: number;
  chatOutputPer1MUsd: number;
  embeddingInputPer1MUsd: number;
};

type PartialTokenPricing = Partial<TokenPricing>;
type ModelPricingCatalog = Record<string, PartialTokenPricing>;

const DEFAULT_MODEL_PRICING_CATALOG: ModelPricingCatalog = {
  "gemini-3.1-flash-lite-preview": {
    chatInputPer1MUsd: 0.25,
    chatOutputPer1MUsd: 1.5,
  },
  "gemini-3.1-flash-lite": {
    chatInputPer1MUsd: 0.25,
    chatOutputPer1MUsd: 1.5,
  },
  "gemini-3.1-pro-preview": {
    chatInputPer1MUsd: 2,
    chatOutputPer1MUsd: 12,
  },
  "gemini-3.1-pro": {
    chatInputPer1MUsd: 2,
    chatOutputPer1MUsd: 12,
  },
  "gemini-2.5-flash": {
    chatInputPer1MUsd: 0.3,
    chatOutputPer1MUsd: 2.5,
  },
  "gemini-2.5-flash-lite": {
    chatInputPer1MUsd: 0.1,
    chatOutputPer1MUsd: 0.4,
  },
  "gemini-embedding-001": {
    embeddingInputPer1MUsd: 0.15,
  },
};

function parseEnvFloat(key: string): number | null {
  const parsed = Number.parseFloat(String(process.env[key] || "").trim());
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parsePositiveEnvFloat(primaryKey: string, fallbackKey: string, fallback: number): number {
  const primary = parseEnvFloat(primaryKey);
  if (primary !== null && primary > 0) return primary;

  const secondary = parseEnvFloat(fallbackKey);
  if (secondary !== null && secondary > 0) return secondary;

  return fallback;
}

function parseNonNegativeEnvFloat(primaryKey: string, fallback: number): number {
  const value = parseEnvFloat(primaryKey);
  if (value === null || value < 0) return fallback;
  return value;
}

function normalizeModelId(value: string): string {
  return String(value || "").trim().toLocaleLowerCase("en-US");
}

function sanitizeTokenPricing(input: PartialTokenPricing): PartialTokenPricing {
  const out: PartialTokenPricing = {};
  if (Number.isFinite(input.chatInputPer1MUsd) && Number(input.chatInputPer1MUsd) >= 0) {
    out.chatInputPer1MUsd = Number(input.chatInputPer1MUsd);
  }
  if (Number.isFinite(input.chatOutputPer1MUsd) && Number(input.chatOutputPer1MUsd) >= 0) {
    out.chatOutputPer1MUsd = Number(input.chatOutputPer1MUsd);
  }
  if (Number.isFinite(input.embeddingInputPer1MUsd) && Number(input.embeddingInputPer1MUsd) >= 0) {
    out.embeddingInputPer1MUsd = Number(input.embeddingInputPer1MUsd);
  }
  return out;
}

function readModelPricingOverrides(): ModelPricingCatalog {
  const raw = String(process.env.BOOK_COST_MODEL_PRICING_JSON || "").trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const out: ModelPricingCatalog = {};
    for (const [modelIdRaw, configRaw] of Object.entries(parsed)) {
      if (!configRaw || typeof configRaw !== "object" || Array.isArray(configRaw)) continue;
      const modelId = normalizeModelId(modelIdRaw);
      if (!modelId) continue;
      const sanitized = sanitizeTokenPricing(configRaw as PartialTokenPricing);
      if (!Object.keys(sanitized).length) continue;
      out[modelId] = sanitized;
    }
    return out;
  } catch {
    return {};
  }
}

function buildPricingCatalog(): ModelPricingCatalog {
  const defaults = Object.fromEntries(
    Object.entries(DEFAULT_MODEL_PRICING_CATALOG).map(([model, config]) => [normalizeModelId(model), sanitizeTokenPricing(config)])
  );

  const overrides = readModelPricingOverrides();
  if (!Object.keys(overrides).length) {
    return defaults;
  }

  const merged: ModelPricingCatalog = { ...defaults };
  for (const [modelId, config] of Object.entries(overrides)) {
    merged[modelId] = {
      ...merged[modelId],
      ...config,
    };
  }

  return merged;
}

function pickModelPricing(modelId: string, catalog: ModelPricingCatalog): PartialTokenPricing {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return {};

  const exact = catalog[normalized];
  if (exact) return exact;

  const wildcard = Object.entries(catalog).find(([candidate]) => candidate.endsWith("*") && normalized.startsWith(candidate.slice(0, -1)));
  if (wildcard) return wildcard[1];

  return {};
}

export function resolvePricingVersion(): string {
  return String(process.env.BOOK_PRICING_VERSION || DEFAULT_PRICING_VERSION).trim() || DEFAULT_PRICING_VERSION;
}

export function readCurrencyRates(): CurrencyRates {
  return {
    usdToEur: parsePositiveEnvFloat("BOOK_COST_USD_TO_EUR_RATE", "BOOK_CHAT_USD_TO_EUR_RATE", DEFAULT_USD_TO_EUR_RATE),
    eurToRub: parsePositiveEnvFloat("BOOK_COST_EUR_TO_RUB_RATE", "BOOK_CHAT_EUR_TO_RUB_RATE", DEFAULT_EUR_TO_RUB_RATE),
  };
}

export function resolveTokenPricing(params: { chatModel: string; embeddingModel: string }): TokenPricing {
  const catalog = buildPricingCatalog();
  const chatConfig = pickModelPricing(params.chatModel, catalog);
  const embeddingConfig = pickModelPricing(params.embeddingModel, catalog);

  const fallbackChatInput = parseNonNegativeEnvFloat("BOOK_CHAT_INPUT_TOKEN_PRICE_PER_1M_USD", 0);
  const fallbackChatOutput = parseNonNegativeEnvFloat("BOOK_CHAT_OUTPUT_TOKEN_PRICE_PER_1M_USD", 0);
  const fallbackEmbeddingInput = parseNonNegativeEnvFloat("BOOK_CHAT_EMBEDDING_INPUT_TOKEN_PRICE_PER_1M_USD", 0);

  return {
    chatInputPer1MUsd:
      Number.isFinite(chatConfig.chatInputPer1MUsd) && Number(chatConfig.chatInputPer1MUsd) >= 0
        ? Number(chatConfig.chatInputPer1MUsd)
        : fallbackChatInput,
    chatOutputPer1MUsd:
      Number.isFinite(chatConfig.chatOutputPer1MUsd) && Number(chatConfig.chatOutputPer1MUsd) >= 0
        ? Number(chatConfig.chatOutputPer1MUsd)
        : fallbackChatOutput,
    embeddingInputPer1MUsd:
      Number.isFinite(embeddingConfig.embeddingInputPer1MUsd) && Number(embeddingConfig.embeddingInputPer1MUsd) >= 0
        ? Number(embeddingConfig.embeddingInputPer1MUsd)
        : fallbackEmbeddingInput,
  };
}

export function convertUsd(usd: number, rates: CurrencyRates): { eur: number; rub: number } {
  const safeUsd = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  const eur = safeUsd * rates.usdToEur;
  const rub = eur * rates.eurToRub;
  return {
    eur,
    rub,
  };
}
