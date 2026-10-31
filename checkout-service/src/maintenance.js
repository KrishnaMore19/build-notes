import { pool } from "./db.js";
import { config } from "./config.js";

// Idempotency keys only need to live as long as clients might retry.
export async function purgeExpiredIdempotencyKeys() {
  const r = await pool.query(
    "DELETE FROM idempotency_keys WHERE created_at < now() - ($1 * interval '1 hour')",
    [config.IDEMPOTENCY_TTL_HOURS]
  );
  return r.rowCount;
}
