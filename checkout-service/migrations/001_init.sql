CREATE TABLE products (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  stock      INTEGER NOT NULL CHECK (stock >= 0),   -- DB-level safety net: stock can never go negative
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id         BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products (id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_product_id ON orders (product_id);

-- One row per (client, Idempotency-Key). Stores the response so retries get the same answer.
CREATE TABLE idempotency_keys (
  client_id       TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, key)
);
CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys (created_at);
