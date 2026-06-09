#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pool } = require('../db/postgres');

(async () => {
  const r = await pool.query(`
    SELECT pid, state, application_name,
           client_addr::text AS client,
           now() - state_change AS idle_for,
           left(query, 80) AS query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND usename = current_user
      AND pid <> pg_backend_pid()
    ORDER BY backend_start
  `);
  console.log('Other connections to this DB:', r.rows.length);
  console.log(JSON.stringify(r.rows, null, 2));
  console.log('Local pool: total=%d idle=%d waiting=%d', pool.totalCount, pool.idleCount, pool.waitingCount);
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
