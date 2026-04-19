import type { BookCardDTO } from "@/lib/books";

type CacheEntry = {
  coverUrl: string | null;
  expiresAt: number;
  touchedAt: number;
};

type GoogleBooksVolumeItem = {
  volumeInfo?: {
    title?: string;
    authors?: string[];
    imageLinks?: {
      smallThumbnail?: string;
      thumbnail?: string;
      small?: string;
      medium?: string;
      large?: string;
      extraLarge?: string;
    };
  };
};

type GoogleBooksSearchResponse = {
  items?: GoogleBooksVolumeItem[];
};

type OpenLibraryDoc = {
  title?: string;
  author_name?: string[];
  cover_i?: number;
};

type OpenLibrarySearchResponse = {
  docs?: OpenLibraryDoc[];
};

type CoverFetchOutcome = {
  coverUrl: string | null;
  cacheable: boolean;
};

type ScoredCoverCandidate = {
  image: string;
  titleScore: number;
  authorScore: number;
  strongTokenMatches: number;
  strongTokenTotal: number;
  finalScore: number;
};

const COVER_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 600;
const SEARCH_TIMEOUT_MS = 3500;
const OPEN_LIBRARY_TIMEOUT_MS = 3200;
const SEARCH_CONCURRENCY = 4;
const TRANSIENT_RETRY_ATTEMPTS = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 220;
const GOOGLE_MAX_RESULTS = 20;
const OPEN_LIBRARY_LIMIT = 20;
const TITLE_MATCH_MIN_SCORE = 0.54;
const AUTHOR_MATCH_MIN_SCORE = 0.24;
const TOKEN_FUZZY_MIN_SIMILARITY = 0.74;
const STRONG_TOKEN_MIN_LENGTH = 5;
const STRONG_TOKEN_FUZZY_MIN_SIMILARITY = 0.81;
const TITLE_STOP_TOKENS = new Set([
  "и",
  "the",
  "and",
  "a",
  "an",
  "гарри",
  "harry",
  "поттер",
  "potter",
  "книга",
  "book",
  "часть",
  "том",
  "volume",
]);
const CYRILLIC_RE = /[а-яё]/i;
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

function normalizeText(value: string | null | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function makeCacheKey(params: { title: string; author: string | null }): string {
  return `${normalizeText(params.title)}::${normalizeText(params.author)}`;
}

function resolveGoogleBooksApiKey(): string {
  const fromBooks = String(process.env.GOOGLE_BOOKS_API_KEY || "").trim();
  if (fromBooks) return fromBooks;

  const generic = String(process.env.GOOGLE_API_KEY || "").trim();
  if (generic) return generic;

  return "";
}

function normalizeCoverUrl(value: string): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.replace(/^http:\/\//i, "https://");
}

function normalizeForMatch(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForMatch(value: string): string[] {
  return normalizeForMatch(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function transliterateCyrillic(value: string): string {
  const normalized = normalizeForMatch(value);
  if (!normalized || !CYRILLIC_RE.test(normalized)) return normalized;

  let out = "";
  for (const ch of normalized) {
    out += CYRILLIC_TO_LATIN[ch] ?? ch;
  }

  return out.replace(/\s+/g, " ").trim();
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array(b.length + 1).fill(0);
  const curr = new Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }

  return prev[b.length];
}

function tokenSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;

  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLen;
}

function directionalFuzzyOverlap(source: string[], target: string[]): number {
  if (!source.length || !target.length) return 0;

  let score = 0;
  for (const srcToken of source) {
    let best = 0;
    for (const targetToken of target) {
      const similarity = tokenSimilarity(srcToken, targetToken);
      if (similarity > best) best = similarity;
    }
    if (best >= TOKEN_FUZZY_MIN_SIMILARITY) score += best;
  }

  return score / Math.max(source.length, target.length);
}

function tokenOverlapScore(a: string, b: string): number {
  const tokensA = tokenizeForMatch(a);
  const tokensB = tokenizeForMatch(b);
  if (!tokensA.length || !tokensB.length) return 0;

  const exactA = new Set(tokensA);
  const exactB = new Set(tokensB);
  let exact = 0;
  for (const token of exactA) {
    if (exactB.has(token)) exact += 1;
  }
  const exactScore = exact / Math.max(exactA.size, exactB.size);
  const fuzzyScore =
    (directionalFuzzyOverlap(tokensA, tokensB) + directionalFuzzyOverlap(tokensB, tokensA)) / 2;

  return Math.max(exactScore, fuzzyScore);
}

function resolveStrongTitleTokens(values: string[]): string[] {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of tokenizeForMatch(value)) {
      if (token.length >= STRONG_TOKEN_MIN_LENGTH && !TITLE_STOP_TOKENS.has(token)) {
        tokens.add(token);
      }
    }
  }
  return [...tokens];
}

function countStrongTokenMatches(requestedTitles: string[], candidateTitle: string): number {
  const strongTokens = resolveStrongTitleTokens(requestedTitles);
  if (!strongTokens.length) return 0;

  const candidateTokens = tokenizeForMatch(candidateTitle);
  if (!candidateTokens.length) return 0;

  let matches = 0;
  for (const reqToken of strongTokens) {
    let best = 0;
    for (const candToken of candidateTokens) {
      const similarity = tokenSimilarity(reqToken, candToken);
      if (similarity > best) best = similarity;
    }
    if (best >= STRONG_TOKEN_FUZZY_MIN_SIMILARITY) matches += 1;
  }

  return matches;
}

function titleMatchScore(requestedTitle: string, candidateTitle: string): number {
  const req = normalizeForMatch(requestedTitle);
  const cand = normalizeForMatch(candidateTitle);
  if (!req || !cand) return 0;
  if (req === cand) return 1;
  if (cand.includes(req) || req.includes(cand)) return 0.9;
  return tokenOverlapScore(req, cand);
}

function authorMatchScore(requestedAuthorForms: string[], candidateAuthors: string[]): number {
  const requested = requestedAuthorForms
    .map((value) => normalizeForMatch(value))
    .filter(Boolean);
  if (!requested.length) return 0.5;
  if (!candidateAuthors.length) return 0;

  let best = 0;
  for (const candidate of candidateAuthors) {
    for (const req of requested) {
      const score = tokenOverlapScore(req, candidate);
      if (score > best) best = score;
    }
  }
  return best;
}

function buildRequestedForms(value: string | null | undefined): string[] {
  const raw = String(value || "").trim();
  if (!raw) return [];

  const out = new Set<string>();
  out.add(raw);

  const normalized = normalizeForMatch(raw);
  if (normalized) out.add(normalized);

  const transliterated = transliterateCyrillic(raw);
  if (transliterated && transliterated !== normalized) out.add(transliterated);

  return [...out];
}

function buildGoogleQueryVariants(titleForms: string[], authorForms: string[]): string[] {
  const out = new Set<string>();
  for (const title of titleForms) {
    const t = String(title || "").trim();
    if (!t) continue;

    if (authorForms.length) {
      for (const author of authorForms) {
        const a = String(author || "").trim();
        if (!a) continue;
        out.add(`intitle:${t} inauthor:${a}`);
        out.add(`${t} ${a}`);
      }
    }

    out.add(`intitle:${t}`);
    out.add(t);
  }

  return [...out];
}

function buildOpenLibraryQueryVariants(titleForms: string[], authorForms: string[]): string[] {
  const out = new Set<string>();
  for (const title of titleForms) {
    const t = String(title || "").trim();
    if (!t) continue;

    if (authorForms.length) {
      for (const author of authorForms) {
        const a = String(author || "").trim();
        if (!a) continue;
        out.add(`${t} ${a}`);
      }
    }

    out.add(t);
  }

  return [...out];
}

function pickGoogleImageUrl(item: GoogleBooksVolumeItem): string | null {
  const links = item.volumeInfo?.imageLinks;
  if (!links) return null;

  const ordered = [
    links.extraLarge,
    links.large,
    links.medium,
    links.small,
    links.thumbnail,
    links.smallThumbnail,
  ];

  for (const candidate of ordered) {
    const normalized = normalizeCoverUrl(String(candidate || ""));
    if (normalized) return normalized;
  }

  return null;
}

function pickOpenLibraryImageUrl(doc: OpenLibraryDoc): string | null {
  const id = Number(doc.cover_i);
  if (!Number.isFinite(id) || id <= 0) return null;
  return `https://covers.openlibrary.org/b/id/${Math.floor(id)}-L.jpg`;
}

function scoreCandidate(params: {
  image: string | null;
  candidateTitle: string;
  candidateAuthors: string[];
  requestedTitleForms: string[];
  requestedAuthorForms: string[];
}): ScoredCoverCandidate | null {
  if (!params.image) return null;

  const strongTokens = resolveStrongTitleTokens(params.requestedTitleForms);
  const titleScore = Math.max(
    ...params.requestedTitleForms.map((requestedTitle) =>
      titleMatchScore(requestedTitle, params.candidateTitle)
    ),
    0
  );
  const authorScore = authorMatchScore(params.requestedAuthorForms, params.candidateAuthors);
  const strongTokenMatches = countStrongTokenMatches(params.requestedTitleForms, params.candidateTitle);
  const strongTokenTotal = strongTokens.length;
  const finalScore =
    titleScore * 0.78 + authorScore * 0.22 + Math.min(0.16, strongTokenMatches * 0.08);

  return {
    image: params.image,
    titleScore,
    authorScore,
    strongTokenMatches,
    strongTokenTotal,
    finalScore,
  };
}

function isCandidateAcceptable(candidate: ScoredCoverCandidate): boolean {
  if (candidate.strongTokenTotal >= 1 && candidate.strongTokenMatches === 0) {
    return false;
  }

  if (candidate.strongTokenTotal >= 2 && candidate.strongTokenMatches < 2 && candidate.titleScore < 0.72) {
    return false;
  }

  if (candidate.titleScore >= TITLE_MATCH_MIN_SCORE && candidate.authorScore >= AUTHOR_MATCH_MIN_SCORE) {
    return true;
  }

  if (
    candidate.strongTokenMatches >= 2 &&
    candidate.authorScore >= AUTHOR_MATCH_MIN_SCORE * 0.85 &&
    candidate.finalScore >= 0.45
  ) {
    return true;
  }

  return false;
}

function pickBestCandidate(candidates: Array<ScoredCoverCandidate | null>): ScoredCoverCandidate | null {
  const filtered = candidates
    .filter((candidate): candidate is ScoredCoverCandidate => Boolean(candidate))
    .sort((a, b) => b.finalScore - a.finalScore);

  if (!filtered.length) return null;
  const best = filtered[0];
  return isCandidateAcceptable(best) ? best : null;
}

function touchCacheEntry(entry: CacheEntry): CacheEntry {
  return {
    ...entry,
    touchedAt: Date.now(),
  };
}

function pruneCacheIfNeeded() {
  if (COVER_CACHE.size <= CACHE_MAX_ENTRIES) return;
  const entries = [...COVER_CACHE.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  const toDelete = entries.slice(0, Math.max(1, entries.length - CACHE_MAX_ENTRIES));
  for (const [key] of toDelete) {
    COVER_CACHE.delete(key);
  }
}

async function fetchGoogleBooksCover(params: {
  apiKey: string;
  query: string;
  requestedTitleForms: string[];
  requestedAuthorForms: string[];
}): Promise<CoverFetchOutcome> {
  const query = String(params.query || "").trim();
  if (!query || !params.apiKey) {
    return {
      coverUrl: null,
      cacheable: true,
    };
  }

  const searchParams = new URLSearchParams();
  searchParams.set("q", query);
  searchParams.set("maxResults", String(GOOGLE_MAX_RESULTS));
  searchParams.set("printType", "books");
  searchParams.set("projection", "lite");
  searchParams.set("key", params.apiKey);

  const endpoint = `https://www.googleapis.com/books/v1/volumes?${searchParams.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
      const response = await fetch(endpoint, {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
      });

      const isTransient = response.status === 429 || response.status >= 500;
      if (!response.ok) {
        if (isTransient && attempt < TRANSIENT_RETRY_ATTEMPTS) {
          const delayMs = TRANSIENT_RETRY_BASE_DELAY_MS * attempt;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        return {
          coverUrl: null,
          cacheable: !isTransient,
        };
      }

      const payload = (await response.json().catch(() => null)) as GoogleBooksSearchResponse | null;
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const scored = items.map((item) => {
        const volumeInfo = item.volumeInfo || {};
        const title = String(volumeInfo.title || "");
        const authors = Array.isArray(volumeInfo.authors)
          ? volumeInfo.authors.map((author) => String(author || "")).filter(Boolean)
          : [];
        const image = pickGoogleImageUrl(item);

        return scoreCandidate({
          image,
          candidateTitle: title,
          candidateAuthors: authors,
          requestedTitleForms: params.requestedTitleForms,
          requestedAuthorForms: params.requestedAuthorForms,
        });
      });

      const best = pickBestCandidate(scored);
      if (best?.image) {
        return {
          coverUrl: best.image,
          cacheable: true,
        };
      }

      return {
        coverUrl: null,
        cacheable: true,
      };
    }

    return {
      coverUrl: null,
      cacheable: false,
    };
  } catch {
    return {
      coverUrl: null,
      cacheable: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenLibraryCover(params: {
  query: string;
  requestedTitleForms: string[];
  requestedAuthorForms: string[];
}): Promise<CoverFetchOutcome> {
  const query = String(params.query || "").trim();
  if (!query) {
    return {
      coverUrl: null,
      cacheable: true,
    };
  }

  const searchParams = new URLSearchParams();
  searchParams.set("q", query);
  searchParams.set("limit", String(OPEN_LIBRARY_LIMIT));

  const endpoint = `https://openlibrary.org/search.json?${searchParams.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPEN_LIBRARY_TIMEOUT_MS);

  try {
    for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
      const response = await fetch(endpoint, {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
      });

      const isTransient = response.status === 429 || response.status >= 500;
      if (!response.ok) {
        if (isTransient && attempt < TRANSIENT_RETRY_ATTEMPTS) {
          const delayMs = TRANSIENT_RETRY_BASE_DELAY_MS * attempt;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        return {
          coverUrl: null,
          cacheable: !isTransient,
        };
      }

      const payload = (await response.json().catch(() => null)) as OpenLibrarySearchResponse | null;
      const docs = Array.isArray(payload?.docs) ? payload.docs : [];
      const scored = docs.map((doc) => {
        const title = String(doc.title || "");
        const authors = Array.isArray(doc.author_name)
          ? doc.author_name.map((author) => String(author || "")).filter(Boolean)
          : [];
        const image = pickOpenLibraryImageUrl(doc);

        return scoreCandidate({
          image,
          candidateTitle: title,
          candidateAuthors: authors,
          requestedTitleForms: params.requestedTitleForms,
          requestedAuthorForms: params.requestedAuthorForms,
        });
      });

      const best = pickBestCandidate(scored);
      if (best?.image) {
        return {
          coverUrl: best.image,
          cacheable: true,
        };
      }

      return {
        coverUrl: null,
        cacheable: true,
      };
    }

    return {
      coverUrl: null,
      cacheable: false,
    };
  } catch {
    return {
      coverUrl: null,
      cacheable: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCoverForBook(params: {
  apiKey: string;
  book: BookCardDTO;
}): Promise<CoverFetchOutcome> {
  const cacheKey = makeCacheKey({
    title: params.book.title,
    author: params.book.author || null,
  });
  if (!cacheKey) {
    return {
      coverUrl: null,
      cacheable: true,
    };
  }

  const now = Date.now();
  const cached = COVER_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    COVER_CACHE.set(cacheKey, touchCacheEntry(cached));
    return {
      coverUrl: cached.coverUrl,
      cacheable: true,
    };
  }

  const title = String(params.book.title || "").trim();
  const author = String(params.book.author || "").trim();
  const requestedTitleForms = buildRequestedForms(title);
  const requestedAuthorForms = buildRequestedForms(author || null);
  const googleQueries = buildGoogleQueryVariants(requestedTitleForms, requestedAuthorForms);
  const openLibraryQueries = buildOpenLibraryQueryVariants(requestedTitleForms, requestedAuthorForms);

  let hadTransientFailure = false;

  if (params.apiKey) {
    for (const query of googleQueries) {
      const outcome = await fetchGoogleBooksCover({
        apiKey: params.apiKey,
        query,
        requestedTitleForms,
        requestedAuthorForms,
      });

      if (!outcome.cacheable) {
        hadTransientFailure = true;
        continue;
      }

      if (outcome.coverUrl) {
        COVER_CACHE.set(cacheKey, {
          coverUrl: outcome.coverUrl,
          expiresAt: now + CACHE_TTL_MS,
          touchedAt: now,
        });
        pruneCacheIfNeeded();
        return {
          coverUrl: outcome.coverUrl,
          cacheable: true,
        };
      }
    }
  }

  for (const query of openLibraryQueries) {
    const outcome = await fetchOpenLibraryCover({
      query,
      requestedTitleForms,
      requestedAuthorForms,
    });

    if (!outcome.cacheable) {
      hadTransientFailure = true;
      continue;
    }

    if (outcome.coverUrl) {
      COVER_CACHE.set(cacheKey, {
        coverUrl: outcome.coverUrl,
        expiresAt: now + CACHE_TTL_MS,
        touchedAt: now,
      });
      pruneCacheIfNeeded();
      return {
        coverUrl: outcome.coverUrl,
        cacheable: true,
      };
    }
  }

  if (!hadTransientFailure) {
    COVER_CACHE.set(cacheKey, {
      coverUrl: null,
      expiresAt: now + CACHE_TTL_MS,
      touchedAt: now,
    });
    pruneCacheIfNeeded();
    return {
      coverUrl: null,
      cacheable: true,
    };
  }

  return {
    coverUrl: null,
    cacheable: false,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const out: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await mapper(items[index], index);
    }
  }

  const workers = new Array(Math.min(limit, items.length)).fill(null).map(() => worker());
  await Promise.all(workers);
  return out;
}

export async function enrichBookCardsWithGoogleCovers(items: BookCardDTO[]): Promise<BookCardDTO[]> {
  if (!Array.isArray(items) || items.length === 0) return Array.isArray(items) ? items : [];

  const apiKey = resolveGoogleBooksApiKey();
  const resolved = await mapWithConcurrency(items, SEARCH_CONCURRENCY, async (book) => {
    const outcome = await resolveCoverForBook({ apiKey, book });
    return {
      ...book,
      coverUrl: outcome.coverUrl,
    };
  });

  return resolved;
}
