import Redis from "ioredis";

const redisUrl = Bun.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is required");
}

const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: false
  });

redis.on("error", (error) => {
  console.error("[redis:error]", JSON.stringify({ message: error.message }));
});

if (Bun.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
