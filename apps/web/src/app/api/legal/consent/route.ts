import { createHash } from "node:crypto";
import { prisma } from "@remarka/db";
import { NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/authUser";
import {
  COOKIE_CONSENT_TEXT,
  LEGAL_DOC_VERSION,
  SIGNIN_CONSENT_TEXT,
  UPLOAD_CONSENT_TEXT,
} from "@/lib/legalDocumentVersions";

// POST /api/legal/consent
//
// Append-only audit log for юридически-significant acceptances —
// signin galka, upload galka, cookie settings save.
//
// Server-side, NOT client-side, computes documentVersionHash from the
// canonical text snapshot in legalDocumentVersions.ts. The client just
// passes the consentType (and optional payload like cookie categories
// or relatedResourceId for upload) — it cannot lie about which text was
// accepted, because we hash the text on the server based on the type.
//
// Auth: not strictly required — for signin_acceptance the user record
// might not exist yet (acceptance happens BEFORE NextAuth callback).
// We accept anonymous signin acceptances and link by userId only when
// we have a session.

const CONSENT_TYPES = [
  "signin_acceptance",
  "upload_acceptance",
  "cookie_settings",
] as const;
type ConsentType = (typeof CONSENT_TYPES)[number];

const CONSENT_TEXT_BY_TYPE: Record<ConsentType, string> = {
  signin_acceptance: SIGNIN_CONSENT_TEXT,
  upload_acceptance: UPLOAD_CONSENT_TEXT,
  cookie_settings: COOKIE_CONSENT_TEXT,
};

function hashConsentText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Берём первый IP (исходный клиент) — остальные это hops через прокси.
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return null;
}

export async function POST(request: Request) {
  let body: {
    consentType?: unknown;
    relatedResourceId?: unknown;
    cookieCategories?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const consentType = String(body?.consentType || "").trim() as ConsentType;
  if (!CONSENT_TYPES.includes(consentType)) {
    return NextResponse.json(
      { error: `consentType must be one of: ${CONSENT_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  const text = CONSENT_TEXT_BY_TYPE[consentType];
  const documentVersionHash = hashConsentText(text);

  // userId — best effort. signin_acceptance может прийти ДО создания
  // юзера в БД (между галкой и Yandex ID callback'ом), поэтому
  // допускаем null. Для upload/cookie на залогиненом пользователе —
  // userId всегда есть.
  const authUser = await resolveAuthUser();

  let cookieCategoriesJson: { analytics: boolean; perso: boolean } | null = null;
  if (consentType === "cookie_settings") {
    const raw = body?.cookieCategories;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      cookieCategoriesJson = {
        analytics: Boolean(obj.analytics),
        perso: Boolean(obj.perso),
      };
    }
  }

  let relatedResourceId: string | null = null;
  if (consentType === "upload_acceptance") {
    const raw = body?.relatedResourceId;
    if (typeof raw === "string" && raw.trim()) {
      relatedResourceId = raw.trim();
    }
  }

  const ipAddress = getClientIp(request);
  const userAgent = request.headers.get("user-agent")?.slice(0, 500) || null;

  const consent = await prisma.legalConsent.create({
    data: {
      userId: authUser?.id ?? null,
      consentType,
      documentVersionHash,
      documentVersionLabel: LEGAL_DOC_VERSION,
      ipAddress: ipAddress?.slice(0, 100) || null,
      userAgent,
      relatedResourceId,
      cookieCategoriesJson: cookieCategoriesJson ?? undefined,
    },
    select: { id: true },
  });

  return NextResponse.json(
    {
      consentId: consent.id,
      versionLabel: LEGAL_DOC_VERSION,
      versionHash: documentVersionHash,
    },
    { status: 201 },
  );
}
