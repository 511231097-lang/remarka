import { createHash } from "node:crypto";
import { prisma } from "@remarka/db";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { verifyCaptcha } from "@/lib/captcha";
import {
  resolveCopyrightComplaintsBlobStore,
  type CopyrightAttachmentRecord,
} from "@/lib/complaintBlobStore";
import {
  COPYRIGHT_COMPLAINT_SWORN_TEXT,
  LEGAL_DOC_VERSION,
} from "@/lib/legalDocumentVersions";
import { checkRateLimit, getClientIpFromRequest } from "@/lib/rateLimit";

// POST /api/legal/copyright-complaint
//
// Принимает multipart/form-data: текстовые поля + до 5 вложений в одном
// запросе. Выбран singular endpoint вместо отдельного upload-step:
//  - нет orphan-файлов в S3, если форма не сабмитнулась
//  - не нужен session-token / signed URL для привязки upload→submit
//  - rate-limit и captcha верифицируются один раз
//
// Защиты от злоупотреблений (форма unauthenticated):
//  - captcha (Cloudflare Turnstile, env-конфигурируемая)
//  - rate-limit по IP: 5 жалоб в час
//  - валидация форматов и размеров файлов
//  - sworn-checkbox с хешированным текстом (доказательная база)

const RATE_LIMIT_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);
const ALLOWED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);

const CLAIMANT_TYPES = ["rightsholder", "authorized_person", "org_representative"] as const;
type ClaimantType = (typeof CLAIMANT_TYPES)[number];

const FIELD_MAX_LENGTHS = {
  claimantName: 200,
  claimantOrganization: 200,
  claimantEmail: 200,
  workTitle: 500,
  disputedUrls: 4_000,
  rightsBasis: 2_000,
  powerOfAttorneyDetails: 2_000,
  description: 8_000,
};

interface ValidationOk {
  ok: true;
  data: {
    claimantType: ClaimantType;
    claimantName: string;
    claimantOrganization: string | null;
    claimantEmail: string;
    workTitle: string;
    disputedUrls: string;
    rightsBasis: string;
    powerOfAttorneyDetails: string | null;
    description: string;
    sworn: boolean;
    captchaToken: string | null;
    files: File[];
  };
}

interface ValidationErr {
  ok: false;
  status: number;
  error: string;
  field?: string;
}

function getString(formData: FormData, name: string, maxLen: number): string {
  const raw = formData.get(name);
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, maxLen);
}

function getOptionalString(formData: FormData, name: string, maxLen: number): string | null {
  const value = getString(formData, name, maxLen);
  return value || null;
}

function isValidEmail(value: string): boolean {
  // Простая проверка — не пытаемся быть RFC-compliant. Для бизнес-логики
  // достаточно: есть @ и есть точка после @.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0) return "";
  return name.slice(idx).toLowerCase();
}

async function parseAndValidate(request: Request): Promise<ValidationOk | ValidationErr> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return {
      ok: false,
      status: 415,
      error: "Content-Type must be multipart/form-data",
    };
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return { ok: false, status: 400, error: "Failed to parse multipart body" };
  }

  const claimantTypeRaw = String(formData.get("claimantType") || "").trim();
  if (!CLAIMANT_TYPES.includes(claimantTypeRaw as ClaimantType)) {
    return {
      ok: false,
      status: 400,
      error: `claimantType must be one of: ${CLAIMANT_TYPES.join(", ")}`,
      field: "claimantType",
    };
  }
  const claimantType = claimantTypeRaw as ClaimantType;

  const claimantName = getString(formData, "claimantName", FIELD_MAX_LENGTHS.claimantName);
  if (!claimantName) {
    return { ok: false, status: 400, error: "claimantName is required", field: "claimantName" };
  }

  const claimantOrganization = getOptionalString(
    formData,
    "claimantOrganization",
    FIELD_MAX_LENGTHS.claimantOrganization,
  );

  const claimantEmail = getString(formData, "claimantEmail", FIELD_MAX_LENGTHS.claimantEmail);
  if (!claimantEmail || !isValidEmail(claimantEmail)) {
    return { ok: false, status: 400, error: "claimantEmail is invalid", field: "claimantEmail" };
  }

  const workTitle = getString(formData, "workTitle", FIELD_MAX_LENGTHS.workTitle);
  if (!workTitle) {
    return { ok: false, status: 400, error: "workTitle is required", field: "workTitle" };
  }

  const disputedUrls = getString(formData, "disputedUrls", FIELD_MAX_LENGTHS.disputedUrls);
  if (!disputedUrls) {
    return {
      ok: false,
      status: 400,
      error: "disputedUrls is required",
      field: "disputedUrls",
    };
  }

  const rightsBasis = getString(formData, "rightsBasis", FIELD_MAX_LENGTHS.rightsBasis);
  if (!rightsBasis) {
    return { ok: false, status: 400, error: "rightsBasis is required", field: "rightsBasis" };
  }

  const powerOfAttorneyDetails = getOptionalString(
    formData,
    "powerOfAttorneyDetails",
    FIELD_MAX_LENGTHS.powerOfAttorneyDetails,
  );
  if (claimantType === "authorized_person" && !powerOfAttorneyDetails) {
    return {
      ok: false,
      status: 400,
      error: "powerOfAttorneyDetails is required when claimantType=authorized_person",
      field: "powerOfAttorneyDetails",
    };
  }

  const description = getString(formData, "description", FIELD_MAX_LENGTHS.description);
  if (!description) {
    return { ok: false, status: 400, error: "description is required", field: "description" };
  }

  const swornRaw = String(formData.get("sworn") || "").trim().toLowerCase();
  const sworn = swornRaw === "true" || swornRaw === "1" || swornRaw === "on";
  if (!sworn) {
    return {
      ok: false,
      status: 400,
      error: "Acknowledgement of добросовестность is required",
      field: "sworn",
    };
  }

  const captchaTokenRaw = formData.get("captchaToken");
  const captchaToken =
    typeof captchaTokenRaw === "string" && captchaTokenRaw.trim()
      ? captchaTokenRaw.trim()
      : null;

  const files: File[] = [];
  for (const entry of formData.getAll("attachments")) {
    if (!(entry instanceof File)) continue;
    if (entry.size === 0) continue;
    files.push(entry);
  }

  if (files.length > MAX_ATTACHMENT_COUNT) {
    return {
      ok: false,
      status: 400,
      error: `Too many attachments. Max ${MAX_ATTACHMENT_COUNT}`,
      field: "attachments",
    };
  }

  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `Attachment "${file.name}" exceeds 20 MB limit`,
        field: "attachments",
      };
    }
    const ext = fileExtension(file.name);
    const mime = String(file.type || "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) || (mime && !ALLOWED_MIME_TYPES.has(mime))) {
      return {
        ok: false,
        status: 415,
        error: `Attachment "${file.name}" has unsupported type. Allowed: PDF, JPG, PNG.`,
        field: "attachments",
      };
    }
  }

  return {
    ok: true,
    data: {
      claimantType,
      claimantName,
      claimantOrganization,
      claimantEmail,
      workTitle,
      disputedUrls,
      rightsBasis,
      powerOfAttorneyDetails,
      description,
      sworn,
      captchaToken,
      files,
    },
  };
}

export async function POST(request: Request) {
  const ipAddress = getClientIpFromRequest(request);
  const userAgent = request.headers.get("user-agent")?.slice(0, 500) || null;

  // Rate-limit ставим до парсинга multipart, чтобы не тратить ресурсы
  // на ботов, бомбящих форму. Ключ — IP; если IP нет (странный setup),
  // используем плейсхолдер чтобы хотя бы общий global-лимит сработал.
  const rateKey = ipAddress || "__unknown__";
  const rate = checkRateLimit({
    bucket: "copyright_complaint_submit",
    key: rateKey,
    limit: RATE_LIMIT_PER_HOUR,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error:
          "Слишком много заявлений за короткое время. Попробуйте позже или напишите на abuse@remarka.app.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const validation = await parseAndValidate(request);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.error, field: validation.field },
      { status: validation.status },
    );
  }
  const { data } = validation;

  // Captcha — после валидации формы (чтобы можно было сразу показать
  // ошибки полей без consume'нья captcha-токена), но до тяжёлых I/O
  // (S3-upload, БД-вставка).
  const captcha = await verifyCaptcha({
    token: data.captchaToken,
    remoteIp: ipAddress,
  });
  if (!captcha.ok) {
    // Логируем конкретный код ошибки на сервере для дебага. Не выставляем
    // его пользователю в виде user-message, но возвращаем в payload как
    // captchaErrorCode, чтобы можно было увидеть в DevTools network tab.
    console.warn("[copyright-complaint] captcha verification failed", {
      error: captcha.error,
      hadToken: Boolean(data.captchaToken),
      tokenLength: data.captchaToken ? data.captchaToken.length : 0,
      ipAddress,
    });
    return NextResponse.json(
      {
        error: "Не удалось пройти проверку captcha. Обновите страницу и попробуйте ещё раз.",
        captchaErrorCode: captcha.error || "unknown",
      },
      { status: 400 },
    );
  }

  const swornHash = createHash("sha256")
    .update(COPYRIGHT_COMPLAINT_SWORN_TEXT, "utf8")
    .digest("hex");

  // Загружаем вложения в S3. Если хоть одно упадёт — стопаем, лучше
  // отказать заявителю, чем создать жалобу с потерянным договором.
  const blobStore = resolveCopyrightComplaintsBlobStore();
  const uploadedAttachments: CopyrightAttachmentRecord[] = [];

  try {
    for (const file of data.files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stored = await blobStore.put({
        bytes,
        fileName: file.name,
        prefix: new Date().toISOString().slice(0, 7).replace("-", "/"),
      });
      uploadedAttachments.push({
        storageProvider: stored.provider,
        storageKey: stored.storageKey,
        fileName: file.name.slice(0, 200),
        mimeType: file.type || "application/octet-stream",
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        uploadedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    // Откатываем уже залитые файлы — не оставляем их висеть.
    for (const att of uploadedAttachments) {
      try {
        await blobStore.delete(att.storageKey);
      } catch {
        // best-effort cleanup
      }
    }
    console.error("[copyright-complaint] failed to upload attachments", error);
    return NextResponse.json(
      { error: "Не удалось загрузить файлы. Попробуйте позже." },
      { status: 500 },
    );
  }

  try {
    const complaint = await prisma.copyrightComplaint.create({
      data: {
        status: "new",
        claimantType: data.claimantType,
        claimantName: data.claimantName,
        claimantOrganization: data.claimantOrganization,
        claimantEmail: data.claimantEmail,
        workTitle: data.workTitle,
        disputedUrls: data.disputedUrls,
        rightsBasis: data.rightsBasis,
        powerOfAttorneyDetails: data.powerOfAttorneyDetails,
        description: data.description,
        swornStatementHash: swornHash,
        swornStatementLabel: LEGAL_DOC_VERSION,
        attachmentsJson: uploadedAttachments as unknown as Prisma.InputJsonValue,
        ipAddress: ipAddress?.slice(0, 100) || null,
        userAgent,
      },
      select: { id: true, createdAt: true },
    });

    return NextResponse.json(
      {
        complaintId: complaint.id,
        createdAt: complaint.createdAt.toISOString(),
        message:
          "Заявление зарегистрировано. Мы рассмотрим его в срок до 10 рабочих дней. " +
          "Дополнительные документы можно прислать на abuse@remarka.app с указанием номера заявки.",
      },
      { status: 201 },
    );
  } catch (error) {
    // Если БД вставка упала после загрузки в S3 — чистим хвосты, чтобы
    // не оставлять orphan-вложения.
    for (const att of uploadedAttachments) {
      try {
        await blobStore.delete(att.storageKey);
      } catch {
        // best-effort
      }
    }
    console.error("[copyright-complaint] failed to persist complaint", error);
    return NextResponse.json(
      { error: "Не удалось сохранить заявление. Попробуйте позже." },
      { status: 500 },
    );
  }
}
