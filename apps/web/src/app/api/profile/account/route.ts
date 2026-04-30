import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { deleteArtifactPayloadsForBook, deleteBookBlob } from "@/lib/bookStorageCleanup";

// Account deletion. Honors the right-to-erasure declared in the Privacy
// policy (152-FZ art. 14 + GDPR art. 17 analogue).
//
// Flow:
//   1. Auth the caller.
//   2. Require an explicit confirmation token in the body — protects
//      against accidental deletion via misclick / replay / CSRF chain.
//   3. Walk all books owned by the user and purge their blob storage
//      (original file + analysis-run + chat-run artifacts). DB cascade
//      handles every BookChapter / BookScene / BookEntity / etc.
//   4. Delete the User row. The schema has onDelete: Cascade on Account,
//      Session, Book, BookLike, BookChatSession, and BookChatThread, so
//      everything DB-side cleans up in one statement.
//   5. Return 204. Client is responsible for calling next-auth signOut().
//
// Hardening notes:
//   - Blob cleanup runs BEFORE the DB delete on purpose: if blob delete
//     throws hard we still want the DB row around so the user can retry.
//     But individual blob errors are swallowed (matches /api/books DELETE
//     behavior — orphaned blob is preferable to refusing erasure).
//   - We do NOT attempt to delete pg-boss queue jobs that reference the
//     user. They'll either complete harmlessly (no row to update) or fail
//     and retire on their normal retry policy. Worth revisiting if we
//     start seeing noisy worker logs after deletions.

const CONFIRMATION_TOKEN = "УДАЛИТЬ";

export async function DELETE(request: Request) {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { confirm?: string } = {};
  try {
    body = (await request.json()) as { confirm?: string };
  } catch {
    // Empty/invalid body — fall through to the confirmation check below.
  }
  if (String(body?.confirm || "").trim().toUpperCase() !== CONFIRMATION_TOKEN) {
    return NextResponse.json(
      { error: `Confirmation required. Send {"confirm":"${CONFIRMATION_TOKEN}"} in body.` },
      { status: 400 },
    );
  }

  const ownedBooks = await prisma.book.findMany({
    where: { ownerUserId: authUser.id },
    select: {
      id: true,
      storageProvider: true,
      storageKey: true,
    },
  });

  for (const book of ownedBooks) {
    try {
      await deleteBookBlob({
        storageProvider: book.storageProvider,
        storageKey: book.storageKey,
      });
    } catch {
      // Don't block on blob cleanup; orphaned objects are preferable to
      // refusing the erasure request.
    }
    try {
      await deleteArtifactPayloadsForBook(book.id);
    } catch {
      // Same rationale as above.
    }
  }

  await prisma.user.delete({
    where: { id: authUser.id },
  });

  return new NextResponse(null, { status: 204 });
}
