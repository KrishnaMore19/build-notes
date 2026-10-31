# Race Condition Demo (Express + PostgreSQL)

Shows a lost-update bug and 4 ways to fix it.

## Run
```bash
docker compose up -d      # starts Postgres on port 5433
npm install
npm start                 # terminal 1
npm test                  # terminal 2 (fires 50 concurrent requests per endpoint)
```
Requires Node 18+.

## Endpoints
| Endpoint | Strategy |
|---|---|
| POST /buy-unsafe | read, then write (BUG) |
| POST /buy-atomic | Fix 1: single UPDATE ... WHERE stock > 0 |
| POST /buy-lock | Fix 2: SELECT ... FOR UPDATE |
| POST /buy-optimistic | Fix 3: version column + retry |
| POST /order | Fix 4: Idempotency-Key header + UNIQUE constraint |

## Expected output
```
BUG unsafe (the bug)   stock=1, 50 requests -> 12 succeeded
OK  fix 1: atomic      stock=1, 50 requests -> 1 succeeded
OK  fix 2: FOR UPDATE  stock=1, 50 requests -> 1 succeeded
OK  fix 3: optimistic  stock=1, 50 requests -> 1 succeeded
OK  idempotency key    10 identical requests -> 1 order(s) created
```
(The unsafe number varies on every run, that is the point.)
