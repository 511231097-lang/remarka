import type {
  BookAnalysisStatusDTO,
  BookAnalyzerStatusDTO as BookAnalyzerStatusDTOValue,
  BookAnalyzerStateDTO,
  BookChapterDTO,
  BookChatCreateSessionResponseDTO,
  BookChatCreateSessionRequestDTO,
  BookChatMessageDTO,
  BookChatMessagesResponseDTO,
  BookChatSessionDTO,
  BookChatSessionsResponseDTO,
  BookChatStreamEventDTO,
  BookChatStreamFinalEventDTO,
  BookChatStreamRequestDTO,
  BookCoreDTO,
  BookLibraryStateDTO,
  BookShowcaseDTO,
  BooksListResponseDTO,
  LiterarySectionKeyDTO,
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

export interface CreateBookInput {
  file: File;
}

export type BookAnalyzerState = BookAnalyzerStateDTO;
export type BookAnalyzerStatusDTO = BookAnalyzerStatusDTOValue;

export type BookChatStreamEvent = BookChatStreamEventDTO;

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
  signal?: AbortSignal;
  onEvent?: (event: BookChatStreamEvent) => void;
}): Promise<BookChatStreamFinalEventDTO> {
  const response = await fetch(`/api/books/${params.bookId}/chat/sessions/${params.sessionId}/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(params.input || {}),
    signal: params.signal,
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

      if (parsed.event === "status") {
        params.onEvent?.({
          type: "status",
          text: String(payload?.text || ""),
        });
        continue;
      }

      if (parsed.event === "reasoning") {
        params.onEvent?.({
          type: "reasoning",
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
