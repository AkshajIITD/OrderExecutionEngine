export type Quote = { dex: "raydium" | "meteora"; price: number; fee: number };

export function chooseBestQuote(quotes: Record<Quote["dex"], Quote>) {
    const net = (q: Quote) => q.price * (1 - q.fee);
    return net(quotes.raydium) >= net(quotes.meteora) ? quotes.raydium : quotes.meteora;
}