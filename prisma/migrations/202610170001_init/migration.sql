-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conference" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "slotMinutes" INTEGER NOT NULL DEFAULT 30,

    CONSTRAINT "Conference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issuer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "ownerId" TEXT,

    CONSTRAINT "Issuer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Investor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,

    CONSTRAINT "Investor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Email" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "to" TEXT[],
    "cc" TEXT[],
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "newContent" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conferenceId" TEXT,
    "issuerId" TEXT,
    "investorId" TEXT,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending review',

    CONSTRAINT "Email_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "extraction" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "reviewerId" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Availability" (
    "id" TEXT NOT NULL,
    "conferenceId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'Available',
    "sourceEmailId" TEXT,
    "approvedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingRequest" (
    "id" TEXT NOT NULL,
    "conferenceId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "salespersonId" TEXT NOT NULL,
    "bankerId" TEXT,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 30,
    "alternativeDates" TEXT[],
    "notes" TEXT NOT NULL DEFAULT '',
    "priority" TEXT NOT NULL DEFAULT 'Normal',
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "conferenceId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Confirmed',
    "location" TEXT NOT NULL DEFAULT '',
    "bankerIds" TEXT[],
    "approvedRecipients" TEXT[],
    "sourceEmailId" TEXT,
    "approvedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Action" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "conferenceId" TEXT,
    "issuerId" TEXT,
    "investorId" TEXT,
    "emailId" TEXT,
    "requestId" TEXT,
    "assignedTo" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'Normal',
    "status" TEXT NOT NULL DEFAULT 'Open',
    "recommendation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT,
    "requestId" TEXT,
    "emailId" TEXT,
    "createdBy" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "to" TEXT[],
    "cc" TEXT[],
    "historicalParticipants" TEXT[],
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "approvedBy" TEXT,
    "simulatedSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Email_messageId_key" ON "Email"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_emailId_key" ON "Proposal"("emailId");

-- CreateIndex
CREATE INDEX "Availability_conferenceId_issuerId_idx" ON "Availability"("conferenceId", "issuerId");

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_requestId_key" ON "Meeting"("requestId");

-- CreateIndex
CREATE INDEX "Meeting_conferenceId_issuerId_idx" ON "Meeting"("conferenceId", "issuerId");

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MeetingRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

