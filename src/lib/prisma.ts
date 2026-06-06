import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 40_000,
  connectionTimeoutMillis: 40_000,
  ssl: {
    rejectUnauthorized: true,
  },
});

pool.on("error", (error) => {
  console.error(
    "[db:pool]",
    JSON.stringify({
      errorName: error.name,
      message: error.message,
      code: (error as { code?: string }).code,
    }),
  );
});

const adapter = new PrismaPg(pool);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

const TRANSIENT_DATABASE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED"
]);

export function getDatabaseErrorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }

  return undefined;
}

export function isTransientDatabaseError(error: unknown) {
  const code = getDatabaseErrorCode(error);
  return typeof code === "string" && TRANSIENT_DATABASE_ERROR_CODES.has(code);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryDatabaseOperation<T>(
  operation: () => Promise<T>,
  {
    retries = 2,
    delayMs = 350
  }: {
    retries?: number;
    delayMs?: number;
  } = {}
) {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientDatabaseError(error) || attempt >= retries) {
        throw error;
      }

      await sleep(delayMs * (attempt + 1));
      attempt += 1;
    }
  }
}
