import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is required");
}

const globalForRedis = globalThis as unknown as {
  redis?: Redis;
  redisConnectPromise?: Promise<void> | null;
};

export const redis =
  globalForRedis.redis ??
  new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    retryStrategy(times) {
      if (times >= 2) {
        return null;
      }
      return Math.min(times * 250, 500);
    }
  });

redis.on("error", (error) => {
  console.error("[redis:error]", JSON.stringify({ message: error.message }));
});

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}

async function ensureRedisConnected() {
  if (redis.status === "ready" || redis.status === "connect") {
    return;
  }

  if (!globalForRedis.redisConnectPromise) {
    globalForRedis.redisConnectPromise = redis.connect().finally(() => {
      globalForRedis.redisConnectPromise = null;
    });
  }

  await globalForRedis.redisConnectPromise;
}

function isRedisUnavailableError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const message = "message" in error ? (error as { message?: unknown }).message : undefined;

  if (typeof code === "string" && ["ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return true;
  }

  return typeof message === "string" && message.toLowerCase().includes("connect timeout");
}

export async function withRedisFallback<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    await ensureRedisConnected();
    return await operation();
  } catch (error) {
    if (!isRedisUnavailableError(error)) {
      throw error;
    }

    console.error(
      "[redis:fallback]",
      JSON.stringify({
        message: error instanceof Error ? error.message : "Redis unavailable"
      })
    );

    return fallback;
  }
}
