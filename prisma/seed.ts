import 'dotenv/config'
import { PrismaClient, AdminRole } from "../src/generated/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { hash } from "argon2";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = "henry@obijames.com";
  const password = await hash("as5XIUdc");

  const admin = await prisma.admin.upsert({
    where: { email },
    update: {},
    create: {
      name: "Henry Bassey",
      email,
      password,
      role: AdminRole.super,
    },
  });

  console.log("Seeded admin:", admin.email);
}

main()
  .catch(console.error)
  .finally(async () => {
    await pool.end();
    await prisma.$disconnect();
  });