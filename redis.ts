import Redis from "ioredis";
import { config } from "../config/index.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("redis");

export const redis = new Redis(config.db.redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 200, 3000),
});

redis.on("error", (err) => log.error({ err: err.message }, "Redis connection error"));
redis.on("connect", () => log.info("Connected to Redis"));

/** JSON get/set helpers with TTL — used to cache analysis results so a
 * token that gets re-mentioned within the TTL window doesn't trigger a
 * full re-analysis (X/Telegram calls in particular are rate-limited and
 * not free). */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number) {
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Rolling counter used e.g. for Telegram message-rate sampling — pushes a
 * timestamp and trims anything older than `windowSeconds`. */
export async function pushTimeseriesEvent(key: string, windowSeconds: number) {
  const now = Date.now();
  const pipeline = redis.pipeline();
  pipeline.zadd(key, now, `${now}-${Math.random()}`);
  pipeline.zremrangebyscore(key, 0, now - windowSeconds * 1000);
  pipeline.expire(key, windowSeconds * 2);
  await pipeline.exec();
}

export async function countTimeseriesEvents(key: string, windowSeconds: number): Promise<number> {
  const now = Date.now();
  return redis.zcount(key, now - windowSeconds * 1000, now);
}
