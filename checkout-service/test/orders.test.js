import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// env must be set BEFORE the app modules load, hence dynamic imports below
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.RATE_LIMIT_PER_MINUTE = "100000";

const { createApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");
const { pool } = await import("../src/db.js");
const { runMigrations } = await import("../src/migrate.js");

let server, base;
const productIds = [];
const auth = config.API_KEY ? { Authorization: `Bearer ${config.API_KEY}` } : {};

const newProduct = async (stock) => {
  const r = await pool.query("INSERT INTO products (name, stock) VALUES ('test', $1) RETURNING id", [stock]);
  productIds.push(r.rows[0].id);
  return Number(r.rows[0].id);
};
const stockOf = async (id) => (await pool.query("SELECT stock FROM products WHERE id = $1", [id])).rows[0].stock;
const orderCount = async (id) => (await pool.query("SELECT COUNT(*)::int AS n FROM orders WHERE product_id = $1", [id])).rows[0].n;

const order = (body, key) =>
  fetch(`${base}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}), ...auth },
    body: JSON.stringify(body),
  });
const uid = () => `test-${Math.random().toString(36).slice(2)}-${Date.now()}`;

before(async () => {
  await runMigrations(() => {});
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  if (productIds.length) {
    await pool.query("DELETE FROM orders WHERE product_id = ANY($1)", [productIds]);
    await pool.query("DELETE FROM products WHERE id = ANY($1)", [productIds]);
  }
  await pool.query("DELETE FROM idempotency_keys WHERE key LIKE 'test-%'");
  await pool.end();
});

test("50 concurrent buyers, 1 item in stock -> exactly 1 order", async () => {
  const id = await newProduct(1);
  const res = await Promise.all(Array.from({ length: 50 }, () => order({ productId: id, quantity: 1 }, uid())));
  const statuses = res.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 49);
  assert.equal(await stockOf(id), 0);
  assert.equal(await orderCount(id), 1);
});

test("30 concurrent buyers, 10 in stock -> exactly 10 orders, stock never negative", async () => {
  const id = await newProduct(10);
  const res = await Promise.all(Array.from({ length: 30 }, () => order({ productId: id, quantity: 1 }, uid())));
  assert.equal(res.filter((r) => r.status === 201).length, 10);
  assert.equal(await stockOf(id), 0);
  assert.equal(await orderCount(id), 10);
});

test("same Idempotency-Key sent 10x concurrently -> 1 order, same response", async () => {
  const id = await newProduct(5);
  const key = uid();
  const res = await Promise.all(Array.from({ length: 10 }, () => order({ productId: id, quantity: 1 }, key)));
  const bodies = await Promise.all(res.map((r) => r.json()));
  assert.ok(res.every((r) => r.status === 201));
  assert.equal(new Set(bodies.map((b) => b.orderId)).size, 1);
  assert.equal(await orderCount(id), 1);
  assert.equal(await stockOf(id), 4);
});

test("sold-out response is replayed for the same key", async () => {
  const id = await newProduct(0);
  const key = uid();
  const first = await order({ productId: id, quantity: 1 }, key);
  const second = await order({ productId: id, quantity: 1 }, key);
  assert.equal(first.status, 409);
  assert.equal(second.status, 409);
  assert.equal(second.headers.get("idempotent-replayed"), "true");
});

test("same key with a different request -> 422", async () => {
  const id = await newProduct(5);
  const key = uid();
  assert.equal((await order({ productId: id, quantity: 1 }, key)).status, 201);
  assert.equal((await order({ productId: id, quantity: 2 }, key)).status, 422);
  assert.equal(await stockOf(id), 4);
});

test("validation and not-found", async () => {
  const id = await newProduct(5);
  assert.equal((await order({ productId: id, quantity: 1 })).status, 400);              // no key
  assert.equal((await order({ productId: id, quantity: 0 }, uid())).status, 400);       // bad quantity
  assert.equal((await order({ productId: id, quantity: 1, extra: 1 }, uid())).status, 400); // unknown field
  assert.equal((await order({ productId: 999999999, quantity: 1 }, uid())).status, 404);
});

test("health endpoints", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
});
