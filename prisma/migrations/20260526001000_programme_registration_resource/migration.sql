ALTER TABLE "Programme" ADD COLUMN "registrationResourceId" TEXT;

CREATE UNIQUE INDEX "Programme_registrationResourceId_key" ON "Programme"("registrationResourceId");

ALTER TABLE "Programme"
ADD CONSTRAINT "Programme_registrationResourceId_fkey"
FOREIGN KEY ("registrationResourceId") REFERENCES "ProgrammeResource"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
