import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";

// Personal data export — middle ground between the strict 152-FZ
// "personal data only" reading and a Google-Takeout-style dump of
// everything-the-user-touched.
//
// Includes:
//   - profile: id, name, email, avatarUrl, role + source attribution
//   - books owned: light metadata (title/author/state/timestamps).
//     No showcase JSON blob, no mimeType / sizeBytes — those are
//     internal storage details.
//   - library entries (just bookId + addedAt)
//   - chats: grouped by bookId, then threads, then human-readable
//     messages. Only role + content + createdAt — no thread.id,
//     no compactedHistory, no citationsJson / toolRunsJson /
//     metricsJson (those are internal optimization / observability
//     data and would be unreadable to the user anyway).
//   - legalContext: operator, purposes, legal grounds, named
//     subprocessors, cross-border transfer disclosure, retention,
//     rights — required by 152-FZ ст. 14 to accompany any data-
//     subject access request.
//   - notIncluded: structured list of what is NOT in the export and
//     where to get each thing (UI / privacy@). Trims routine email.
//
// Excluded by design:
//   - Raw uploaded book files (large blobs, on request via privacy@)
//   - Auth internals (Account / Session / VerificationToken)
//   - Per-turn LLM accounting (BookChatTurnMetric / BookChatToolRun)
//   - Technical logs (IP, user-agent) — server journal, retained on
//     the host, exported only on request

const EXPORT_SCHEMA_VERSION = 2;

type ExportPayload = {
  exportedAt: string;
  schemaVersion: number;
  legalContext: {
    operator: {
      type: string;
      fullName: string;
      inn: string;
      taxRegime: string;
      contactEmail: string;
      privacyContact: string;
    };
    purposes: string[];
    legalGrounds: string[];
    subprocessors: Array<{
      name: string;
      country: string;
      role: string;
    }>;
    crossBorderTransfer: string;
    retention: string;
    rights: string[];
    privacyPolicyUrl: string;
  };
  user: {
    id: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
    role: string;
    source: string;
  } | null;
  books: Array<{
    id: string;
    title: string;
    author: string | null;
    isPublic: boolean;
    analysisState: string;
    chapterCount: number;
    summary: string | null;
    uploadedAt: string;
  }>;
  library: Array<{
    bookId: string;
    addedAt: string;
  }>;
  chats: Array<{
    bookId: string;
    threads: Array<{
      title: string;
      createdAt: string;
      updatedAt: string;
      messages: Array<{
        role: string;
        content: string;
        createdAt: string;
      }>;
    }>;
  }>;
  notIncluded: Array<{
    item: string;
    reason: string;
    howToGet: string;
  }>;
};

export async function GET() {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [user, ownedBooks, libraryEntries, threads] = await Promise.all([
    prisma.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
      },
    }),
    prisma.book.findMany({
      where: { ownerUserId: authUser.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        title: true,
        author: true,
        isPublic: true,
        analysisState: true,
        chapterCount: true,
        summary: true,
        createdAt: true,
      },
    }),
    prisma.bookLike.findMany({
      where: { userId: authUser.id },
      orderBy: { createdAt: "asc" },
      select: { bookId: true, createdAt: true },
    }),
    prisma.bookChatThread.findMany({
      where: { ownerUserId: authUser.id },
      orderBy: [{ bookId: "asc" }, { createdAt: "asc" }],
      select: {
        bookId: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            role: true,
            content: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);

  const userPayload = user
    ? {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.image,
        role: user.role,
        source:
          "Получено от Yandex ID при первом входе. Сервис не запрашивает у вас никаких ПДн напрямую — только идентификационные поля, переданные Яндексом.",
      }
    : null;

  // Group threads by bookId for readability — one entry per book with
  // every conversation the user had about it underneath.
  const chatsByBook = new Map<string, ExportPayload["chats"][number]>();
  for (const thread of threads) {
    const entry = chatsByBook.get(thread.bookId) ?? {
      bookId: thread.bookId,
      threads: [],
    };
    entry.threads.push({
      title: thread.title,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      messages: thread.messages.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      })),
    });
    chatsByBook.set(thread.bookId, entry);
  }

  const payload: ExportPayload = {
    exportedAt: new Date().toISOString(),
    schemaVersion: EXPORT_SCHEMA_VERSION,
    legalContext: {
      operator: {
        type: "Самозанятый (плательщик НПД)",
        fullName: "«Ф.И.О.»",
        inn: "«000000000000»",
        taxRegime: "Налог на профессиональный доход (НПД)",
        contactEmail: "hello@remarka.app",
        privacyContact: "privacy@remarka.app",
      },
      purposes: [
        "Создание и ведение учётной записи",
        "Оказание услуги анализа литературных текстов",
        "Ведение истории диалогов с ассистентом",
        "Защита от злоупотреблений и обеспечение работоспособности сервиса",
        "Исполнение требований закона",
      ],
      legalGrounds: [
        "Исполнение договора (Пользовательского соглашения), заключаемого при регистрации",
        "Согласие субъекта на трансграничную передачу при работе AI-ассистента",
        "Исполнение требований закона при ответах на запросы государственных органов",
      ],
      subprocessors: [
        {
          name: "ООО «Яндекс»",
          country: "Российская Федерация",
          role: "Авторизация через Yandex ID и защита от ботов через Yandex SmartCaptcha",
        },
        {
          name: "Google LLC",
          country: "США",
          role: "Обработка запросов ассистента и фрагментов книг через Vertex AI / Gemini",
        },
        {
          name: "ООО НКО «ЮMoney»",
          country: "Российская Федерация",
          role: "Приём платежей через сервис ЮKassa (на момент выгрузки может быть ещё не активирован)",
        },
        {
          name: "Поставщик хостинга и инфраструктурных услуг",
          country: "Российская Федерация",
          role: "Размещение базы данных и файлового хранилища на территории РФ",
        },
      ],
      crossBorderTransfer:
        "Авторизация и защита от ботов выполняются через Яндекс на территории Российской Федерации. При работе AI-ассистента фрагменты ваших запросов и загруженных книг могут передаваться в США (Google LLC / Vertex AI / Gemini) без передачи идентификационных данных Yandex ID. США не входит в перечень государств с адекватной защитой ПДн (ст. 12 ФЗ-152); передача осуществляется с вашего явного согласия.",
      retention:
        "Учётная запись и связанные данные хранятся пока существует учётная запись и до 6 месяцев после её удаления (для защиты прав). Логи авторизации — до 1 года. Платёжные документы — по налоговым срокам.",
      rights: [
        "Право доступа: вы скачиваете эту выгрузку прямо из Профиля",
        "Право на исправление: имя/e-mail/аватар синхронизируются с Yandex ID и обновляются автоматически при следующем входе",
        "Право на удаление: кнопка «Удалить аккаунт» в Профиле; удаление необратимо",
        "Право на ограничение обработки и отзыв согласия: запрос на privacy@remarka.app",
        "Право на жалобу в Роскомнадзор",
      ],
      privacyPolicyUrl: "https://remarka.app/legal/privacy",
    },
    user: userPayload,
    books: ownedBooks.map((book) => ({
      id: book.id,
      title: book.title,
      author: book.author,
      isPublic: book.isPublic,
      analysisState: book.analysisState,
      chapterCount: book.chapterCount,
      summary: book.summary,
      uploadedAt: book.createdAt.toISOString(),
    })),
    library: libraryEntries.map((entry) => ({
      bookId: entry.bookId,
      addedAt: entry.createdAt.toISOString(),
    })),
    chats: Array.from(chatsByBook.values()),
    notIncluded: [
      {
        item: "Исходные файлы загруженных книг (EPUB / FB2 / PDF)",
        reason: "Это произведения, а не ПДн, и они слишком тяжёлые для веб-выгрузки.",
        howToGet:
          "Запрос на privacy@remarka.app с указанием bookId — пришлём presigned-ссылки на скачивание.",
      },
      {
        item: "Полный AI-разбор книг (showcase: герои, темы, ключевые события, цитаты)",
        reason: "Это публичный артефакт книги, не уникальный для вас как пользователя.",
        howToGet: "Откройте книгу в /library — разбор отображается на её странице.",
      },
      {
        item: "Платёжные квитанции / чеки НПД",
        reason: "До запуска платных тарифов их нет.",
        howToGet:
          "После оплаты ссылка на чек НПД приходит на указанный e-mail; копия — в личном кабинете «Мой налог» ФНС.",
      },
      {
        item: "Технические логи (IP, user-agent, refresh-токены)",
        reason: "Хранятся в журнале сервера до 1 года, используются только для безопасности.",
        howToGet: "Запрос на privacy@remarka.app — выгрузим срез по вашему e-mail.",
      },
    ],
  };

  const body = JSON.stringify(payload, null, 2);
  const filename = `remarka-export-${authUser.id}-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
