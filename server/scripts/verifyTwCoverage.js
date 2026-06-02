require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');

(async () => {
  for (const table of ['tw_summary_daily', 'tw_channel_daily', 'tw_geo_daily', 'tw_product_daily']) {
    const r = await pgQuery(`
      SELECT brand, COUNT(*)::int n, MIN(date)::date first, MAX(date)::date last
      FROM ${table} WHERE brand IN ('FLO','NOBL') GROUP BY brand ORDER BY brand
    `);
    console.log(table + ':', r.rows);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
