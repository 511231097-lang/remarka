-- LegalConsent — append-only audit лог юридически значимых акцептов.
-- Каждая запись фиксирует ровно тот текст документа (через
-- documentVersionHash), который пользователь видел в момент клика.

CREATE TYPE "LegalConsentType" AS ENUM (
  'signin_acceptance',
  'upload_acceptance',
  'cookie_settings'
);

CREATE TABLE "LegalConsent" (
  "id"                        TEXT             NOT NULL,
  "userId"                    TEXT,
  "consentType"               "LegalConsentType" NOT NULL,
  "acceptedAt"                TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "documentVersionHash"       TEXT             NOT NULL,
  "documentVersionLabel"      TEXT             NOT NULL,
  "ipAddress"                 TEXT,
  "userAgent"                 TEXT,
  "relatedResourceId"         TEXT,
  "cookieCategoriesJson"      JSONB,

  CONSTRAINT "LegalConsent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LegalConsent"
  ADD CONSTRAINT "LegalConsent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "LegalConsent_userId_acceptedAt_idx"
  ON "LegalConsent" ("userId", "acceptedAt");

CREATE INDEX "LegalConsent_consentType_acceptedAt_idx"
  ON "LegalConsent" ("consentType", "acceptedAt");

CREATE INDEX "LegalConsent_relatedResourceId_idx"
  ON "LegalConsent" ("relatedResourceId");
