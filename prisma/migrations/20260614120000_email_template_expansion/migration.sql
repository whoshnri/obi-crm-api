ALTER TABLE "EmailTemplate"
  ADD COLUMN "label" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "fromName" TEXT,
  ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "EmailTemplate_programmeId_idx" ON "EmailTemplate"("programmeId");
