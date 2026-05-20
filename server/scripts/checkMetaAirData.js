require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');

(async () => {
  const attr = await pgQuery(`SELECT COUNT(*)::int AS n FROM tw_air_order_attribution WHERE brand = 'NOBL'`);
  const cache = await pgQuery(`SELECT COUNT(*)::int AS n FROM nobl_air_meta_ad_daily WHERE brand = 'NOBL'`);
  const ch = await pgQuery(`
    SELECT channel, COUNT(*)::int AS n FROM tw_air_order_attribution
    WHERE brand = 'NOBL' GROUP BY channel ORDER BY n DESC LIMIT 10`);
  const ads = await pgQuery(`SELECT COUNT(*)::int AS n FROM tw_ads_daily WHERE brand = 'NOBL' AND platform = 'META'`);
  const range = await pgQuery(`
    SELECT MIN(date)::text AS min_d, MAX(date)::text AS max_d FROM tw_air_order_attribution WHERE brand = 'NOBL'`);
  console.log(JSON.stringify({
    attribution_rows: attr.rows[0].n,
    cache_rows: cache.rows[0].n,
    meta_ads_rows: ads.rows[0].n,
    channels: ch.rows,
    attr_date_range: range.rows[0],
  }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
