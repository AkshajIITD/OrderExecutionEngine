import "dotenv/config";
import type { ConnectionOptions } from "bullmq";

export function bullConnection(): ConnectionOptions {
    const u = new URL(process.env.REDIS_URL!);

    return {
        host: u.hostname,
        port: Number(u.port || 6379),
        username: u.username || undefined,
        password: u.password || undefined,

        // REQUIRED by BullMQ (prevents worker crash)
        maxRetriesPerRequest: null,
    };
}