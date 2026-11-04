-- v4 Phase 2: exports remember which meetings they contained ("changed since last sent").
ALTER TABLE "ExportLog" ADD COLUMN "meetingIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
