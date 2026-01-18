import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks (must be declared before importing app) ----
const mockCreateOrder = vi.fn();
const mockGetOrder = vi.fn();
const mockListOrderEvents = vi.fn();
const mockAddEvent = vi.fn();

vi.mock("../src/db.js", () => ({
    createOrder: (...args: any[]) => mockCreateOrder(...args),
    getOrder: (...args: any[]) => mockGetOrder(...args),
    listOrderEvents: (...args: any[]) => mockListOrderEvents(...args),
    addEvent: (...args: any[]) => mockAddEvent(...args),
}));

const mockQueueAdd = vi.fn();
vi.mock("../src/queue.js", () => ({
    ordersQueue: { add: (...args: any[]) => mockQueueAdd(...args) },
}));

const mockPublishStatus = vi.fn();
vi.mock("../src/redis.js", () => ({
    publishStatus: (...args: any[]) => mockPublishStatus(...args),
    statusChannel: (orderId: string) => `order:status:${orderId}`,
}));

// Mock ioredis constructor used in WS handler
vi.mock("ioredis", () => {
    class FakeRedis {
        subscribe = vi.fn(async (_chan: string) => { });
        on = vi.fn((_evt: string, _cb: any) => { });
        unsubscribe = vi.fn(async (_chan: string) => { });
        quit = vi.fn(async () => { });
    }
    return { default: FakeRedis };
});

// Now import app builder + ws handler + routing helper
import { buildApp, handleOrderWs } from "../src/app.js";
import { chooseBestQuote } from "../src/routing.js";

describe("Order Execution Engine - mock tests", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.REDIS_URL = "redis://localhost:6379";
    });

    // ---- ROUTING LOGIC (2 tests) ----
    it("chooseBestQuote: picks raydium when net price is higher higher", () => {
        const chosen = chooseBestQuote({
            raydium: { dex: "raydium", price: 10.0, fee: 0.003 },
            meteora: { dex: "meteora", price: 9.98, fee: 0.002 },
        });
        expect(chosen.dex).toBe("raydium");
    });

    it("chooseBestQuote: picks meteora when net price is higher", () => {
        const chosen = chooseBestQuote({
            raydium: { dex: "raydium", price: 10.0, fee: 0.003 },
            meteora: { dex: "meteora", price: 10.02, fee: 0.002 },
        });
        expect(chosen.dex).toBe("meteora");
    });

    // ---- HTTP API (6 tests) ----
    it("POST /api/orders/execute returns 400 on invalid body", async () => {
        const app = await buildApp();
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/api/orders/execute",
            payload: { hello: "world" },
        });

        expect(res.statusCode).toBe(400);
        await app.close();
    });

    it("POST /api/orders/execute returns 400 on negative amountIn", async () => {
        const app = await buildApp();
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/api/orders/execute",
            payload: {
                type: "MARKET",
                tokenIn: "SOL",
                tokenOut: "USDC",
                amountIn: -1,
                slippageBps: 50,
            },
        });

        expect(res.statusCode).toBe(400);
        await app.close();
    });

    it("POST /api/orders/execute returns 400 on slippageBps > 5000", async () => {
        const app = await buildApp();
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/api/orders/execute",
            payload: {
                type: "MARKET",
                tokenIn: "SOL",
                tokenOut: "USDC",
                amountIn: 1,
                slippageBps: 6000,
            },
        });

        expect(res.statusCode).toBe(400);
        await app.close();
    });

    it("POST /api/orders/execute returns 200 and orderId", async () => {
        mockCreateOrder.mockResolvedValueOnce(undefined);
        mockQueueAdd.mockResolvedValueOnce(undefined);
        mockPublishStatus.mockResolvedValueOnce(undefined);
        mockAddEvent.mockResolvedValueOnce(undefined);

        const app = await buildApp();
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/api/orders/execute",
            payload: {
                type: "MARKET",
                tokenIn: "SOL",
                tokenOut: "USDC",
                amountIn: 1,
                slippageBps: 50,
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.orderId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );

        await app.close();
    });

    it("POST /api/orders/execute enqueues job + writes pending order/event", async () => {
        mockCreateOrder.mockResolvedValueOnce(undefined);
        mockQueueAdd.mockResolvedValueOnce(undefined);
        mockPublishStatus.mockResolvedValueOnce(undefined);
        mockAddEvent.mockResolvedValueOnce(undefined);

        const app = await buildApp();
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/api/orders/execute",
            payload: {
                type: "MARKET",
                tokenIn: "SOL",
                tokenOut: "USDC",
                amountIn: 1,
                slippageBps: 50,
            },
        });

        const { orderId } = res.json();

        expect(mockCreateOrder).toHaveBeenCalledTimes(1);
        expect(mockQueueAdd).toHaveBeenCalledWith("execute", { orderId });
        expect(mockPublishStatus).toHaveBeenCalledWith(orderId, "pending");
        expect(mockAddEvent).toHaveBeenCalledWith(orderId, "pending");

        await app.close();
    });

    it("GET /api/orders/:id returns 404 when not found", async () => {
        mockGetOrder.mockResolvedValueOnce(null);

        const app = await buildApp();
        await app.ready();

        const res = await app.inject({ method: "GET", url: "/api/orders/does-not-exist" });
        expect(res.statusCode).toBe(404);

        await app.close();
    });

    it("GET /api/orders/:id returns order snapshot", async () => {
        mockGetOrder.mockResolvedValueOnce({ id: "x", status: "confirmed" });

        const app = await buildApp();
        await app.ready();

        const res = await app.inject({ method: "GET", url: "/api/orders/x" });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ id: "x", status: "confirmed" });

        await app.close();
    });

    // ---- WEBSOCKET LIFECYCLE (2 tests, via handler unit test) ----
    it("WS handler: missing orderId sends error + closes", async () => {
        const socket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
        const req = { url: "/api/orders/execute", headers: { host: "localhost:3000" } };

        await handleOrderWs(socket, req);

        expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ error: "orderId query param required" }));
        expect(socket.close).toHaveBeenCalled();
    });

    it("WS handler: replays event history before subscribing", async () => {
        mockListOrderEvents.mockResolvedValueOnce([
            { status: "pending", created_at: new Date("2026-01-01T00:00:00Z").toISOString(), payload: {} },
            { status: "routing", created_at: new Date("2026-01-01T00:00:01Z").toISOString(), payload: { chosenDex: "raydium" } },
        ]);

        const socket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
        const req = {
            url: "/api/orders/execute?orderId=abc",
            headers: { host: "localhost:3000" },
        };

        await handleOrderWs(socket, req);

        // Should send 2 replay messages
        expect(socket.send).toHaveBeenCalledTimes(2);

        const first = JSON.parse((socket.send as any).mock.calls[0][0]);
        expect(first.orderId).toBe("abc");
        expect(first.data.replay).toBe(true);
        expect(first.status).toBe("pending");

        const second = JSON.parse((socket.send as any).mock.calls[1][0]);
        expect(second.status).toBe("routing");
        expect(second.data.replay).toBe(true);
        expect(second.data.chosenDex).toBe("raydium");
    });
});