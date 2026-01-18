import { Pool } from "pg";
import type { OrderStatus } from "./types.js";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function createOrder(params: {
    id: string;
    type: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: number;
    slippageBps: number;
    status: OrderStatus;
}) {
    await pool.query(
        `INSERT INTO orders(id,type,token_in,token_out,amount_in,slippage_bps,status)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
            params.id,
            params.type,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            params.slippageBps,
            params.status,
        ]
    );
}

export async function updateOrder(orderId: string, patch: Record<string, any>) {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;

    const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
    const values = keys.map((k) => patch[k]);

    await pool.query(
        `UPDATE orders SET ${sets}, updated_at=now() WHERE id=$1`,
        [orderId, ...values]
    );
}

export async function addEvent(orderId: string, status: OrderStatus | string, payload: any = {}) {
    await pool.query(
        `INSERT INTO order_events(order_id,status,payload) VALUES($1,$2,$3::jsonb)`,
        [orderId, status, JSON.stringify(payload)]
    );
}

export async function getOrder(orderId: string) {
    const r = await pool.query(`SELECT * FROM orders WHERE id=$1`, [orderId]);
    return r.rows[0] ?? null;
}

export async function listOrderEvents(orderId: string) {
    const r = await pool.query(
        `SELECT status, payload, created_at
       FROM order_events
       WHERE order_id=$1
       ORDER BY id ASC`,
        [orderId]
    );
    return r.rows;
}