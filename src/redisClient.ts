import "dotenv/config";
import RedisImport from "ioredis";
import type { RedisOptions, Redis as RedisInstance } from "ioredis";

// Keep the escape hatch here only
const RedisCtor = RedisImport as unknown as new (
    url: string,
    opts?: RedisOptions
) => RedisInstance;

export function createRedis(opts: RedisOptions = {}) {
    return new RedisCtor(process.env.REDIS_URL!, {
        maxRetriesPerRequest: null, // REQUIRED by BullMQ
        ...opts,
    });
}