-- v4 round 3: who protected a meeting, explicit "sent" exports, Ask Corda log outside the audit trail.
ALTER TABLE "Meeting" ADD COLUMN "protectedBy" TEXT;
ALTER TABLE "ExportLog" ADD COLUMN "sentAt" TIMESTAMP(3);
CREATE TABLE "AskLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AskLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AskLog_userId_createdAt_idx" ON "AskLog"("userId", "createdAt");
-- Old Ask Corda entries were written to the audit trail; move them out.
INSERT INTO "AskLog" ("id", "userId", "question", "pattern", "createdAt")
  SELECT "id", "actorId", COALESCE("note", ''), "entityId", "createdAt" FROM "AuditLog" WHERE "action" = 'Asked Corda';
DELETE FROM "AuditLog" WHERE "action" = 'Asked Corda';
