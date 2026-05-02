import type {
  AnalyzingBookDTO,
  BookAnalysisStatusDTO,
  BookAnalyzerStatusDTO as BookAnalyzerStatusDTOValue,
  BookAnalyzerStateDTO,
  BookChapterContentDTO,
  BookChapterDTO,
  BookChatCreateSessionResponseDTO,
  BookChatCreateSessionRequestDTO,
  BookChatMessageDTO,
  BookChatMessagesResponseDTO,
  BookChatSessionDTO,
  BookChatSessionsResponseDTO,
  BookCoreDTO,
  BookLibraryStateDTO,
  BookShowcaseDTO,
  BooksListResponseDTO,
} from "@/lib/books";

export interface ListBooksParams {
  scope: "explore" | "library";
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

export async function getBookShowcase(bookId: string): Promise<BookShowcaseDTO | null> {
  const response = await fetch(`/api/books/${bookId}/showcase`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить витрину книги");
  const payload = (await safe.json()) as { item?: BookShowcaseDTO | null };
  return payload?.item || null;
}

export async function deleteBook(bookId: string): Promise<void> {
  const response = await fetch(`/api/books/${bookId}`, {
    method: "DELETE",
  });

  await ensureOk(response, "Не удалось удалить книгу");
}

export async function addBookToLibrary(bookId: string): Promise<BookLibraryStateDTO> {
  const response = await fetch(`/api/books/${bookId}/library`, {
    method: "POST",
  });

  const safe = await ensureOk(response, "Не удалось добавить книгу в библиотеку");
  return safe.json();
}

export async function removeBookFromLibrary(bookId: string): Promise<BookLibraryStateDTO> {
  const response = await fetch(`/api/books/${bookId}/library`, {
    method: "DELETE",
  });

  const safe = await ensureOk(response, "Не удалось убрать книгу из библиотеки");
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

export async function getBookChapterContent(
  bookId: string,
  orderIndex: number
): Promise<BookChapterContentDTO> {
  const response = await fetch(`/api/books/${bookId}/chapters/${orderIndex}`, {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить текст главы");
  return safe.json();
}

export interface CreateBookInput {
  file: File;
}

export type BookAnalyzerState = BookAnalyzerStateDTO;
export type BookAnalyzerStatusDTO = BookAnalyzerStatusDTOValue;

export async function createBook(input: CreateBookInput): Promise<BookCoreDTO> {
  const formData = new FormData();
  formData.set("file", input.file);

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

export async function listAnalyzingBooks(): Promise<AnalyzingBookDTO[]> {
  const response = await fetch("/api/library/analyzing", {
    method: "GET",
    cache: "no-store",
  });

  const safe = await ensureOk(response, "Не удалось загрузить книги в анализе");
  const payload = await safe.json();
  return Array.isArray(payload) ? (payload as AnalyzingBookDTO[]) : [];
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

/**
 * Send a chat message via the new event-channel POST endpoint.
 *
 * Returns immediately with the persisted user message (status 202). Tokens,
 * status, tool events, and the final assistant message arrive through the
 * persistent SSE channel — caller subscribes via useEventChannel().
 *
 * See `docs/research/sse-event-channel.md` §7.3.
 */
export async function sendBookChatMessage(params: {
  bookId: string;
  sessionId: string;
  message: string;
  signal?: AbortSignal;
}): Promise<{ userMessage: BookChatMessageDTO; sessionId: string }> {
  const response = await fetch(
    `/api/books/${params.bookId}/chat/sessions/${params.sessionId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: params.message }),
      signal: params.signal,
    }
  );

  if (response.status === 409) {
    const body = await response.json().catch(() => ({}));
    const err = new Error(String(body?.error || "Чат занят"));
    (err as Error & { code?: string }).code = String(body?.code || "ALREADY_RUNNING");
    throw err;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body?.error || "Не удалось отправить сообщение"));
  }

  const payload = (await response.json()) as {
    userMessage: BookChatMessageDTO;
    sessionId: string;
  };
  return { userMessage: payload.userMessage, sessionId: payload.sessionId };
}

export async function abortBookChatMessage(params: {
  bookId: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<{ aborted: boolean }> {
  const response = await fetch(
    `/api/books/${params.bookId}/chat/sessions/${params.sessionId}/abort`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: params.signal,
    }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body?.error || "Не удалось остановить чат"));
  }
  return (await response.json()) as { aborted: boolean };
}

