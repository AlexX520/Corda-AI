-- v4 Phase 1 (reliability). Additive and safe on existing data.

-- Several asks (proposals) per email. Existing rows become ask 0 of their email.
DROP INDEX IF EXISTS "Proposal_emailId_key";
ALTER TABLE "Proposal" ADD COLUMN "askIndex" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Proposal" ADD COLUMN "summary" TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX "Proposal_emailId_askIndex_key" ON "Proposal"("emailId", "askIndex");

-- Sender verification, security flags and how the conference was chosen.
ALTER TABLE "Email" ADD COLUMN "senderStatus" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "Email" ADD COLUMN "securityFlags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Email" ADD COLUMN "contextNote" TEXT NOT NULL DEFAULT '';

-- One action per ask; actions can point at a meeting; escalations notify a second person.
ALTER TABLE "Action" ADD COLUMN "proposalId" TEXT;
ALTER TABLE "Action" ADD COLUMN "meetingId" TEXT;
ALTER TABLE "Action" ADD COLUMN "ccUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "Action_proposalId_idx" ON "Action"("proposalId");
UPDATE "Action" a SET "proposalId" = p."id"
  FROM "Proposal" p
  WHERE a."emailId" = p."emailId" AND a."proposalId" IS NULL;
-- Old availability-conflict actions carried the meeting id in their title.
UPDATE "Action" SET "meetingId" = substring("title" from '· ([^ ]+)$')
  WHERE "type" = 'Availability conflict' AND "meetingId" IS NULL AND "title" LIKE 'Confirmed meeting outside availability · %';

-- Requests remember the source email and the expected attendee count.
ALTER TABLE "MeetingRequest" ADD COLUMN "sourceEmailId" TEXT;
ALTER TABLE "MeetingRequest" ADD COLUMN "attendees" INTEGER;

-- Server-side session invalidation on sign-out.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
