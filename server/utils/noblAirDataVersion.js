const { pgQuery } = require('../db/postgres');

let cached = { version: null, detail: null, at: 0 };
const TTL_MS = 60 * 1000;

async function getNoblAirDataVersion(force = false) {
  if (!force && cached.version && Date.now() - cached.at < TTL_MS) {
    return { version: cached.version, ...cached.detail };
  }

  const r = await pgQuery(`
    SELECT
      (SELECT MAX(date)::text FROM nobl_air_daily) AS air_daily_max,
      (SELECT MAX(date)::text FROM nobl_air_meta_ad_daily WHERE brand = 'NOBL') AS meta_air_max,
      (SELECT MAX(as_of_date)::text FROM nobl_air_ttp_snapshot) AS ttp_snapshot_max,
      (SELECT MAX(end_date)::text FROM etl_run_log
        WHERE task = 'nobl_air_aggregate' AND status = 'success') AS aggregate_end,
      (SELECT MAX(finished_at)::timestamptz::text FROM etl_run_log
        WHERE task IN ('nobl_air_aggregate', 'tw_air_attribution', 'nobl_air_meta_ad_daily')
          AND status = 'success') AS last_etl_at
  `);
  const row = r.rows[0] || {};
  const version = [
    row.air_daily_max || '',
    row.meta_air_max || '',
    row.ttp_snapshot_max || '',
    row.aggregate_end || '',
    row.last_etl_at || '',
  ].join('|');

  cached = {
    version,
    detail: {
      air_daily_max: row.air_daily_max,
      meta_air_max: row.meta_air_max,
      ttp_snapshot_max: row.ttp_snapshot_max,
      aggregate_end: row.aggregate_end,
      last_etl_at: row.last_etl_at,
    },
    at: Date.now(),
  };

  return { version, ...cached.detail };
}

function invalidateNoblAirDataVersionCache() {
  cached.at = 0;
}

module.exports = { getNoblAirDataVersion, invalidateNoblAirDataVersionCache };
