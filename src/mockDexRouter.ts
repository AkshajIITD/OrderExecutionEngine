import { sleep, makeMockTxHash } from "./utils.js";
import type { Quote, ExecutionResult, ExecuteOrderRequest } from "./types.js";

type RNG = () => number;

export class MockDexRouter {
    private rng: RNG;
    private failRate: number;

    constructor(
        private basePrice = 10,
        opts?: { rng?: RNG; failRate?: number }
    ) {
        this.rng = opts?.rng ?? Math.random;
        // Prefer env var if set, else opts, else 0
        const envRate = process.env.MOCK_FAIL_RATE ? Number(process.env.MOCK_FAIL_RATE) : undefined;
        this.failRate = Number.isFinite(envRate)
            ? (envRate as number)
            : (opts?.failRate ?? 0);
    }

    private maybeFail(stage: string) {
        if (this.failRate <= 0) return;
        if (this.rng() < this.failRate) {
            throw new Error(`MOCK_FAIL:${stage}`);
        }
    }

    async getRaydiumQuote(_: string, __: string, ___: number): Promise<Quote> {
        await sleep(200);
        this.maybeFail("quote_raydium");
        const price = this.basePrice * (0.98 + this.rng() * 0.04);
        return { dex: "raydium", price, fee: 0.003 };
    }

    async getMeteoraQuote(_: string, __: string, ___: number): Promise<Quote> {
        await sleep(200);
        this.maybeFail("quote_meteora");
        const price = this.basePrice * (0.97 + this.rng() * 0.05);
        return { dex: "meteora", price, fee: 0.002 };
    }

    async executeSwap(
        dex: Quote["dex"],
        _order: ExecuteOrderRequest,
        finalPrice: number
    ): Promise<ExecutionResult> {
        await sleep(2000 + this.rng() * 1000);
        this.maybeFail(`swap_${dex}`);
        return { txHash: makeMockTxHash(), executedPrice: finalPrice };
    }
}