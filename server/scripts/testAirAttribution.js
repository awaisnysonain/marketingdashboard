require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');
const { metaAdsDailySourceSql } = require('../etl/metaAdsSync');

const start = '2026-01-01';
const end = '2026-05-26';
const groupCols = 'campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name';

async function main() {
  const src = metaAdsDailySourceSql('$1::date AND $2::date');
  console.log('Testing merged subquery count...');
  try {
    const r = await pgQuery(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT ${groupCols},
          COALESCE(ads.spend, 0) AS spend,
          COALESCE(air.air_orders, 0) AS air_orders,
          COALESCE(air.attributed_air_orders, 0) AS attributed_air_orders
        FROM (
          SELECT ${groupCols},
            SUM(spend)::numeric(14,2) AS spend,
            SUM(revenue)::numeric(14,2) AS day_1_revenue,
            SUM(purchases)::numeric(14,2) AS total_attributed_orders
          FROM ${src} ads_src
          WHERE ads_src.brand = 'NOBL'
          GROUP BY ads_src.campaign_id, ads_src.campaign_name, ads_src.adset_id, ads_src.adset_name, ads_src.ad_id, ads_src.ad_name
        ) ads
        FULL OUTER JOIN (
          SELECT ${groupCols},
            SUM(air_orders)::int AS air_orders,
            SUM(attributed_air_orders)::numeric(14,2) AS attributed_air_orders
          FROM nobl_air_meta_ad_daily
          WHERE brand = 'NOBL' AND date BETWEEN $1::date AND $2::date
          GROUP BY ${groupCols}
        ) air ON COALESCE(ads.ad_id, '') = COALESCE(air.ad_id, '')
          AND COALESCE(ads.campaign_id, '') = COALESCE(air.campaign_id, '')
          AND COALESCE(ads.adset_id, '') = COALESCE(air.adset_id, '')
      ) grouped
      WHERE grouped.spend > 0 OR grouped.air_orders > 0 OR grouped.attributed_air_orders > 0
    `, [start, end]);
    console.log('OK count:', r.rows[0].n);
  } catch (e) {
    console.error('SQL ERROR:', e.message);
  }

  console.log('\nTesting HTTP...');
  try {
    const res = await fetch(`http://localhost:3001/api/analytics/nobl/air-attribution?start=${start}&end=${end}&page=1&page_size=20&sort_by=Ad%20spend&sort_dir=desc`);
    console.log('HTTP status:', res.status);
    const body = await res.text();
    console.log(body.slice(0, 500));
  } catch (e) {
    console.error('HTTP err:', e.message);
  }
}

main();
