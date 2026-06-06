ALTER TYPE "DeliverableStatus" RENAME TO "DeliverableStatus_old";

CREATE TYPE "DeliverableStatus" AS ENUM ('pending', 'delivered');
CREATE TYPE "DeliverableDeliveryChannel" AS ENUM ('email', 'resource_folder');

ALTER TABLE "Deliverable"
  ADD COLUMN "deliveryChannel" "DeliverableDeliveryChannel";

ALTER TABLE "Deliverable"
  ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Deliverable"
  ALTER COLUMN "status" TYPE "DeliverableStatus"
  USING (
    CASE
      WHEN "status"::text = 'pending' THEN 'pending'::"DeliverableStatus"
      ELSE 'delivered'::"DeliverableStatus"
    END
  );

ALTER TABLE "Deliverable"
  ALTER COLUMN "status" SET DEFAULT 'pending';

UPDATE "Deliverable"
SET "deliveryChannel" =
  CASE
    WHEN "status" = 'delivered' AND "url" IS NOT NULL THEN 'resource_folder'::"DeliverableDeliveryChannel"
    WHEN "status" = 'delivered' THEN 'email'::"DeliverableDeliveryChannel"
    ELSE NULL
  END;

ALTER TABLE "Deliverable"
  DROP COLUMN "acknowledgedAt";

DROP TYPE "DeliverableStatus_old";
