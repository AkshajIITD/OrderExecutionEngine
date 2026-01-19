# **Order Execution Engine (Backend Task)**

A minimal order execution engine that:
- **Accepts `MARKET` orders via HTTP**
- **Executes asynchronously via a BullMQ worker**
- **Persists order + event history in Postgres**
- **Streams status updates via WebSocket** (history replay + live updates)
- **Supports retries/failures** (BullMQ attempts) + mock DEX failures

---

## **Live Deployment (Railway)**

**Base URL:**  
[`https://orderexecutionengine-production-78e3.up.railway.app`](https://orderexecutionengine-production-78e3.up.railway.app)

**Health check:**
```sh
BASE="https://orderexecutionengine-production-78e3.up.railway.app"
curl -s "$BASE/health"
```

**Create order + stream statuses over WebSocket:**
```sh
BASE="https://orderexecutionengine-production-78e3.up.railway.app"

ORDER_ID=$(curl -s -X POST "$BASE/api/orders/execute" \
  -H "content-type: application/json" \
  -d '{"type":"MARKET","tokenIn":"SOL","tokenOut":"USDC","amountIn":1,"slippageBps":50}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["orderId"])')

echo "ORDER_ID=$ORDER_ID"

WS_BASE=$(echo "$BASE" | sed 's/^https:/wss:/; s/^http:/ws:/')
npx wscat -c "$WS_BASE/api/orders/execute?orderId=$ORDER_ID"
```
**Query order snapshot + full event history:**
```sh
curl -s "$BASE/api/orders/$ORDER_ID"
echo
curl -s "$BASE/api/orders/$ORDER_ID/events"
echo
```

---

## **Tech Stack**

- **Fastify** + `@fastify/websocket`
- **BullMQ** (Redis-backed queue)
- **Postgres** (durable storage: `orders`, `order_events`)
- **Redis** (BullMQ backend + pub/sub for WS)
- **TypeScript** (ESM)

---

## **Why MARKET order?**

I chose MARKET orders because the focus is the execution pipeline (**routing → execution → settlement**) and real-time updates.  
To extend this engine to LIMIT or SNIPER, add a new order type + a scheduler/watcher that triggers enqueueing when conditions are met (price hit or launch/migration signal), while keeping the same routing/execution worker flow.

---

## **Prerequisites**

- **Node.js** (recommended: 20+)
- **Docker** + **Docker Compose**
- **wscat** (used via `npx wscat`)

*Optional (only needed to apply schema from CLI):*
- **psql** (Postgres CLI)

---

## **Setup (Local)**

1. **Create env file**  
   Create `.env.example` (content below), then:
   ```sh
   cp .env.example .env
   ```

2. **Start Postgres + Redis**
   ```sh
   docker compose up -d
   docker ps
   ```

3. **Install dependencies**
   ```sh
   npm install
   ```

4. **Apply database schema**

   If you have `psql` installed:
   ```sh
   psql "postgres://app:app@localhost:5432/orders" -f db/schema.sql
   ```

   If `psql` is missing on macOS:
   ```sh
   brew install postgresql@16
   ```
   Then re-run the schema command above.

---

## **Run (Local)**

**Terminal A:** start API server
```sh
npm run dev
```

**Terminal B:** start worker
```sh
npm run worker
```

**Health check:**
```sh
curl -s http://localhost:3000/health
```

---

## **Demo (Local): Create an order + watch WebSocket statuses**

```sh
ORDER_ID=$(curl -s -X POST http://localhost:3000/api/orders/execute \
  -H "content-type: application/json" \
  -d '{"type":"MARKET","tokenIn":"SOL","tokenOut":"USDC","amountIn":1,"slippageBps":50}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["orderId"])')

echo "ORDER_ID=$ORDER_ID"
npx wscat -c "ws://localhost:3000/api/orders/execute?orderId=$ORDER_ID"
```

**Expected lifecycle:**
- `pending`
- `routing`
- `building`
- `submitted`
- `confirmed` (or `failed`)

**Notes:**
- WebSocket first replays all historical events from **Postgres** (`order_events`) and then subscribes to live events via **Redis pub/sub**.

---

## **Debug endpoints**

**Get latest order snapshot:**
```sh
curl -s "http://localhost:3000/api/orders/$ORDER_ID"
```

**Get full event history:**
```sh
curl -s "http://localhost:3000/api/orders/$ORDER_ID/events"
```

---

## **Demo: Retries + Failure Handling**

The mock DEX router can randomly fail using `MOCK_FAIL_RATE`.

**Restart worker with a failure rate:**
```sh
MOCK_FAIL_RATE=0.8 npm run worker
```

Then create an order + watch WS (same demo snippet).  
You should see:
- `retrying` events for intermediate failures
- a final `failed` if all attempts fail

---

## **Tests (Vitest)**

**Run tests once:**
```sh
npm run test:run
```

**Watch mode:**
```sh
npm test
```

**Test coverage includes:**
- Request validation (`400`s)
- Order creation + queue enqueue
- Order snapshot endpoints
- WebSocket lifecycle (missing orderId, replay-first behavior)
- Routing selection logic (best quote selection)

---

## **Postman Collection**

A Postman collection is included in the repo:
- `postman_collection.json` (or `Order Execution Engine.postman_collection.json`)

**Import steps:**
1. Open **Postman**
2. Import → select the collection JSON
3. Set `BASE_URL` (example):
   - **Local:** `http://localhost:3000`
   - **Railway:** `https://orderexecutionengine-production-78e3.up.railway.app`

---

## **Stop / Reset (Local)**

**Stop services:**
```sh
docker compose down
```

**Reset everything (including DB data):**
```sh
docker compose down -v
```

---

## **API Summary**

### **POST `/api/orders/execute`**

Creates a `MARKET` order and enqueues async execution.

**Request body:**
```json
{
  "type": "MARKET",
  "tokenIn": "SOL",
  "tokenOut": "USDC",
  "amountIn": 1,
  "slippageBps": 50
}
```

**Response:**
```json
{ "orderId": "uuid" }
```

### **GET `/api/orders/execute?orderId=…`**

WebSocket endpoint (**GET** only). Replays event history then streams live updates.

### **GET `/api/orders/:id`**

Returns current order snapshot.

### **GET `/api/orders/:id/events`**

Returns full ordered event history for the order.

---

## **Environment Variables**

Create this file: `.env.example`
```dotenv
PORT=3000
DATABASE_URL=postgres://app:app@localhost:5432/orders
REDIS_URL=redis://localhost:6379
MOCK_FAIL_RATE=0
```
Then copy it to `.env`:
```sh
cp .env.example .env
```

---

## **Notes**

- Supported order type: **MARKET**
- DEX routing is **mocked** (Raydium vs Meteora quotes + mocked swap execution)
- **Postgres** is the durable source of truth; **Redis** is for queue + real-time updates
