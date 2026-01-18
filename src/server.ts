import "dotenv/config";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";

import { ordersQueue } from "./queue.js";
import { createOrder, getOrder, listOrderEvents, addEvent } from "./db.js";
import { statusChannel, publishStatus } from "./redis.js";

const app = Fastify({ logger: true });
await app.register(websocket);

const orderSchema = z.object({
    type: z.literal("MARKET"),
    tokenIn: z.string().min(1),
    tokenOut: z.string().min(1),
    amountIn: z.number().positive(),
    slippageBps: z.number().int().min(0).max(5000)
});

app.post("/api/orders/execute", async (req, reply) => {
    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const orderId = uuidv4();

    await createOrder({
        id: orderId,
        type: parsed.data.type,
        tokenIn: parsed.data.tokenIn,
        tokenOut: parsed.data.tokenOut,
        amountIn: parsed.data.amountIn,
        slippageBps: parsed.data.slippageBps,
        status: "pending"
    });

    await ordersQueue.add("execute", { orderId });
    await publishStatus(orderId, "pending");
    await addEvent(orderId, "pending");

    return reply.send({ orderId });
});

// WebSocket MUST be GET
app.get("/api/orders/execute", { websocket: true }, async (socket, req) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const orderId = url.searchParams.get("orderId");

    if (!orderId) {
        socket.send(JSON.stringify({ error: "orderId query param required" }));
        socket.close();
        return;
    }

    // 1) Replay full history first (so demo always shows full lifecycle)
    const events = await listOrderEvents(orderId);
    for (const e of events) {
        socket.send(
            JSON.stringify({
                orderId,
                status: e.status,
                at: new Date(e.created_at).toISOString(),
                data: { replay: true, ...(e.payload ?? {}) }
            })
        );
    }

    // 2) Then subscribe to live updates
    const sub = new (Redis as any)(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    const chan = statusChannel(orderId);

    await sub.subscribe(chan);
    sub.on("message", (_channel: string, payload: string) => socket.send(payload));

    socket.on("close", async () => {
        try { await sub.unsubscribe(chan); } catch { }
        try { await sub.quit(); } catch { }
    });
});

app.get("/health", async () => ({ ok: true }));


app.get("/api/orders/:id", async (req, reply) => {
    const id = (req.params as any).id as string;
    const order = await getOrder(id);
    if (!order) return reply.code(404).send({ error: "Order not found" });
    return reply.send(order);
});

app.get("/api/orders/:id/events", async (req, reply) => {
    const id = (req.params as any).id as string;
    const events = await listOrderEvents(id);
    return reply.send({ orderId: id, events });
});

app.ready().then(() => app.printRoutes());

app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });