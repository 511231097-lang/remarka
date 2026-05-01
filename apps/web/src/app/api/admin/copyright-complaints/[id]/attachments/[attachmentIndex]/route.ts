import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/adminAuth";
import {
  resolveCopyrightComplaintsBlobStore,
  type CopyrightAttachmentRecord,
} from "@/lib/complaintBlobStore";

interface RouteContext {
  params: Promise<{ id: string; attachmentIndex: string }>;
}

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
  const indexRaw = String(params.attachmentIndex || "").trim();
  const index = Number.parseInt(indexRaw, 10);
  if (!id || !Number.isFinite(index) || index < 0) {
    return NextResponse.json({ error: "Invalid id or attachmentIndex" }, { status: 400 });
  }

  const row = await prisma.copyrightComplaint.findUnique({
    where: { id },
    select: { id: true, attachmentsJson: true },
  });

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const list = Array.isArray(row.attachmentsJson) ? row.attachmentsJson : [];
  const item = list[index];
  if (!isAttachmentRecord(item)) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  const blobStore = resolveCopyrightComplaintsBlobStore();
  let bytes: Uint8Array;
  try {
    bytes = await blobStore.get(item.storageKey);
  } catch (error) {
    console.error("[admin/copyright-complaint][attachment]", error);
    return NextResponse.json({ error: "Failed to fetch attachment" }, { status: 500 });
  }

  // Content-Disposition с UTF-8 именем файла (RFC 5987). Браузеры тогда
  // покажут оригинальное имя при скачивании, даже если оно кириллическое.
  const safeName = item.fileName.replace(/[\r\n"]/g, "_");
  const encodedName = encodeURIComponent(item.fileName);
  // Buffer.from(Uint8Array) гарантирует ArrayBuffer-совместимый source —
  // нужно для NextResponse body type.
  const buffer = Buffer.from(bytes);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": item.mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
