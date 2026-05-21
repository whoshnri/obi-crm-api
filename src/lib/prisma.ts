import 'dotenv/config'
import { PrismaClient } from "../generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

if (!Bun.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new pg.Pool({
  connectionString: Bun.env.DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 40_000,
  connectionTimeoutMillis: 40_000,
  ssl: {
    rejectUnauthorized: true  // equivalent to verify-full
  }
});

pool.on("error", (error) => {
  console.error(
    "[db:pool]",
    JSON.stringify({
      errorName: error.name,
      message: error.message,
      code: (error as { code?: string }).code
    })
  );
});

const adapter = new PrismaPg(pool);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter
  });

if (Bun.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
