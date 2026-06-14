ALTER TABLE "Event"
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "executionMetadata" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX "Event_status_scheduledAt_idx" ON "Event"("status", "scheduledAt");
