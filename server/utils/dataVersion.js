const { pgQuery } = require('../db/postgres');

/**
 * General data-version token for read-path response caching.
 *
 * Unlike noblAirDataVersion (which only tracks the NOBL Air tables), this
 * reflects ANY successful ETL run. The token changes whenever a new successful
 * run is logged, so cached API responses automatically refresh after a sync —
 * without the read path needing to know which tables a given endpoint touches.
 *
 * Read-only: this never writes to the DB and is independent of the ETL/cron code.
 */
let cached = { version: null, at: 0 };
const TTL_MS = 30 * 1000;

async function getDataVersion(force = false) {
  if (!force && cached.version && Date.now() - cached.at < TTL_MS) {
    return cached.version;
  }
  try {
    const r = await pgQuery(`
      SELECT
        (SELECT MAX(finished_at)::timestamptz::text FROM etl_run_log WHERE status = 'success') AS last_etl_at,
        (SELECT COUNT(*)::text FROM etl_run_log WHERE status = 'success') AS run_count
    `);
    const row = r.rows[0] || {};
    cached = { version: `${row.last_etl_at || ''}|${row.run_count || '0'}`, at: Date.now() };
  } catch (e) {
    // On error, fall back to a time-bucketed token so caching still degrades
    // gracefully (5-min buckets) instead of breaking the request.
    cached = { version: `fallback:${Math.floor(Date.now() / (5 * 60 * 1000))}`, at: Date.now() };
  }
  return cached.version;
}

module.exports = { getDataVersion };
