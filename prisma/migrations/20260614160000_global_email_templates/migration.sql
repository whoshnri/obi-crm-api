-- Make email templates global (programmeId optional).
ALTER TABLE "EmailTemplate" ALTER COLUMN "programmeId" DROP NOT NULL;
