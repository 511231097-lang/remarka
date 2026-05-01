import { prisma } from "@remarka/db";
import type { CopyrightComplaintStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";
import type { CopyrightAttachmentRecord } from "@/lib/complaintBlobStore";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const STATUS_VALUES: CopyrightComplaintStatus[] = [
  "new",
  "under_review",
  "accepted",
  "rejected",
  "counter_received",
];

function isAttachmentRecord(value: unknown): value is CopyrightAttachmentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.storageProvider === "string" &&
    typeof record.storageKey === "string" &&
    typeof record.fileName === "string" &&
    typeof record.mimeType === "string" &&
    typeof record.sizeBytes === "number"
  );
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const params = await context.params;
  const id = String(params.id || "").trim();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const row = await prisma.copyrightComplaint.findUnique({
    where: { id },
  });

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const attachments: Array<CopyrightAttachmentRecord & { index: number }> = [];
  if (Array.isArray(row.attachmentsJson)) {
    for (let i = 0; i < row.attachmentsJson.length; i += 1) {
      const item: unknown = row.attachmentsJson[i];
      if (isAttachmentRecord(item)) {
        attachments.push({
          storageProvider: item.storageProvider,
          storageKey: item.storageKey,
          fileName: item.fileName,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          sha256: item.sha256,
          uploadedAt: item.uploadedAt,
          index: i,
        });
      }
    }
  }

  return NextResponse.json({
    id: row.id,
    status: row.status,
    claimantType: row.claimantType,
    claimantName: row.claimantName,
    claimantOrganization: row.claimantOrganization,
    claimantEmail: row.claimantEmail,
    workTitle: row.workTitle,
    disputedUrls: row.disputedUrls,
    rightsBasis: row.rightsBasis,
    powerOfAttorneyDetails: row.powerOfAttorneyDetails,
    description: row.description,
    swornStatementHash: row.swornStatementHash,
    swornStatementLabel: row.swornStatementLabel,
    attachments,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    reviewerNotes: row.reviewerNotes,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewedByUserId: row.reviewedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth.error;

  const params = await context.params;
  const id = String(params.id || "").trim();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  let body: { status?: unknown; reviewerNotes?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: {
    status?: CopyrightComplaintStatus;
    reviewerNotes?: string | null;
    reviewedAt?: Date | null;
    reviewedByUserId?: string | null;
  } = {};

  if (body.status !== undefined) {
    const statusRaw = String(body.status || "").trim();
    if (!(STATUS_VALUES as string[]).includes(statusRaw)) {
      return NextResponse.json(
        { error: `status must be one of: ${STATUS_VALUES.join(", ")}` },
        { status: 400 },
      );
    }
    updates.status = statusRaw as CopyrightComplaintStatus;

    // Auto-stamp reviewer info when moving out of "new". Не перетираем, если
    // уже выставлено — у нас может быть несколько ревью, фиксируем последнего.
    if (statusRaw !== "new") {
      updates.reviewedAt = new Date();
      updates.reviewedByUserId = auth.authUser.id;
    }
  }

  if (body.reviewerNotes !== undefined) {
    if (typeof body.reviewerNotes === "string") {
      const trimmed = body.reviewerNotes.trim().slice(0, 8_000);
      updates.reviewerNotes = trimmed || null;
    } else if (body.reviewerNotes === null) {
      updates.reviewerNotes = null;
    } else {
      return NextResponse.json(
        { error: "reviewerNotes must be a string or null" },
        { status: 400 },
      );
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "Nothing to update — provide status or reviewerNotes" },
      { status: 400 },
    );
  }

  try {
    const updated = await prisma.copyrightComplaint.update({
      where: { id },
      data: updates,
      select: { id: true, status: true, reviewedAt: true, reviewerNotes: true },
    });

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      reviewedAt: updated.reviewedAt ? updated.reviewedAt.toISOString() : null,
      reviewerNotes: updated.reviewerNotes,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("[admin/copyright-complaint][patch]", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}
