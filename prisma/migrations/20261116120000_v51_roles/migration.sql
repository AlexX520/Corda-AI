-- v5.1: conference coordinators (only they and managers act on the schedule); extra sender addresses per company.
ALTER TABLE "User" ADD COLUMN "coordinator" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Issuer" ADD COLUMN "extraContacts" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Investor" ADD COLUMN "extraContacts" TEXT[] DEFAULT ARRAY[]::TEXT[];
-- Existing installs: every banker stays able to act until a manager picks the coordinators.
UPDATE "User" SET "coordinator" = true WHERE "role" = 'BANKER';
