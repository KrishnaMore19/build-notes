import { Router } from "express";
import { pool } from "../db.js";

export const healthRouter = Router();

// liveness: the process is up
healthRouter.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// readiness: the process can reach its database
healthRouter.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "database unavailable" });
  }
});
