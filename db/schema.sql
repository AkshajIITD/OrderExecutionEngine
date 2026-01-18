CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  token_in text NOT NULL,
  token_out text NOT NULL,
  amount_in numeric NOT NULL,
  slippage_bps int NOT NULL,
  status text NOT NULL,
  chosen_dex text,
  expected_price numeric,
  executed_price numeric,
  tx_hash text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  status text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);