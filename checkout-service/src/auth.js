import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { errorBody } from "./errors.js";

const sha = (s) => createHash("sha256").update(s).digest();

/**
 * Minimal bearer-token auth. REPLACE this with your real auth (JWT, sessions, ...).
 * The important part is req.clientId: idempotency keys are scoped per client,
 * so one customer's key can never collide with another's.
 */
export function requireAuth(req, res, next) {
  if (!config.API_KEY) {
    req.clientId = "anonymous"; // only possible outside production (see config.js)
    return next();
  }
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  // hash both sides so lengths match and comparison is constant-time
  if (!timingSafeEqual(sha(token), sha(config.API_KEY))) {
    return res.status(401).json(errorBody("unauthorized", "Missing or invalid API key"));
  }
  req.clientId = "api-key";
  next();
}
