import crypto from "node:crypto";
import express from "express";
import { pool, init, reset, sleep } from "./db.js";

const app = express();
app.use(express.json());

const OK = (res) => res.json({ status: "bought" });
const SOLD_OUT = (res) => res.status(409).json({ error: "out of stock" });

// ---------- helpers ----------
app.post("/reset", async (req, res) => {
  await reset(req.body?.stock ?? 1);
  res.json({ status: "reset" });
});

app.get("/stock", async (_req, res) => {
  const { rows } = await pool.query("SELECT stock FROM products WHERE id = 1");
  res.json({ stock: rows[0].stock });
});

app.get("/orders/count", async (_req, res) => {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM orders");
  res.json({ orders: rows[0].n });
});

// ---------- BUG: read-modify-write (lost update) ----------
app.post("/buy-unsafe", async (_req, res) => {
  const { rows } = await pool.query("SELECT stock FROM products WHERE id = 1");
  const stock = rows[0].stock;
  if (stock <= 0) return SOLD_OUT(res);
  await sleep(5); // simulates real-world work between read and write
  await pool.query("UPDATE products SET stock = $1 WHERE id = 1", [stock - 1]);
  OK(res);
});

// ---------- FIX 1: atomic update ----------
app.post("/buy-atomic", async (_req, res) => {
  const r = await pool.query(
    "UPDATE products SET stock = stock - 1 WHERE id = 1 AND stock > 0"
  );
  if (r.rowCount === 0) return SOLD_OUT(res);
  OK(res);
});

// ---------- FIX 2: pessimistic lock (SELECT ... FOR UPDATE) ----------
app.post("/buy-lock", async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT stock FROM products WHERE id = 1 FOR UPDATE"
    );
    if (rows[0].stock <= 0) {
      await client.query("ROLLBACK");
      return SOLD_OUT(res);
    }
    await sleep(5);
    await client.query("UPDATE products SET stock = stock - 1 WHERE id = 1");
    await client.query("COMMIT");
    OK(res);
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- FIX 3: optimistic lock (version column + retry) ----------
app.post("/buy-optimistic", async (_req, res) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { rows } = await pool.query(
      "SELECT stock, version FROM products WHERE id = 1"
    );
    const { stock, version } = rows[0];
    if (stock <= 0) return SOLD_OUT(res);
    await sleep(5);
    const r = await pool.query(
      `UPDATE products SET stock = $1, version = version + 1
       WHERE id = 1 AND version = $2`,
      [stock - 1, version]
    );
    if (r.rowCount === 1) return OK(res); // nobody changed it, we won
    // someone changed it first: wait a random, growing delay, then retry
    await sleep(Math.random() * Math.min(200, 10 * 2 ** attempt));
  }
  res.status(503).json({ error: "too much contention, try again" });
});

// ---------- FIX 4: idempotency key (duplicate requests) ----------
// One transaction: record the key + take stock atomically.
// Same key again -> return the original order, don't process twice.
app.post("/order", async (req, res) => {
  const key = req.get("Idempotency-Key");
  if (!key) return res.status(400).json({ error: "Idempotency-Key header required" });

  // fingerprint of the request body, to detect a reused key with different data
  const hash = crypto.createHash("sha256")
    .update(JSON.stringify(req.body ?? {})).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query(
      `INSERT INTO orders (idempotency_key, product_id, request_hash)
       VALUES ($1, 1, $2)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [key, hash]
    );

    if (ins.rowCount === 0) {
      // key already used: return the original result (or reject a mismatch)
      await client.query("ROLLBACK");
      const { rows } = await pool.query(
        "SELECT id, request_hash FROM orders WHERE idempotency_key = $1", [key]
      );
      if (rows[0].request_hash !== hash) {
        return res.status(422).json({ error: "Idempotency-Key reused with a different request" });
      }
      return res.status(200).json({ status: "duplicate, original order returned", orderId: rows[0].id });
    }

    // first time we see this key: take stock atomically (same transaction)
    const upd = await client.query(
      "UPDATE products SET stock = stock - 1 WHERE id = 1 AND stock > 0"
    );
    if (upd.rowCount === 0) {
      await client.query("ROLLBACK"); // also releases the key
      return SOLD_OUT(res);
    }

    await client.query("COMMIT");
    res.status(201).json({ status: "order created", orderId: ins.rows[0].id });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

await init();
app.listen(3000, () => console.log("Listening on http://localhost:3000"));