ALTER TABLE "Programme" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';

UPDATE "Programme"
SET "metadata" = COALESCE("participantDefinition"->'setup', '{}'::jsonb)
WHERE "participantDefinition" IS NOT NULL
  AND jsonb_typeof("participantDefinition") = 'object';

ALTER TABLE "Programme" DROP COLUMN "participantDefinition";
