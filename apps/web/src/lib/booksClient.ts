import type {
  BookAnalysisStatusDTO,
  BookAnalyzerStatusDTO as BookAnalyzerStatusDTOValue,
  BookAnalyzerStateDTO,
  BookChapterDTO,
  BookChatResponseDTO,
  BookChatCreateSessionResponseDTO,
  BookChatCreateSessionRequestDTO,
  BookChatMessageDTO,
  BookChatMessagesResponseDTO,
  BookChatSessionDTO,
  BookChatSessionResponseDTO,
  BookChatSessionsResponseDTO,
  BookChatStreamEventDTO,
  BookChatStreamFinalEventDTO,
  BookChatStreamRequestDTO,
  BookCoreDTO,
  BookLiteraryAnalysisDTO,
  BookLiterarySectionDTO,
  BookLikeStateDTO,
  BookQuoteDetailDTO,
  BookQuoteListItemDTO,
  LiterarySectionKeyDTO,
  BookQuoteMentionKindDTO,
  BookQuoteTagDTO,
  BookQuoteTypeDTO,
  BooksListResponseDTO,
  CharacterDetailDTO,
  CharacterListItemDTO,
  LocationDetailDTO,
  LocationListItemDTO,
  ThemeDetailDTO,
  ThemeListItemDTO,
} from "@/lib/books";

export interface ListBooksParams {
  scope: "explore" | "library" | "favorites";
  q?: string;
  sort?: "recent" | "popular";
  page?: number;
  pageSize?: number;
}

function ensureOk(response: Response, fallbackMessage: string): Promise<Response> {
  if (response.ok) return Promise.resolve(response);

  return response
    .json()
    .catch(() => ({}))
    .then((body) => {
      const message = String(body?.error || fallbackMessage);
      throw new Error(message);
    });
}

export async function listBooks(params: ListBooksParams): Promise<BooksListResponseDTO> {
  const searchParams = new URLSearchParams();
  searchParams.set("scope", params.scope);
  if (params.q) searchParams.set("q", params.q);
  if (params.sort) searchParams.set("sort", params.sort);
  if (params.page) searchParams.set("page", String(params.page));
  if (params.pageSize) searchParams.set("pageSize", String(params.pageSize));

  const response = await fetch(`/api/books?${searchParams.toString()}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить книги");
  return safe.json();
}

export async function getBook(bookId: string): Promise<BookCoreDTO> {
  const response = await fetch(`/api/books/${bookId}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить книгу");
  return safe.json();
}

export async function updateBookVisibility(bookId: string, isPublic: boolean): Promise<BookCoreDTO> {
  const response = await fetch(`/api/books/${bookId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ isPublic }),
  });

  const safe = await ensureOk(response, "Не удалось обновить настройки книги");
  return safe.json();
}

export async function deleteBook(bookId: string): Promise<void> {
  const response = await fetch(`/api/books/${bookId}`, {
    method: "DELETE",
  });

  await ensureOk(response, "Не удалось удалить книгу");
}

export async function likeBook(bookId: string): Promise<BookLikeStateDTO> {
  const response = await fetch(`/api/books/${bookId}/like`, {
    method: "POST",
  });

  const safe = await ensureOk(response, "Не удалось поставить лайк");
  return safe.json();
}

export async function unlikeBook(bookId: string): Promise<BookLikeStateDTO> {
  const response = await fetch(`/api/books/${bookId}/like`, {
    method: "DELETE",
  });

  const safe = await ensureOk(response, "Не удалось снять лайк");
  return safe.json();
}

export async function getBookChapters(bookId: string): Promise<BookChapterDTO[]> {
  const response = await fetch(`/api/books/${bookId}/chapters`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить главы");
  return safe.json();
}

export interface CreateBookInput {
  file: File;
  isPublic: boolean;
}

export type BookAnalyzerState = BookAnalyzerStateDTO;
export type BookAnalyzerStatusDTO = BookAnalyzerStatusDTOValue;

export type BookChatStreamEvent = BookChatStreamEventDTO;

export interface CharacterListResponseDTO {
  items: CharacterListItemDTO[];
  total: number;
}

export interface LocationListResponseDTO {
  items: LocationListItemDTO[];
  total: number;
}

export interface ThemeListResponseDTO {
  items: ThemeListItemDTO[];
  total: number;
}

export type BookQuotesSort = "chapter_asc" | "confidence_desc";
export type BookQuotesRetrieveSort = "relevance" | "chapter_asc" | "confidence_desc";

export interface ListBookQuotesParams {
  page?: number;
  pageSize?: number;
  chapter?: number;
  type?: BookQuoteTypeDTO;
  tag?: BookQuoteTagDTO;
  mentionKind?: BookQuoteMentionKindDTO;
  mentionValue?: string;
  confidenceGte?: number;
  q?: string;
  sort?: BookQuotesSort;
}

export interface BookQuotesListResponseDTO {
  items: BookQuoteListItemDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RetrieveBookQuotesInput {
  query?: string;
  filters?: {
    chapter?: number | number[];
    type?: BookQuoteTypeDTO | BookQuoteTypeDTO[];
    tags?: BookQuoteTagDTO[];
    mentionKind?: BookQuoteMentionKindDTO;
    mentionValue?: string;
    minConfidence?: number;
  };
  topK?: number;
  offset?: number;
  sort?: BookQuotesRetrieveSort;
}

export interface BookQuotesRetrieveResponseDTO {
  items: BookQuoteDetailDTO[];
  total: number;
  topK: number;
  offset: number;
}

export async function createBook(input: CreateBookInput): Promise<BookCoreDTO> {
  const formData = new FormData();
  formData.set("file", input.file);
  formData.set("isPublic", String(input.isPublic));

  const response = await fetch("/api/books", {
    method: "POST",
    body: formData,
  });

  const safe = await ensureOk(response, "Не удалось создать книгу");
  return safe.json();
}

export async function getBookAnalysisStatus(bookId: string): Promise<BookAnalysisStatusDTO> {
  const response = await fetch(`/api/books/${bookId}/analysis-status`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить статус анализа");
  return safe.json();
}

export async function getBookCharacters(bookId: string, limit?: number): Promise<CharacterListResponseDTO> {
  const search = new URLSearchParams();
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    search.set("limit", String(Math.floor(limit)));
  }

  const query = search.toString();
  const response = await fetch(`/api/books/${bookId}/characters${query ? `?${query}` : ""}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить персонажей");
  return safe.json();
}

export async function getBookCharacter(bookId: string, characterId: string): Promise<CharacterDetailDTO> {
  const response = await fetch(`/api/books/${bookId}/characters/${characterId}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить персонажа");
  return safe.json();
}

export async function getBookLocations(bookId: string, limit?: number): Promise<LocationListResponseDTO> {
  const search = new URLSearchParams();
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    search.set("limit", String(Math.floor(limit)));
  }

  const query = search.toString();
  const response = await fetch(`/api/books/${bookId}/locations${query ? `?${query}` : ""}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить локации");
  return safe.json();
}

export async function getBookLocation(bookId: string, locationId: string): Promise<LocationDetailDTO> {
  const response = await fetch(`/api/books/${bookId}/locations/${locationId}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить локацию");
  return safe.json();
}

export async function getBookThemes(bookId: string, limit?: number): Promise<ThemeListResponseDTO> {
  const search = new URLSearchParams();
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    search.set("limit", String(Math.floor(limit)));
  }

  const query = search.toString();
  const response = await fetch(`/api/books/${bookId}/themes${query ? `?${query}` : ""}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить темы");
  return safe.json();
}

export async function getBookTheme(bookId: string, themeId: string): Promise<ThemeDetailDTO> {
  const response = await fetch(`/api/books/${bookId}/themes/${themeId}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить тему");
  return safe.json();
}

export async function getBookQuotes(
  bookId: string,
  params?: ListBookQuotesParams
): Promise<BookQuotesListResponseDTO> {
  const search = new URLSearchParams();
  if (typeof params?.page === "number" && Number.isFinite(params.page) && params.page > 0) {
    search.set("page", String(Math.floor(params.page)));
  }
  if (typeof params?.pageSize === "number" && Number.isFinite(params.pageSize) && params.pageSize > 0) {
    search.set("pageSize", String(Math.floor(params.pageSize)));
  }
  if (typeof params?.chapter === "number" && Number.isFinite(params.chapter) && params.chapter > 0) {
    search.set("chapter", String(Math.floor(params.chapter)));
  }
  if (params?.type) search.set("type", params.type);
  if (params?.tag) search.set("tag", params.tag);
  if (params?.mentionKind) search.set("mentionKind", params.mentionKind);
  if (params?.mentionValue) search.set("mentionValue", params.mentionValue);
  if (
    typeof params?.confidenceGte === "number" &&
    Number.isFinite(params.confidenceGte) &&
    params.confidenceGte >= 0
  ) {
    search.set("confidenceGte", String(params.confidenceGte));
  }
  if (params?.q) search.set("q", params.q);
  if (params?.sort) search.set("sort", params.sort);

  const query = search.toString();
  const response = await fetch(`/api/books/${bookId}/quotes${query ? `?${query}` : ""}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить цитаты");
  return safe.json();
}

export async function getBookQuote(bookId: string, quoteId: string): Promise<BookQuoteDetailDTO> {
  const response = await fetch(`/api/books/${bookId}/quotes/${quoteId}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить цитату");
  return safe.json();
}

export async function retrieveBookQuotes(
  bookId: string,
  input: RetrieveBookQuotesInput
): Promise<BookQuotesRetrieveResponseDTO> {
  const response = await fetch(`/api/books/${bookId}/quotes/retrieve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input || {}),
  });

  const safe = await ensureOk(response, "Не удалось выполнить поиск цитат");
  return safe.json();
}

export async function getBookLiteraryAnalysis(bookId: string): Promise<BookLiteraryAnalysisDTO> {
  const response = await fetch(`/api/books/${bookId}/literary-analysis`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить литературный анализ");
  return safe.json();
}

export async function getBookLiterarySection(
  bookId: string,
  sectionKey: LiterarySectionKeyDTO
): Promise<BookLiterarySectionDTO> {
  const response = await fetch(`/api/books/${bookId}/literary-analysis/${sectionKey}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить раздел анализа");
  return safe.json();
}

export async function listBookChatSessions(bookId: string): Promise<BookChatSessionDTO[]> {
  const response = await fetch(`/api/books/${bookId}/chat/sessions`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить чаты");
  const payload = (await safe.json()) as BookChatSessionsResponseDTO;
  return Array.isArray(payload?.items) ? payload.items : [];
}

export async function createBookChatSession(
  bookId: string,
  input?: BookChatCreateSessionRequestDTO
): Promise<BookChatSessionDTO> {
  const response = await fetch(`/api/books/${bookId}/chat/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input || {}),
  });

  const safe = await ensureOk(response, "Не удалось создать чат");
  const payload = (await safe.json()) as BookChatCreateSessionResponseDTO;
  return payload.session;
}

export async function getBookChatSession(bookId: string, sessionId: string): Promise<BookChatSessionDTO> {
  const response = await fetch(`/api/books/${bookId}/chat/sessions/${sessionId}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить чат");
  const payload = (await safe.json()) as BookChatSessionResponseDTO;
  return payload.session;
}

export async function deleteBookChatSession(bookId: string, sessionId: string): Promise<void> {
  const response = await fetch(`/api/books/${bookId}/chat/sessions/${sessionId}`, {
    method: "DELETE",
  });
  await ensureOk(response, "Не удалось удалить чат");
}

export async function getBookChatMessages(bookId: string, sessionId: string): Promise<BookChatMessageDTO[]> {
  const response = await fetch(`/api/books/${bookId}/chat/sessions/${sessionId}/messages`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить сообщения чата");
  const payload = (await safe.json()) as BookChatMessagesResponseDTO;
  return Array.isArray(payload?.items) ? payload.items : [];
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split(/\r?\n/g);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const data = dataLines.join("\n").trim();
  if (!data) return null;
  return { event, data };
}

export async function streamBookChatMessage(params: {
  bookId: string;
  sessionId: string;
  input: BookChatStreamRequestDTO;
  onEvent?: (event: BookChatStreamEvent) => void;
}): Promise<BookChatStreamFinalEventDTO> {
  const response = await fetch(`/api/books/${params.bookId}/chat/sessions/${params.sessionId}/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(params.input || {}),
  });

  if (!response.ok) {
    const fallbackMessage = "Не удалось получить потоковый ответ чата";
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body?.error || fallbackMessage));
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Поток ответа недоступен");
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finalPayload: BookChatStreamFinalEventDTO | null = null;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    while (true) {
      const boundaryIndex = buffer.indexOf("\n\n");
      if (boundaryIndex < 0) break;
      const block = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      const parsed = parseSseBlock(block);
      if (!parsed) continue;

      let payload: any;
      try {
        payload = JSON.parse(parsed.data);
      } catch {
        continue;
      }

      if (parsed.event === "session") {
        params.onEvent?.({
          type: "session",
          sessionId: String(payload?.sessionId || ""),
        });
        continue;
      }

      if (parsed.event === "token") {
        params.onEvent?.({
          type: "token",
          text: String(payload?.text || ""),
        });
        continue;
      }

      if (parsed.event === "error") {
        const errorMessage = String(payload?.error || "Ошибка stream-ответа");
        params.onEvent?.({
          type: "error",
          error: errorMessage,
        });
        throw new Error(errorMessage);
      }

      if (parsed.event === "final") {
        finalPayload = payload as BookChatStreamFinalEventDTO;
        params.onEvent?.({
          type: "final",
          final: finalPayload,
          sessionId: String(finalPayload?.sessionId || ""),
        });
      }
    }
  }

  if (!finalPayload) {
    throw new Error("Чат завершился без финального события");
  }

  return finalPayload;
}

export async function sendBookChatMessage(
  bookId: string,
  input: {
    message: string;
    sessionId?: string;
    topK?: number;
    sectionKey?: LiterarySectionKeyDTO;
    entryContext?: "overview" | "section" | "full_chat";
  }
): Promise<BookChatResponseDTO> {
  const response = await fetch(`/api/books/${bookId}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input || {}),
  });

  const safe = await ensureOk(response, "Не удалось получить ответ чата");
  return safe.json();
}
