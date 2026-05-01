import { BookOverview } from "@/components/BookOverview";

// Public: страница обзора книги доступна анонимам для isPublic=true книг
// (каталог + клик по карточке). Чат остаётся под auth — он сидит в
// app/(protected)/book/[bookId]/chat/* и его layout редиректит на /signin.
export default function BookOverviewPage() {
  return <BookOverview />;
}
