import "dotenv/config";
import { Worker, type Job } from "bullmq";
import pino from "pino";
import { bullConnection } from "./bullConnection.js";
import { MockDexRouter } from "./mockDexRouter.js";
import { publishStatus } from "./redis.js";
import { addEvent, getOrder, updateOrder } from "./db.js";
import { toWSolIfNeeded } from "./utils.js";

type JobData = { orderId: string };

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const router = new MockDexRouter();

function bestQuote(amountIn: number, q1: any, q2: any) {
    const out1 = amountIn * q1.price * (1 - q1.fee);
    const out2 = amountIn * q2.price * (1 - q2.fee);
    return out2 > out1 ? q2 : q1;
}

export const worker = new Worker<JobData>(
    "orders",
    async (job) => {
        const t0 = Date.now();
        const { orderId } = job.data;

        // BullMQ attempt info (attemptsMade is completed attempts so far)
        const totalAttempts = job.opts.attempts ?? 1;
        const attempt = job.attemptsMade + 1;

        log.info(
            { orderId, jobId: job.id, attempt, totalAttempts },
            "job.start"
        );

        const order = await getOrder(orderId);
        if (!order) {
            log.error({ orderId }, "job.error.order_not_found");
            throw new Error("Order not found");
        }

        const tokenIn = toWSolIfNeeded(order.token_in);
        const tokenOut = toWSolIfNeeded(order.token_out);
        const amountIn = Number(order.amount_in);

        log.info(
            { orderId, type: order.type, tokenIn, tokenOut, amountIn, slippageBps: order.slippage_bps },
            "order.loaded"
        );

        // pending -> routing
        await publishStatus(orderId, "routing");
        await updateOrder(orderId, { status: "routing" });
        await addEvent(orderId, "routing");

        log.info({ orderId }, "status.routing");

        // fetch quotes
        const qStart = Date.now();
        const [rQuote, mQuote] = await Promise.all([
            router.getRaydiumQuote(tokenIn, tokenOut, amountIn),
            router.getMeteoraQuote(tokenIn, tokenOut, amountIn),
        ]);

        // compute net outs for transparency in logs
        const rNetOut = amountIn * rQuote.price * (1 - rQuote.fee);
        const mNetOut = amountIn * mQuote.price * (1 - mQuote.fee);
        const chosen = bestQuote(amountIn, rQuote, mQuote);

        log.info(
            {
                orderId,
                ms: Date.now() - qStart,
                quotes: {
                    raydium: { price: rQuote.price, fee: rQuote.fee, netOut: rNetOut },
                    meteora: { price: mQuote.price, fee: mQuote.fee, netOut: mNetOut },
                },
                chosen: { dex: chosen.dex, price: chosen.price, fee: chosen.fee },
            },
            "routing.decision"
        );

        await updateOrder(orderId, {
            chosen_dex: chosen.dex,
            expected_price: chosen.price,
        });

        await addEvent(orderId, "routing", {
            quotes: { raydium: rQuote, meteora: mQuote },
            chosen,
        });

        // routing -> building
        await publishStatus(orderId, "building", { chosenDex: chosen.dex });
        await updateOrder(orderId, { status: "building" });
        await addEvent(orderId, "building", { chosenDex: chosen.dex });

        log.info({ orderId, chosenDex: chosen.dex }, "status.building");

        // compute slippage minOut
        const slippage = Number(order.slippage_bps) / 10_000;
        const expectedOut = amountIn * chosen.price;
        const minOut = expectedOut * (1 - slippage);

        log.info(
            { orderId, slippage, expectedOut, minOut },
            "slippage.computed"
        );

        // building -> submitted
        await publishStatus(orderId, "submitted", { minOut });
        await updateOrder(orderId, { status: "submitted" });
        await addEvent(orderId, "submitted", { minOut });

        log.info({ orderId, minOut }, "status.submitted");

        // execute swap
        log.info({ orderId, dex: chosen.dex }, "swap.execute.start");

        const res = await router.executeSwap(
            chosen.dex,
            {
                type: "MARKET",
                tokenIn: order.token_in,
                tokenOut: order.token_out,
                amountIn,
                slippageBps: Number(order.slippage_bps),
            },
            chosen.price
        );

        log.info(
            { orderId, dex: chosen.dex, txHash: res.txHash, executedPrice: res.executedPrice },
            "swap.execute.done"
        );

        // submitted -> confirmed
        await publishStatus(orderId, "confirmed", {
            txHash: res.txHash,
            executedPrice: res.executedPrice,
        });

        await updateOrder(orderId, {
            status: "confirmed",
            tx_hash: res.txHash,
            executed_price: res.executedPrice,
        });

        await addEvent(orderId, "confirmed", {
            txHash: res.txHash,
            executedPrice: res.executedPrice,
        });

        log.info(
            { orderId, txHash: res.txHash, executedPrice: res.executedPrice, ms: Date.now() - t0 },
            "job.success"
        );

        return { ok: true, txHash: res.txHash };
    },
    {
        connection: bullConnection(),
        concurrency: 10,
        limiter: { max: 100, duration: 60_000 },
    }
);

worker.on("failed", async (job, err) => {
    if (!job) return;

    const orderId = (job.data as any).orderId as string;

    const total = job.opts.attempts ?? 1;
    const made = job.attemptsMade; // already incremented by BullMQ

    const isFinal = made >= total;

    if (!isFinal) {
        log.warn(
            { orderId, jobId: job.id, attempt: made, total, error: err.message },
            "job.retrying"
        );

        await addEvent(orderId, "retrying", { error: err.message, attempt: made, total });
        await publishStatus(orderId, "retrying", { error: err.message, attempt: made, total });
        return;
    }

    log.error(
        { orderId, jobId: job.id, attempt: made, total, error: err.message },
        "job.failed.final"
    );

    await publishStatus(orderId, "failed", { error: err.message });
    await updateOrder(orderId, { status: "failed", error: err.message });
    await addEvent(orderId, "failed", { error: err.message });
});