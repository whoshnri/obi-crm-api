CREATE TYPE "AdminMagicLinkPurpose" AS ENUM ('sign_in', 'reset_password');

ALTER TABLE "Admin"
ALTER COLUMN "password" DROP NOT NULL;

CREATE TABLE "AdminMagicLink" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "AdminMagicLinkPurpose" NOT NULL DEFAULT 'sign_in',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMagicLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminMagicLink_tokenHash_key" ON "AdminMagicLink"("tokenHash");
CREATE INDEX "AdminMagicLink_adminId_idx" ON "AdminMagicLink"("adminId");
CREATE INDEX "AdminMagicLink_expiresAt_idx" ON "AdminMagicLink"("expiresAt");

ALTER TABLE "AdminMagicLink"
ADD CONSTRAINT "AdminMagicLink_adminId_fkey"
FOREIGN KEY ("adminId") REFERENCES "Admin"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
