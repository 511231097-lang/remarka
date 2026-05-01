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
import {
  MultipartUploadError,
  parseStreamingMultipart,
  type TempUploadedFile,
} from "@/lib/streamingMultipart";

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
    files: TempUploadedFile[];
    cleanupTempFiles: () => Promise<void>;
  };
}

interface ValidationErr {
  ok: false;
  status: number;
  error: string;
  field?: string;
}

function getString(fields: Map<string, string[]>, name: string, maxLen: number): string {
  const raw = fields.get(name)?.[0];
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, maxLen);
}

function getOptionalString(fields: Map<string, string[]>, name: string, maxLen: number): string | null {
  const value = getString(fields, name, maxLen);
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

  let upload: Awaited<ReturnType<typeof parseStreamingMultipart>>;
  try {
    upload = await parseStreamingMultipart(request, {
      fileFieldNames: ["attachments"],
      maxFiles: MAX_ATTACHMENT_COUNT,
      maxFileSizeBytes: MAX_ATTACHMENT_SIZE_BYTES,
      tempPrefix: "remarka-copyright-complaint",
      maxFieldSizeBytes: FIELD_MAX_LENGTHS.description,
    });
  } catch (error) {
    if (error instanceof MultipartUploadError) {
      return { ok: false, status: error.status, error: error.message, field: error.field };
    }
    return { ok: false, status: 400, error: "Failed to parse multipart body" };
  }

  const fail = async (status: number, error: string, field?: string): Promise<ValidationErr> => {
    await upload.cleanup();
    return { ok: false, status, error, field };
  };

  const claimantTypeRaw = getString(upload.fields, "claimantType", 100);
  if (!CLAIMANT_TYPES.includes(claimantTypeRaw as ClaimantType)) {
    return fail(400, `claimantType must be one of: ${CLAIMANT_TYPES.join(", ")}`, "claimantType");
  }
  const claimantType = claimantTypeRaw as ClaimantType;

  const claimantName = getString(upload.fields, "claimantName", FIELD_MAX_LENGTHS.claimantName);
  if (!claimantName) {
    return fail(400, "claimantName is required", "claimantName");
  }

  const claimantOrganization = getOptionalString(
    upload.fields,
    "claimantOrganization",
    FIELD_MAX_LENGTHS.claimantOrganization,
  );

  const claimantEmail = getString(upload.fields, "claimantEmail", FIELD_MAX_LENGTHS.claimantEmail);
  if (!claimantEmail || !isValidEmail(claimantEmail)) {
    return fail(400, "claimantEmail is invalid", "claimantEmail");
  }

  const workTitle = getString(upload.fields, "workTitle", FIELD_MAX_LENGTHS.workTitle);
  if (!workTitle) {
    return fail(400, "workTitle is required", "workTitle");
  }

  const disputedUrls = getString(upload.fields, "disputedUrls", FIELD_MAX_LENGTHS.disputedUrls);
  if (!disputedUrls) {
    return fail(400, "disputedUrls is required", "disputedUrls");
  }

  const rightsBasis = getString(upload.fields, "rightsBasis", FIELD_MAX_LENGTHS.rightsBasis);
  if (!rightsBasis) {
    return fail(400, "rightsBasis is required", "rightsBasis");
  }

  const powerOfAttorneyDetails = getOptionalString(
    upload.fields,
    "powerOfAttorneyDetails",
    FIELD_MAX_LENGTHS.powerOfAttorneyDetails,
  );
  if (claimantType === "authorized_person" && !powerOfAttorneyDetails) {
    return fail(
      400,
      "powerOfAttorneyDetails is required when claimantType=authorized_person",
      "powerOfAttorneyDetails",
    );
  }

  const description = getString(upload.fields, "description", FIELD_MAX_LENGTHS.description);
  if (!description) {
    return fail(400, "description is required", "description");
  }

  const swornRaw = getString(upload.fields, "sworn", 20).toLowerCase();
  const sworn = swornRaw === "true" || swornRaw === "1" || swornRaw === "on";
  if (!sworn) {
    return fail(400, "Acknowledgement of добросовестность is required", "sworn");
  }

  const captchaToken = getOptionalString(upload.fields, "captchaToken", 4096);

  const files = upload.files.filter((file) => file.fieldName === "attachments" && file.sizeBytes > 0);

  if (files.length > MAX_ATTACHMENT_COUNT) {
    return fail(400, `Too many attachments. Max ${MAX_ATTACHMENT_COUNT}`, "attachments");
  }

  for (const file of files) {
    if (file.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
      return fail(413, `Attachment "${file.fileName}" exceeds 20 MB limit`, "attachments");
    }
    const ext = fileExtension(file.fileName);
    const mime = String(file.mimeType || "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) || (mime && !ALLOWED_MIME_TYPES.has(mime))) {
      return fail(415, `Attachment "${file.fileName}" has unsupported type. Allowed: PDF, JPG, PNG.`, "attachments");
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
      cleanupTempFiles: upload.cleanup,
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

  try {
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
        const stored = await blobStore.putFile({
          filePath: file.tempPath,
          fileName: file.fileName,
          prefix: new Date().toISOString().slice(0, 7).replace("-", "/"),
        });
        uploadedAttachments.push({
          storageProvider: stored.provider,
          storageKey: stored.storageKey,
          fileName: file.fileName.slice(0, 200),
          mimeType: file.mimeType || "application/octet-stream",
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
  } finally {
    await data.cleanupTempFiles();
  }
}
