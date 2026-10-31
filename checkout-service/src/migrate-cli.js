import { runMigrations } from "./migrate.js";
import { pool } from "./db.js";

try {
  await runMigrations();
  console.log("migrations up to date");
} catch (err) {
  console.error("migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
