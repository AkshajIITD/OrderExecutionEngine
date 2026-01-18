import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { bullConnection } from "./bullConnection.js";
import { MockDexRouter } from "./mockDexRouter.js";
import { publishStatus } from "./redis.js";
import { addEvent, getOrder, updateOrder } from "./db.js";
import { toWSolIfNeeded } from "./utils.js";

type JobData = { orderId: string };

const router = new MockDexRouter();

function bestQuote(amountIn: number, q1: any, q2: any) {
    const out1 = amountIn * q1.price * (1 - q1.fee);
    const out2 = amountIn * q2.price * (1 - q2.fee);
    return out2 > out1 ? q2 : q1;
}

function isFinalAttempt(job: Job<JobData>, err: Error) {
    const total = job.opts.attempts ?? 1;
    const used = job.attemptsMade + 1; // attemptsMade = completed attempts; +1 includes current
    return used >= total;
}

export const worker = new Worker<JobData>(
    "orders",
    async (job) => {
        const { orderId } = job.data;

        const order = await getOrder(orderId);
        if (!order) throw new Error("Order not found");

        const tokenIn = toWSolIfNeeded(order.token_in);
        const tokenOut = toWSolIfNeeded(order.token_out);
        const amountIn = Number(order.amount_in);

        // pending -> routing
        await publishStatus(orderId, "routing");
        await updateOrder(orderId, { status: "routing" });
        await addEvent(orderId, "routing");

        // fetch quotes
        const [rQuote, mQuote] = await Promise.all([
            router.getRaydiumQuote(tokenIn, tokenOut, amountIn),
            router.getMeteoraQuote(tokenIn, tokenOut, amountIn),
        ]);

        const chosen = bestQuote(amountIn, rQuote, mQuote);

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

        // compute slippage minOut
        const slippage = Number(order.slippage_bps) / 10_000;
        const expectedOut = amountIn * chosen.price;
        const minOut = expectedOut * (1 - slippage);

        // building -> submitted
        await publishStatus(orderId, "submitted", { minOut });
        await updateOrder(orderId, { status: "submitted" });
        await addEvent(orderId, "submitted", { minOut });

        // execute swap
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
    const made = job.attemptsMade; // IMPORTANT: already incremented

    const isFinal = made >= total;

    if (!isFinal) {
        // intermediate failure -> DON'T mark order failed
        await addEvent(orderId, "retrying", { error: err.message, attempt: made, total });
        await publishStatus(orderId, "retrying", { error: err.message, attempt: made, total });
        return;
    }

    // final failure only
    await publishStatus(orderId, "failed", { error: err.message });
    await updateOrder(orderId, { status: "failed", error: err.message });
    await addEvent(orderId, "failed", { error: err.message });
});