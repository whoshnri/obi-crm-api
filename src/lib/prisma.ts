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
  idleTimeoutMillis: 15_000,
  connectionTimeoutMillis: 40_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
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
  if (typeof code === "string" && TRANSIENT_DATABASE_ERROR_CODES.has(code)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Connection terminated") ||
    message.includes("timeout") ||
    message.includes("unexpectedly")
  ) {
    return true;
  }

  if (error && typeof error === "object" && "cause" in error && error.cause) {
    const causeMsg = error.cause instanceof Error ? error.cause.message : String(error.cause);
    if (
      causeMsg.includes("Connection terminated") ||
      causeMsg.includes("timeout") ||
      causeMsg.includes("unexpectedly")
    ) {
      return true;
    }
  }

  return false;
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
