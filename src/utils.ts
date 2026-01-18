export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const nowIso = () => new Date().toISOString();

export const toWSolIfNeeded = (mint: string) =>
    mint.toUpperCase() === "SOL" ? "wSOL" : mint;

export const makeMockTxHash = () =>
    "MOCK_" + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);