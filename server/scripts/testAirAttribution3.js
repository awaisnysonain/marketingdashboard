require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');
const { metaAdsDailySourceSql } = require('../etl/metaAdsSync');

const start = '2026-01-01';
const end = '2026-05-26';
const groupFields = ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'];
const groupCols = groupFields.join(', ');

function airAttrMergedGroupedSubquery(groupCols, groupFields) {
  const idFields = groupFields.filter((f) => f.endsWith('_id'));
  const nameFields = groupFields.filter((f) => f.endsWith('_name'));
  const adsGroupBy = groupFields.map((f) => `ads_src.${f}`).join(', ');
  const joinCond = idFields
    .map((f) => `COALESCE(ads.${f}, '') = COALESCE(air.${f}, '')`)
    .join('\n        AND ');
  const idSelect = idFields.map((f) => `COALESCE(ads.${f}, air.${f}, '') AS ${f}`).join(',\n        ');
  const nameSelect = nameFields.map((f) => `COALESCE(ads.${f}, air.${f}) AS ${f}`).join(',\n        ');
  return `
      SELECT
        ${idSelect}${nameSelect ? `,\n        ${nameSelect}` : ''},
        COALESCE(ads.spend, 0)::numeric(14,2) AS spend,
        COALESCE(air.air_orders, 0)::int AS air_orders,
        COALESCE(air.attributed_air_orders, 0)::numeric(14,2) AS attributed_air_orders
      FROM (
        SELECT ${groupCols},
          SUM(ads_src.spend)::numeric(14,2) AS spend
        FROM ${metaAdsDailySourceSql('$1::date AND $2::date')} ads_src
        WHERE ads_src.brand = 'NOBL'
        GROUP BY ${adsGroupBy}
      ) ads
      FULL OUTER JOIN (
        SELECT ${groupCols},
          SUM(air_orders)::int AS air_orders,
          SUM(attributed_air_orders)::numeric(14,2) AS attributed_air_orders
        FROM nobl_air_meta_ad_daily
        WHERE brand = 'NOBL'
          AND date BETWEEN $1::date AND $2::date
        GROUP BY ${groupCols}
      ) air ON ${joinCond}`;
}

async function main() {
  const sql = `
    SELECT COUNT(*)::int AS n FROM (
      ${airAttrMergedGroupedSubquery(groupCols, groupFields)}
    ) grouped
    WHERE grouped.spend > 0 OR grouped.air_orders > 0 OR grouped.attributed_air_orders > 0
  `;
  try {
    const r = await pgQuery(sql, [start, end]);
    console.log('OK count:', r.rows[0].n);
  } catch (e) {
    console.error('ERR:', e.message);
  }

  const searchSql = `
    SELECT grouped.ad_name, grouped.spend FROM (
      ${airAttrMergedGroupedSubquery(groupCols, groupFields)}
    ) grouped
    WHERE (grouped.spend > 0 OR grouped.air_orders > 0 OR grouped.attributed_air_orders > 0)
      AND COALESCE(grouped.ad_name::text, '') ILIKE $3
    ORDER BY grouped.spend DESC NULLS LAST
    LIMIT 5
  `;
  try {
    const r = await pgQuery(searchSql, [start, end, '%CanWeTalk%']);
    console.log('Search OK:', r.rows.length, r.rows.map((x) => x.ad_name?.slice(0, 40)));
  } catch (e) {
    console.error('Search ERR:', e.message);
  }
}

main();
