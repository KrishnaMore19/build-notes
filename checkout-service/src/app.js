import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { requireAuth } from "./auth.js";
import { errorBody } from "./errors.js";
import { healthRouter } from "./routes/health.js";
import { ordersRouter } from "./routes/orders.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = String(req.headers["x-request-id"] ?? "").slice(0, 64) || randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
    })
  );

  app.use(healthRouter); // before rate limit + auth so probes always work

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: config.RATE_LIMIT_PER_MINUTE,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: errorBody("rate_limited", "Too many requests"),
    })
  );
  app.use(express.json({ limit: "10kb" }));

  app.use("/orders", requireAuth, ordersRouter);

  app.use((_req, res) => res.status(404).json(errorBody("not_found", "Route not found")));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json(errorBody("invalid_json", "Request body is not valid JSON"));
    if (err.type === "entity.too.large") return res.status(413).json(errorBody("payload_too_large", "Request body too large"));

    // lock timeout, statement timeout, or no free DB connection: tell clients to retry later
    const busy =
      err.code === "55P03" || err.code === "57014" ||
      /timeout exceeded when trying to connect/.test(err.message ?? "");
    if (busy) {
      req.log.warn({ err }, "database busy");
      res.set("Retry-After", "1");
      return res.status(503).json(errorBody("service_busy", "Service is busy, please retry"));
    }

    req.log.error({ err }, "unhandled error");
    res.status(500).json(errorBody("internal_error", "Something went wrong")); // never leak internals
  });

  return app;
}
