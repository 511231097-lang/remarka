import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import { toAnalyzingBookDTO } from "@/lib/libraryAnalyzing";

export async function GET() {
  const authUser = await resolveAuthUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await prisma.book.findMany({
    where: {
      ownerUserId: authUser.id,
      analysisStatus: { in: ["queued", "running"] },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      author: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      analysisStatus: true,
      analysisTotalBlocks: true,
      analysisCheckedBlocks: true,
      analysisStartedAt: true,
      analysisRequestedAt: true,
      createdAt: true,
    },
  });

  const now = new Date();
  const items = rows.map((row) => toAnalyzingBookDTO(row, now));
  return NextResponse.json(items);
}
