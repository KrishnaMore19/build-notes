const { Pool, types } = require('pg');

// numeric columns (odometer, distances, speeds) come back as JSON numbers, not strings.
types.setTypeParser(1700, parseFloat);

// Pool math: total connections = API instances x PG_POOL_MAX. Keep it under Postgres max_connections (default 100).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

module.exports = { pool };
