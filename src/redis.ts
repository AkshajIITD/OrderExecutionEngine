import Redis from "ioredis";

export const redis = new (Redis as any)(process.env.REDIS_URL!);
export const redisSub = new (Redis as any)(process.env.REDIS_URL!);

export const statusChannel = (orderId: string) => `order:status:${orderId}`;

export type StatusEvent = {
    orderId: string;
    status: string;
    at: string;
    data?: any;
};

export async function publishStatus(orderId: string, status: string, data?: any) {
    const evt: StatusEvent = { orderId, status, at: new Date().toISOString(), data };
    await redis.publish(statusChannel(orderId), JSON.stringify(evt));
    await redis.hset(`order:${orderId}`, { status, updatedAt: evt.at }); // “active orders” cache
}