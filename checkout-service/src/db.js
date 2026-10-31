import pg from "pg";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { logger } from "./logger.js";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000, // fail fast instead of queueing forever
});

pool.on("error", (err) => logger.error({ err }, "idle postgres client error"));

// 40001 = serialization_failure, 40P01 = deadlock_detected: safe to retry the whole transaction
const RETRYABLE = new Set(["40001", "40P01"]);

/**
 * Runs fn(client) inside a transaction with timeouts, so a stuck query or lock
 * can never hold a connection (or a row lock) forever. Retries on deadlocks.
 */
export async function withTransaction(fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => { broken = true; });
      if (!(RETRYABLE.has(err.code) && attempt < retries)) throw err;
    } finally {
      client.release(broken); // true = destroy the connection instead of reusing it
    }
    // only reached when retrying: exponential backoff with jitter
    await sleep(Math.random() * Math.min(200, 20 * 2 ** attempt));
  }
}
