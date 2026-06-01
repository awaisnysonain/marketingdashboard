require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');

// Load query helpers by requiring analytics internals - use direct SQL from route
const { metaAdsDailySourceSql } = require('../etl/metaAdsSync');

const start = '2026-01-01';
const end = '2026-05-26';
const groupCols = 'campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name';
const groupFields = ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'];

function airAttrMergedGroupedSubquery(groupCols, groupFields) {
  const idFields = groupFields.filter((f) => f.endsWith('_id'));
  const nameFields = groupFields.filter((f) => f.endsWith('_name'));
  const joinCond = idFields
    .map((f) => `COALESCE(ads.${f}, '') = COALESCE(air.${f}, '')`)
    .join('\n        AND ');
  const idSelect = idFields.map((f) => `COALESCE(ads.${f}, air.${f}, '') AS ${f}`).join(',\n        ');
  const nameSelect = nameFields.map((f) => `COALESCE(ads.${f}, air.${f}) AS ${f}`).join(',\n        ');
  return `
      SELECT
        ${idSelect}${nameSelect ? `,\n        ${nameSelect}` : ''},
        COALESCE(ads.spend, 0)::numeric(14,2) AS spend,
        COALESCE(ads.day_1_revenue, 0)::numeric(14,2) AS day_1_revenue,
        CASE WHEN COALESCE(ads.total_attributed_orders, 0) > 0
          THEN ROUND(COALESCE(ads.day_1_revenue, 0) / ads.total_attributed_orders, 2)
          ELSE NULL END AS aov,
        COALESCE(ads.total_attributed_orders, 0)::numeric(14,2) AS total_attributed_orders,
        COALESCE(air.air_orders, 0)::int AS air_orders,
        COALESCE(air.attributed_air_orders, 0)::numeric(14,2) AS attributed_air_orders,
        COALESCE(air.attributed_air_revenue, 0)::numeric(14,2) AS attributed_air_revenue,
        COALESCE(air.ttp_mature_air_orders, 0)::numeric(14,2) AS ttp_mature_air_orders,
        COALESCE(air.ttp_paid_air_orders, 0)::numeric(14,2) AS ttp_paid_air_orders,
        COALESCE(air.ttp_mature_subscribers, 0)::int AS ttp_mature_subscribers,
        COALESCE(air.ttp_paid_subscribers, 0)::int AS ttp_paid_subscribers
      FROM (
        SELECT ${groupCols},
          SUM(spend)::numeric(14,2) AS spend,
          SUM(revenue)::numeric(14,2) AS day_1_revenue,
          SUM(purchases)::numeric(14,2) AS total_attributed_orders
        FROM ${metaAdsDailySourceSql('$1::date AND $2::date')} ads_src
        WHERE ads_src.brand = 'NOBL'
        GROUP BY ${groupCols}
      ) ads
      FULL OUTER JOIN (
        SELECT ${groupCols},
          SUM(air_orders)::int AS air_orders,
          SUM(attributed_air_orders)::numeric(14,2) AS attributed_air_orders,
          SUM(attributed_air_revenue)::numeric(14,2) AS attributed_air_revenue,
          SUM(ttp_mature_air_orders)::numeric(14,2) AS ttp_mature_air_orders,
          SUM(ttp_paid_air_orders)::numeric(14,2) AS ttp_paid_air_orders,
          SUM(ttp_mature_subscribers)::int AS ttp_mature_subscribers,
          SUM(ttp_paid_subscribers)::int AS ttp_paid_subscribers
        FROM nobl_air_meta_ad_daily
        WHERE brand = 'NOBL'
          AND date BETWEEN $1::date AND $2::date
        GROUP BY ${groupCols}
      ) air ON ${joinCond}`;
}

async function main() {
  const sql = `
    SELECT grouped.*
    FROM (
      ${airAttrMergedGroupedSubquery(groupCols, groupFields)}
    ) grouped
    WHERE (grouped.spend > 0 OR grouped.air_orders > 0 OR grouped.attributed_air_orders > 0)
    ORDER BY grouped.spend DESC NULLS LAST
    LIMIT 5
  `;
  try {
    const r = await pgQuery(sql, [start, end]);
    console.log('OK rows:', r.rows.length, r.rows[0]?.ad_name?.slice(0, 40));
  } catch (e) {
    console.error('ERR:', e.message);
    // print part of sql around GROUP BY ads
  }
}

main();
