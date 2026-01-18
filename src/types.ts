export type OrderStatus =
    | "pending" | "routing" | "building" | "submitted" | "confirmed" | "failed";

export type OrderType = "MARKET";

export type ExecuteOrderRequest = {
    type: OrderType;
    tokenIn: string;
    tokenOut: string;
    amountIn: number;       // keep number in API; store numeric in DB
    slippageBps: number;    // e.g. 50 = 0.5%
};

export type Quote = {
    dex: "raydium" | "meteora";
    price: number; // tokenOut per 1 tokenIn
    fee: number;   // e.g. 0.003
};

export type ExecutionResult = {
    txHash: string;
    executedPrice: number;
};