-- v4 Phase 3: event types, manager metrics (time-to-confirm, edits on review).
ALTER TABLE "Conference" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'Conference';
ALTER TABLE "Meeting" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Proposal" ADD COLUMN "editedOnReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Proposal" ADD COLUMN "reviewedAt" TIMESTAMP(3);
