-- Outlook (Microsoft Graph) connection and email/draft provenance
ALTER TABLE "Email" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "Email" ADD COLUMN "graphId" TEXT;
ALTER TABLE "Draft" ADD COLUMN "deliveryMode" TEXT;
ALTER TABLE "Draft" ADD COLUMN "deliveryReceipt" TEXT;

CREATE TABLE "OutlookAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "refreshToken" TEXT NOT NULL,
    "deltaLink" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OutlookAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OutlookAccount_userId_key" ON "OutlookAccount"("userId");
