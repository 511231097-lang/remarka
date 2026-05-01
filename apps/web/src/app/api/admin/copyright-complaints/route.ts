import { prisma } from "@remarka/db";
import type { Prisma, CopyrightComplaintStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";

const STATUS_VALUES: CopyrightComplaintStatus[] = [
  "new",
  "under_review",
  "accepted",
  "rejected",
  "counter_received",
];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export async function GET(request: Request) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const statusRaw = String(searchParams.get("status") || "").trim();
  const status = (STATUS_VALUES as string[]).includes(statusRaw)
    ? (statusRaw as CopyrightComplaintStatus)
    : null;
  const q = String(searchParams.get("q") || "").trim();
  const page = parsePositiveInt(searchParams.get("page"), 1, 100_000);
  const pageSize = parsePositiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const skip = (page - 1) * pageSize;

  const where: Prisma.CopyrightComplaintWhereInput = {};
  if (status) where.status = status;
  if (q) {
    where.OR = [
      { claimantEmail: { contains: q, mode: "insensitive" } },
      { claimantName: { contains: q, mode: "insensitive" } },
      { workTitle: { contains: q, mode: "insensitive" } },
    ];
  }

  const [total, items] = await prisma.$transaction([
    prisma.copyrightComplaint.count({ where }),
    prisma.copyrightComplaint.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
      select: {
        id: true,
        status: true,
        claimantType: true,
        claimantName: true,
        claimantOrganization: true,
        claimantEmail: true,
        workTitle: true,
        createdAt: true,
        reviewedAt: true,
        attachmentsJson: true,
      },
    }),
  ]);

  return NextResponse.json({
    page,
    pageSize,
    total,
    items: items.map((row) => ({
      id: row.id,
      status: row.status,
      claimantType: row.claimantType,
      claimantName: row.claimantName,
      claimantOrganization: row.claimantOrganization,
      claimantEmail: row.claimantEmail,
      workTitle: row.workTitle,
      createdAt: row.createdAt.toISOString(),
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      attachmentCount: Array.isArray(row.attachmentsJson)
        ? row.attachmentsJson.length
        : 0,
    })),
  });
}
