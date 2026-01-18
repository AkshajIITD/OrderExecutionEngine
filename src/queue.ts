import { Queue } from "bullmq";
import { bullConnection } from "./bullConnection.js";

export const ordersQueue = new Queue("orders", {
    connection: bullConnection(),
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 500 },
    },
});
