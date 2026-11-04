-- v4 fix round 2 + Phase 2. Additive and safe on existing data.
ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

ALTER TABLE "Issuer" ADD COLUMN "holdChanges" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Issuer" ADD COLUMN "holdReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Issuer" ADD COLUMN "holdSetBy" TEXT;
ALTER TABLE "Issuer" ADD COLUMN "holdSetAt" TIMESTAMP(3);

ALTER TABLE "Investor" ADD COLUMN "coverageSalesId" TEXT;
-- Demo coverage (no-op where these rows do not exist).
UPDATE "Investor" SET "coverageSalesId" = 'sales-james' WHERE "id" IN ('pimco', 'blackrock', 'wellington', 'fidelity', 'apollo') AND "coverageSalesId" IS NULL;
UPDATE "Investor" SET "coverageSalesId" = 'sales-emma' WHERE "coverageSalesId" IS NULL AND EXISTS (SELECT 1 FROM "User" WHERE "id" = 'sales-emma');

ALTER TABLE "Email" ADD COLUMN "originalSender" TEXT;
ALTER TABLE "Email" ADD COLUMN "originalSenderName" TEXT;
ALTER TABLE "Email" ADD COLUMN "forwardedBy" TEXT;
ALTER TABLE "Email" ADD COLUMN "escalation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Email" ADD COLUMN "escalationReasons" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Email" ADD COLUMN "suspicious" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Email" SET "escalation" = true WHERE "category" = 'Escalation / complaint';
UPDATE "Email" SET "suspicious" = true WHERE "senderStatus" = 'unverified';

ALTER TABLE "Proposal" ADD COLUMN "refreshedAt" TIMESTAMP(3);

ALTER TABLE "Meeting" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Meeting" ADD COLUMN "changedAt" TIMESTAMP(3);
ALTER TABLE "Meeting" ADD COLUMN "changedBy" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "changeSummary" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Meeting" ADD COLUMN "protected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Meeting" ADD COLUMN "protectedReason" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Draft" ADD COLUMN "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Draft" ADD COLUMN "kind" TEXT NOT NULL DEFAULT '';

ALTER TABLE "AuditLog" ADD COLUMN "issuerId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "meetingId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "emailId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "note" TEXT;
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
-- Backfill searchable columns from the stored records.
UPDATE "AuditLog" SET "issuerId" = COALESCE("after"->>'issuerId', "before"->>'issuerId') WHERE "issuerId" IS NULL;
UPDATE "AuditLog" SET "meetingId" = "entityId" WHERE "entityType" = 'Meeting' AND "meetingId" IS NULL;
UPDATE "AuditLog" SET "emailId" = "entityId" WHERE "entityType" = 'Email' AND "emailId" IS NULL;
UPDATE "AuditLog" SET "note" = "after"->>'reason' WHERE "note" IS NULL AND "after" ? 'reason';

CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "meetingId" TEXT,
    "emailId" TEXT,
    "requestId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

CREATE TABLE "ExportLog" (
    "id" TEXT NOT NULL,
    "conferenceId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "audienceId" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExportLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ExportLog_conferenceId_scope_audienceId_idx" ON "ExportLog"("conferenceId", "scope", "audienceId");
