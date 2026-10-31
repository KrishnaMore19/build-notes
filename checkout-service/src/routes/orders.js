import { Router } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import { withTransaction } from "../db.js";
import { errorBody } from "../errors.js";

export const ordersRouter = Router();

const bodySchema = z
  .object({
    productId: z.number().int().positive(),
    quantity: z.number().int().min(1).max(10),
  })
  .strict();

const keySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_\-:.]+$/);

/**
 * POST /orders
 * Headers: Idempotency-Key (required), Authorization
 * Body:    { productId, quantity }
 *
 * Everything below runs in ONE transaction:
 *   1. claim the idempotency key (unique constraint = only one request wins)
 *   2. take stock with a single atomic UPDATE ... WHERE stock >= quantity
 *   3. create the order
 *   4. store the response against the key
 * Either all of it happens, or none of it does.
 */
ordersRouter.post("/", async (req, res) => {
  const keyResult = keySchema.safeParse(req.get("Idempotency-Key"));
  if (!keyResult.success) {
    return res.status(400).json(
      errorBody("invalid_idempotency_key", "Idempotency-Key header is required (8-128 chars: letters, digits, _ - : .)")
    );
  }
  const bodyResult = bodySchema.safeParse(req.body);
  if (!bodyResult.success) {
    const details = bodyResult.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return res.status(400).json(errorBody("invalid_request", "Invalid request body", details));
  }

  const key = keyResult.data;
  const { productId, quantity } = bodyResult.data;
  const clientId = req.clientId;
  // fingerprint of the validated body, so key order / whitespace don't matter
  const requestHash = createHash("sha256").update(`${productId}:${quantity}`).digest("hex");

  const outcome = await withTransaction(async (db) => {
    const claimed = await db.query(
      `INSERT INTO idempotency_keys (client_id, key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id, key) DO NOTHING
       RETURNING key`,
      [clientId, key, requestHash]
    );

    if (claimed.rowCount === 0) {
      // Key already used. If another request is still in flight, the INSERT above
      // waited for it to commit, so the stored response is available here.
      const { rows } = await db.query(
        `SELECT request_hash, response_status, response_body
         FROM idempotency_keys WHERE client_id = $1 AND key = $2`,
        [clientId, key]
      );
      const prev = rows[0];
      if (prev.request_hash !== requestHash) {
        return { status: 422, body: errorBody("idempotency_key_reuse", "This Idempotency-Key was already used with a different request") };
      }
      if (prev.response_status == null) {
        return { status: 409, body: errorBody("request_in_progress", "A request with this key is still being processed") };
      }
      return { status: prev.response_status, body: prev.response_body, replayed: true };
    }

    // First time we see this key: take stock atomically.
    const updated = await db.query(
      `UPDATE products SET stock = stock - $2, updated_at = now()
       WHERE id = $1 AND stock >= $2
       RETURNING id`,
      [productId, quantity]
    );

    let result;
    if (updated.rowCount === 0) {
      const exists = await db.query("SELECT 1 FROM products WHERE id = $1", [productId]);
      result = exists.rowCount === 0
        ? { status: 404, body: errorBody("product_not_found", "Product not found") }
        : { status: 409, body: errorBody("insufficient_stock", "Not enough stock") };
    } else {
      const order = await db.query(
        "INSERT INTO orders (product_id, quantity) VALUES ($1, $2) RETURNING id, created_at",
        [productId, quantity]
      );
      result = {
        status: 201,
        body: { orderId: order.rows[0].id, productId, quantity, createdAt: order.rows[0].created_at },
      };
    }

    // Business outcomes (201/404/409) are stored, so retries get the same answer.
    // Unexpected errors throw instead, roll back, and release the key for a clean retry.
    await db.query(
      `UPDATE idempotency_keys SET response_status = $3, response_body = $4
       WHERE client_id = $1 AND key = $2`,
      [clientId, key, result.status, JSON.stringify(result.body)]
    );
    return result;
  });

  if (outcome.replayed) res.set("Idempotent-Replayed", "true");
  res.status(outcome.status).json(outcome.body);
});
