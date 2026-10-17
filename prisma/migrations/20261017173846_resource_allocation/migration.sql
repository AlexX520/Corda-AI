-- AlterTable
ALTER TABLE "Conference" ADD COLUMN     "backToBackWeight" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "preferenceDeadline" TIMESTAMP(3),
ADD COLUMN     "preferenceWeight" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "roomBufferMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "workloadWeight" INTEGER NOT NULL DEFAULT 12;

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "expectedAttendees" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "requiresCube" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "BankerPreference" (
    "id" TEXT NOT NULL,
    "conferenceId" TEXT NOT NULL,
    "bankerId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "meetingId" TEXT,
    "preferenceLevel" TEXT NOT NULL DEFAULT 'No Preference',
    "preferenceWeight" INTEGER NOT NULL DEFAULT 0,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "submissionStatus" TEXT NOT NULL DEFAULT 'Draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankerPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankerAvailability" (
    "id" TEXT NOT NULL,
    "conferenceId" TEXT NOT NULL,
    "bankerId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Available',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankerAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuerCoverageAuthorization" (
    "id" TEXT NOT NULL,
    "conferenceId" TEXT NOT NULL,
    "bankerId" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "qualification" TEXT NOT NULL DEFAULT 'Support',
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "IssuerCoverageAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingCoverageRequirement" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "requiredBankerCount" INTEGER NOT NULL DEFAULT 2,
    "requiredPrimaryCount" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingCoverageRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingCoverageAssignment" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "bankerId" TEXT NOT NULL,
    "coverageRole" TEXT NOT NULL DEFAULT 'Support',
    "assignmentStatus" TEXT NOT NULL DEFAULT 'Approved',
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "assignedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingCoverageAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingCube" (
    "id" TEXT NOT NULL,
    "conferenceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "restrictions" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingCube_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CubeAvailability" (
    "id" TEXT NOT NULL,
    "cubeId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Available',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CubeAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingCubeAssignment" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "cubeId" TEXT NOT NULL,
    "assignmentStatus" TEXT NOT NULL DEFAULT 'Approved',
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "assignedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingCubeAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationRun" (
    "id" TEXT NOT NULL,
    "conferenceId" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "runTimestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runStatus" TEXT NOT NULL DEFAULT 'Proposed',
    "objectiveScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "summary" JSONB NOT NULL,

    CONSTRAINT "AllocationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationProposal" (
    "id" TEXT NOT NULL,
    "allocationRunId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "proposedBankerIds" TEXT[],
    "proposedCubeId" TEXT,
    "validationStatus" TEXT NOT NULL,
    "preferenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "explanation" TEXT NOT NULL,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AllocationProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankerPreference_conferenceId_bankerId_idx" ON "BankerPreference"("conferenceId", "bankerId");

-- CreateIndex
CREATE INDEX "BankerPreference_meetingId_idx" ON "BankerPreference"("meetingId");

-- CreateIndex
CREATE INDEX "BankerAvailability_conferenceId_bankerId_idx" ON "BankerAvailability"("conferenceId", "bankerId");

-- CreateIndex
CREATE UNIQUE INDEX "IssuerCoverageAuthorization_conferenceId_bankerId_issuerId_key" ON "IssuerCoverageAuthorization"("conferenceId", "bankerId", "issuerId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingCoverageRequirement_meetingId_key" ON "MeetingCoverageRequirement"("meetingId");

-- CreateIndex
CREATE INDEX "MeetingCoverageAssignment_bankerId_idx" ON "MeetingCoverageAssignment"("bankerId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingCoverageAssignment_meetingId_bankerId_key" ON "MeetingCoverageAssignment"("meetingId", "bankerId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingCube_conferenceId_name_key" ON "MeetingCube"("conferenceId", "name");

-- CreateIndex
CREATE INDEX "CubeAvailability_cubeId_idx" ON "CubeAvailability"("cubeId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingCubeAssignment_meetingId_key" ON "MeetingCubeAssignment"("meetingId");

-- CreateIndex
CREATE INDEX "MeetingCubeAssignment_cubeId_idx" ON "MeetingCubeAssignment"("cubeId");

-- CreateIndex
CREATE INDEX "AllocationRun_conferenceId_runTimestamp_idx" ON "AllocationRun"("conferenceId", "runTimestamp");

-- CreateIndex
CREATE INDEX "AllocationProposal_meetingId_idx" ON "AllocationProposal"("meetingId");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationProposal_allocationRunId_meetingId_key" ON "AllocationProposal"("allocationRunId", "meetingId");
