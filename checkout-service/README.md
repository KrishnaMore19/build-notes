# checkout-service

A hardened version of the race-condition demo: an Express + PostgreSQL order endpoint
that cannot oversell stock and safely handles duplicate requests.

`POST /orders` with `Idempotency-Key` header and body `{ "productId": 1, "quantity": 1 }`

## Run locally (Node 20.6+)

```bash
docker compose up -d        # Postgres on port 5433
cp .env.example .env        # on Windows PowerShell: copy .env.example .env
npm install
npm run migrate             # creates tables
npm run seed                # adds a demo product (id 1, stock 100)
npm run dev                 # starts the API on :3000
npm test                    # concurrency + idempotency tests
```

Try it:

```bash
curl -X POST localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-first-order-001" \
  -d '{"productId":1,"quantity":1}'
```
Send the same command again: you get the same order back with an `Idempotent-Replayed: true` header.

## What it does

| Concern | How it is handled |
|---|---|
| Overselling | One atomic `UPDATE ... WHERE stock >= quantity`, plus a `CHECK (stock >= 0)` constraint as a safety net |
| Duplicate requests | `Idempotency-Key` + `UNIQUE (client_id, key)`; the stored response is replayed |
| Key reused with different data | Request hash is compared, returns `422` |
| Partial failure | Key, stock, order and stored response are saved in one transaction |
| Stuck queries / locks | `lock_timeout` 2s, `statement_timeout` 5s, connection timeout 5s |
| Deadlocks | Transaction retried with backoff + jitter |
| Overload | Rate limiting, 10kb body limit, `503` + `Retry-After` when the DB is busy |
| Input | Validated with zod, unknown fields rejected |
| Secrets/config | Env vars validated at startup; refuses to start in production without `API_KEY` |
| Observability | Structured JSON logs (pino), request IDs, auth headers redacted |
| Deploys | Versioned SQL migrations with an advisory lock, `/healthz` + `/readyz`, graceful shutdown |
| Cleanup | Expired idempotency keys purged hourly (default TTL 24h) |

## Design notes

- **Business outcomes are replayed.** A stored `409 insufficient_stock` is returned again for the same key. Use a new key to retry after a restock. Unexpected errors roll back and release the key, so a clean retry is possible.
- **Idempotency keys are scoped per client** (`req.clientId`). With real auth, set this to the user or tenant ID.

## Before you ship this (your responsibility)

- Replace `src/auth.js` with your real authentication/authorization.
- Add real checkout logic: payments, multiple items, refunds, releasing stock when payment fails. Never call a payment API while holding a row lock.
- Set up log shipping, metrics, alerting, database backups and a managed Postgres.
- Load-test with your real traffic shape and tune `DB_POOL_MAX`.
- Run `npm audit` and keep dependencies updated.
- Run the tests in CI.
