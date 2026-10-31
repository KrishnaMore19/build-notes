import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db.js";
import { purgeExpiredIdempotencyKeys } from "./maintenance.js";

const app = createApp();
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, "server listening"));

// slightly above typical load balancer idle timeouts (60s) to avoid sporadic 502s
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const purgeTimer = setInterval(async () => {
  try {
    const n = await purgeExpiredIdempotencyKeys();
    if (n) logger.info({ deleted: n }, "purged expired idempotency keys");
  } catch (err) {
    logger.error({ err }, "idempotency purge failed");
  }
}, 60 * 60 * 1000);
purgeTimer.unref();

function shutdown(signal) {
  logger.info({ signal }, "shutting down");
  clearInterval(purgeTimer);
  server.close(async () => {          // stop accepting, let in-flight requests finish
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // force exit if something hangs
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandled rejection");
  process.exit(1); // let the orchestrator restart us in a clean state
});
