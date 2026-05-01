-- CopyrightComplaint — структурированный архив заявлений правообладателей
-- по процедуре ст. 1253.1 ГК РФ / ст. 15.7 ФЗ «Об информации». Поступает
-- через форму /legal/copyright. Резервный канал — abuse@ — упоминается
-- в success-сообщении и в тексте страницы.

CREATE TYPE "CopyrightComplaintStatus" AS ENUM (
  'new',
  'under_review',
  'accepted',
  'rejected',
  'counter_received'
);

CREATE TYPE "CopyrightClaimantType" AS ENUM (
  'rightsholder',
  'authorized_person',
  'org_representative'
);

CREATE TABLE "CopyrightComplaint" (
  "id"                       TEXT                       NOT NULL,
  "status"                   "CopyrightComplaintStatus" NOT NULL DEFAULT 'new',
  "claimantType"             "CopyrightClaimantType"    NOT NULL,
  "claimantName"             TEXT                       NOT NULL,
  "claimantOrganization"     TEXT,
  "claimantEmail"            TEXT                       NOT NULL,
  "workTitle"                TEXT                       NOT NULL,
  "disputedUrls"             TEXT                       NOT NULL,
  "rightsBasis"              TEXT                       NOT NULL,
  "powerOfAttorneyDetails"   TEXT,
  "description"              TEXT                       NOT NULL,
  "swornStatementHash"       TEXT                       NOT NULL,
  "swornStatementLabel"      TEXT                       NOT NULL,
  "attachmentsJson"          JSONB                      NOT NULL DEFAULT '[]',
  "ipAddress"                TEXT,
  "userAgent"                TEXT,
  "reviewerNotes"            TEXT,
  "reviewedAt"               TIMESTAMP(3),
  "reviewedByUserId"         TEXT,
  "createdAt"                TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3)               NOT NULL,

  CONSTRAINT "CopyrightComplaint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CopyrightComplaint_status_createdAt_idx"
  ON "CopyrightComplaint" ("status", "createdAt");

CREATE INDEX "CopyrightComplaint_claimantEmail_createdAt_idx"
  ON "CopyrightComplaint" ("claimantEmail", "createdAt");

CREATE INDEX "CopyrightComplaint_createdAt_idx"
  ON "CopyrightComplaint" ("createdAt");
