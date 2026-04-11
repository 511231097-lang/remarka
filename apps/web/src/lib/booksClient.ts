import type { BookChapterDTO, BookCoreDTO, BooksListResponseDTO } from "@/lib/books";

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
