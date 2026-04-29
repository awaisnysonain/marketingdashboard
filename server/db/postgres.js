const { Pool } = require('pg');

// Force UTC so date casts (date::date, DATE(...)) are consistent
// regardless of server OS timezone (local = UTC+5, live = UTC)
process.env.PGTZ = 'UTC';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Set timezone to UTC on every new connection
pool.on('connect', (client) => {
  client.query("SET timezone = 'UTC'").catch(err =>
    console.error('[PG] Failed to set timezone:', err.message)
  );
});

pool.on('error', (err) => {
  console.error('[PG] Unexpected pool error:', err.message);
});

async function pgQuery(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

async function pgRun(sql, params = []) {
  return pgQuery(sql, params);
}

module.exports = { pool, pgQuery, pgRun };
