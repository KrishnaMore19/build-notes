import { pool } from "./db.js";

const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM products");
if (rows[0].n === 0) {
  const r = await pool.query("INSERT INTO products (name, stock) VALUES ('Concert Ticket', 100) RETURNING id");
  console.log(`seeded product id=${r.rows[0].id} with stock 100`);
} else {
  console.log("products already exist, nothing to seed");
}
await pool.end();
