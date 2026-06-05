/**
 * Backfill Organisation rows from Participant.organisation strings.
 * Run after migration: bun prisma/scripts/backfill-organisations.ts
 */
import "dotenv/config";
import { PrismaClient } from "../../src/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? undefined
    : { rejectUnauthorized: true },
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "org"
  );
}

async function main() {
  const participants = await prisma.participant.findMany({
    where: { organisation: { not: null } },
    select: { id: true, organisation: true },
  });

  const byName = new Map<string, string[]>();
  for (const p of participants) {
    const name = p.organisation?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const ids = byName.get(key) ?? [];
    ids.push(p.id);
    byName.set(key, ids);
  }

  let orgsCreated = 0;
  let linksCreated = 0;

  for (const [key, participantIds] of byName) {
    const displayName =
      participants.find(
        (p) => p.organisation?.trim().toLowerCase() === key,
      )?.organisation?.trim() ?? key;

    let slug = slugify(displayName);
    let suffix = 0;
    while (await prisma.organisation.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${slugify(displayName)}-${suffix}`;
    }

    const org = await prisma.organisation.create({
      data: { name: displayName, slug },
    });
    orgsCreated += 1;

    for (const participantId of participantIds) {
      const existing = await prisma.organisationParticipant.findUnique({
        where: {
          organisationId_participantId: {
            organisationId: org.id,
            participantId,
          },
        },
      });
      if (existing) continue;

      await prisma.organisationParticipant.create({
        data: {
          organisationId: org.id,
          participantId,
          isPrimary: true,
        },
      });
      linksCreated += 1;
    }
  }

  console.log(
    `Backfill complete: ${orgsCreated} organisations, ${linksCreated} links`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
