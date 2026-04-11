import type { Book, BookChapter, User } from "@prisma/client";

export interface BookOwnerDTO {
  id: string;
  name: string;
  image: string | null;
}

export interface BookCardDTO {
  id: string;
  title: string;
  author: string | null;
  isPublic: boolean;
  createdAt: string;
  owner: BookOwnerDTO;
  status: "ready";
  chaptersCount: number;
  charactersCount: number;
  themesCount: number;
  locationsCount: number;
  likesCount: number;
}

export interface BookCoreDTO {
  id: string;
  title: string;
  author: string | null;
  isPublic: boolean;
  chapterCount: number;
  canManage: boolean;
  createdAt: string;
  owner: BookOwnerDTO;
}

export interface BooksListResponseDTO {
  items: BookCardDTO[];
  page: number;
  pageSize: number;
  total: number;
}

export interface BookChapterDTO {
  id: string;
  orderIndex: number;
  title: string;
  previewText: string | null;
}

type BookWithOwner = Book & {
  owner: Pick<User, "id" | "name" | "email" | "image">;
};

export function resolveOwnerName(owner: Pick<User, "name" | "email">): string {
  const name = String(owner.name || "").trim();
  if (name) return name;
  const email = String(owner.email || "").trim();
  if (email) return email;
  return "Пользователь";
}

export function toBookOwnerDTO(owner: Pick<User, "id" | "name" | "email" | "image">): BookOwnerDTO {
  return {
    id: owner.id,
    name: resolveOwnerName(owner),
    image: owner.image || null,
  };
}

export function toBookCardDTO(book: BookWithOwner): BookCardDTO {
  return {
    id: book.id,
    title: book.title,
    author: book.author || null,
    isPublic: book.isPublic,
    createdAt: book.createdAt.toISOString(),
    owner: toBookOwnerDTO(book.owner),
    status: "ready",
    chaptersCount: book.chapterCount,
    charactersCount: 0,
    themesCount: 0,
    locationsCount: 0,
    likesCount: 0,
  };
}

export function toBookCoreDTO(book: BookWithOwner): BookCoreDTO {
  return {
    id: book.id,
    title: book.title,
    author: book.author || null,
    isPublic: book.isPublic,
    chapterCount: book.chapterCount,
    canManage: false,
    createdAt: book.createdAt.toISOString(),
    owner: toBookOwnerDTO(book.owner),
  };
}

export function toBookChapterDTO(chapter: BookChapter): BookChapterDTO {
  return {
    id: chapter.id,
    orderIndex: chapter.orderIndex,
    title: chapter.title,
    previewText: chapter.previewText || null,
  };
}

export function displayAuthor(author: string | null): string {
  const value = String(author || "").trim();
  return value || "Автор не указан";
}
