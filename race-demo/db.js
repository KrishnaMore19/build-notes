import pg from "pg";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5433/racedemo",
  max: 20,
});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INT PRIMARY KEY,
      stock INT NOT NULL,
      version INT NOT NULL DEFAULT 0
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      idempotency_key TEXT UNIQUE,
      product_id INT,
      request_hash TEXT
    )`);
  await pool.query(
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_hash TEXT"
  );
  await reset(1);
}

export async function reset(stock = 1) {
  await pool.query(
    `INSERT INTO products (id, stock, version) VALUES (1, $1, 0)
     ON CONFLICT (id) DO UPDATE SET stock = $1, version = 0`,
    [stock]
  );
  await pool.query("TRUNCATE orders");
}