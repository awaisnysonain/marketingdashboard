require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');

(async () => {
  const sources = await pgQuery(
    `SELECT source, COUNT(*)::int AS n FROM forecast_plan_daily WHERE brand='NOBL' GROUP BY source ORDER BY n DESC`
  );
  console.log('By source:', sources.rows);
  const sample = await pgQuery(
    `SELECT date::text, plan_revenue, drop_lift, source FROM forecast_plan_daily
     WHERE date IN ('2026-05-01','2026-05-30','2026-11-28') ORDER BY date`
  );
  console.log('Samples:', sample.rows);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
