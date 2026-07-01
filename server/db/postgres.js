const { Pool } = require('pg');

// Force UTC so date casts (date::date, DATE(...)) are consistent
// regardless of server OS timezone (local = UTC+5, live = UTC)
process.env.PGTZ = 'UTC';

const POOL_OPTS = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  // Keep this small, but >1. KPI Pulse and other dashboard reads should not
  // fail just because a cron/ETL task is holding the single connection for a
  // long batch. Override with DB_POOL_MAX / DB_SESSION_POOL_MAX if needed.
  max: parseInt(process.env.DB_POOL_MAX || '4', 10),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000', 10),
  allowExitOnIdle: true,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '15000', 10),
  maxLifetimeSeconds: 600,
};

const pool = new Pool({ ...POOL_OPTS, application_name: 'marketingdashboard' });
const sessionPool = new Pool({
  ...POOL_OPTS,
  max: parseInt(process.env.DB_SESSION_POOL_MAX || '2', 10),
  application_name: 'marketingdashboard-session',
});

for (const p of [pool, sessionPool]) {
  p.on('error', (err) => {
    console.error('[PG] Unexpected pool error:', err.message);
  });
}

async function ensureClientTimezone(client) {
  if (client._noblTzReady) return;
  await client.query("SET timezone = 'UTC'");
  client._noblTzReady = true;
}

async function pgQuery(sql, params = []) {
  const client = await pool.connect();
  try {
    await ensureClientTimezone(client);
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/** Run multiple queries on one connection (avoids Promise.all opening N pool slots). */
async function pgQueryBatch(items) {
  const client = await pool.connect();
  try {
    await ensureClientTimezone(client);
    const results = [];
    for (const item of items) {
      try {
        results.push(await client.query(item.sql, item.params ?? []));
      } catch (e) {
        if (item.fallback !== undefined) results.push(item.fallback(e));
        else throw e;
      }
    }
    return results;
  } finally {
    client.release();
  }
}

async function pgRun(sql, params = []) {
  return pgQuery(sql, params);
}

/** Drop orphaned backends left when PM2 SIGKILLs the process without pool.end(). */
async function cleanupStaleConnections() {
  try {
    const r = await pool.query(`
      SELECT pg_terminate_backend(pid) AS terminated
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = current_user
        AND pid <> pg_backend_pid()
        AND application_name LIKE 'marketingdashboard%'
    `);
    const n = r.rowCount || 0;
    if (n) console.log(`[PG] Terminated ${n} stale backend(s) from previous run`);
  } catch (e) {
    console.warn('[PG] stale cleanup skipped:', e.message);
  }
}

module.exports = {
  pool,
  sessionPool,
  pgQuery,
  pgQueryBatch,
  pgRun,
  cleanupStaleConnections,
};
