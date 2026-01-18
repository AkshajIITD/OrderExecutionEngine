## Order Execution Engine (Backend Task)

A minimal order execution engine that:

- Accepts **MARKET** orders via HTTP
- Executes asynchronously via a **BullMQ** worker
- Persists order + event history in **Postgres**
- Streams status updates via **WebSocket** (history replay + live updates)
- Supports retries/failures (**BullMQ attempts**) + mock DEX failures

---

## Tech Stack

- **Fastify** + `@fastify/websocket`
- **BullMQ** (Redis-backed queue)
- **Postgres** (durable storage: `orders`, `order_events`)
- **Redis** (BullMQ backend + pub/sub for WS)
- **TypeScript** (ESM)

---

## Prerequisites

- **Node.js** (recommended: 20+)
- **Docker** + **Docker Compose**
- **wscat** (used via `npx wscat`)

Optional (only needed to apply schema from CLI):

- **psql** (Postgres CLI)

---

## Setup

### 1) Create env file

Create `.env.example` (content below) and then:

```bash
cp .env.example .env
```

### 2) Start Postgres + Redis

```bash
docker compose up -d
docker ps
```

### 3) Install dependencies

```bash
npm install
```

### 4) Apply database schema

If you have `psql` installed:

```bash
psql "postgres://app:app@localhost:5432/orders" -f db/schema.sql
```

If `psql` is missing on macOS:

```bash
brew install postgresql@16
```

Then re-run the schema command above.

---

## Run

Terminal A: start API server

```bash
npm run dev
```

Terminal B: start worker

```bash
npm run worker
```

Health check:

```bash
curl -s http://localhost:3000/health
```

---

## Demo: Create an order + watch WebSocket statuses

This creates an order and immediately connects via WebSocket:

```bash
ORDER_ID=$(curl -s -X POST http://localhost:3000/api/orders/execute \
  -H "content-type: application/json" \
  -d '{"type":"MARKET","tokenIn":"SOL","tokenOut":"USDC","amountIn":1,"slippageBps":50}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["orderId"])')

echo "ORDER_ID=$ORDER_ID"
npx wscat -c "ws://localhost:3000/api/orders/execute?orderId=$ORDER_ID"
```

Expected lifecycle:

- **pending**
- **routing**
- **building**
- **submitted**
- **confirmed** (or **failed**)

Notes:

- WebSocket first replays all historical events from Postgres (`order_events`) and then subscribes to live events via Redis pub/sub.

---

## Debug endpoints

Get latest order snapshot:

```bash
curl -s "http://localhost:3000/api/orders/$ORDER_ID"
```

Get full event history:

```bash
curl -s "http://localhost:3000/api/orders/$ORDER_ID/events"
```

---

## Demo: Retries + failure handling

The mock DEX router can randomly fail using **MOCK_FAIL_RATE**.

### 1) Restart worker with a failure rate

```bash
MOCK_FAIL_RATE=0.8 npm run worker
```

### 2) Create an order + watch WS

Use the same demo snippet above. You should see:

- **retrying** events for intermediate failures
- only one final **failed** if all attempts fail

---

## Stop / Reset

Stop services:

```bash
docker compose down
```

Reset everything (including DB data):

```bash
docker compose down -v
```

---

## API Summary

### `POST /api/orders/execute`

Creates a **MARKET** order and enqueues async execution.

Request body:

```json
{
  "type": "MARKET",
  "tokenIn": "SOL",
  "tokenOut": "USDC",
  "amountIn": 1,
  "slippageBps": 50
}
```

Response:

```json
{ "orderId": "uuid" }
```

### `GET /api/orders/execute?orderId=…`

WebSocket endpoint (**GET only**). Replays event history then streams live updates.

### `GET /api/orders/:id`

Returns current order snapshot.

### `GET /api/orders/:id/events`

Returns full ordered event history for the order.

---

## Environment Variables

Create this file: `.env.example`

```bash
PORT=3000
DATABASE_URL=postgres://app:app@localhost:5432/orders
REDIS_URL=redis://localhost:6379
MOCK_FAIL_RATE=0
```

Then copy it to `.env`:

```bash
cp .env.example .env
```

---

## Notes

- Supported order type: **MARKET**
- DEX routing is mocked (**Raydium** vs **Meteora** quotes + mocked swap execution)
- **Postgres** is the durable source of truth; **Redis** is for queue + real-time updates