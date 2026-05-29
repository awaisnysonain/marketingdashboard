/**
 * Verify server-side spend sort + Meta data for NOBL Air Meta table.
 * Usage: node server/scripts/verifyMetaAirSort.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pgQuery } = require('../db/postgres');
const { metaAdsDailySourceSql } = require('../etl/metaAdsSync');

const START = '2026-01-01';
const END = '2026-05-26';
const PAGE_SIZE = 20;
const AD_NEEDLE = '010526_CanWeTalk';

async function topSpendPage(page) {
  const offset = (page - 1) * PAGE_SIZE;
  const src = metaAdsDailySourceSql('$1::date AND $2::date');
  const r = await pgQuery(`
    SELECT ad_name, ad_id, SUM(spend)::numeric(14,2) AS spend
    FROM ${src} src
    WHERE brand = 'NOBL'
    GROUP BY ad_id, ad_name, campaign_id, campaign_name, adset_id, adset_name
    HAVING SUM(spend) > 0
    ORDER BY SUM(spend) DESC NULLS LAST, LOWER(COALESCE(ad_name, '')) ASC
    LIMIT $3 OFFSET $4
  `, [START, END, PAGE_SIZE, offset]);
  return r.rows;
}

async function main() {
  console.log('=== NOBL Air Meta sort & data verification ===');
  console.log(`Date range: ${START} → ${END}\n`);

  const counts = await pgQuery(`
    SELECT
      (SELECT COUNT(*)::int FROM meta_ads_daily WHERE brand='NOBL' AND date BETWEEN $1 AND $2) AS meta_rows,
      (SELECT COUNT(*)::int FROM tw_ads_daily WHERE brand='NOBL' AND platform='META' AND date BETWEEN $1 AND $2) AS tw_rows,
      (SELECT COUNT(DISTINCT ad_id)::int FROM meta_ads_daily WHERE brand='NOBL' AND date BETWEEN $1 AND $2) AS meta_ads,
      (SELECT COUNT(*)::int FROM nobl_air_meta_ad_daily WHERE brand='NOBL' AND date BETWEEN $1 AND $2) AS cache_rows
  `, [START, END]);
  const c = counts.rows[0];
  console.log('Database rows in range:');
  console.log(`  meta_ads_daily:        ${c.meta_rows} daily rows, ${c.meta_ads} unique ads`);
  console.log(`  tw_ads_daily (META):   ${c.tw_rows} daily rows`);
  console.log(`  nobl_air_meta_ad_daily: ${c.cache_rows} daily rows\n`);

  const page1 = await topSpendPage(1);
  const page2 = await topSpendPage(2);
  const page1Min = Math.min(...page1.map((r) => Number(r.spend)));
  const page2Max = Math.max(...page2.map((r) => Number(r.spend)));

  console.log('Global spend sort (page 1 vs page 2):');
  console.log(`  Page 1 top:  ${page1[0]?.ad_name?.slice(0, 50)} — $${page1[0]?.spend}`);
  console.log(`  Page 1 last: ${page1[page1.length - 1]?.ad_name?.slice(0, 50)} — $${page1[page1.length - 1]?.spend}`);
  console.log(`  Page 2 top:  ${page2[0]?.ad_name?.slice(0, 50)} — $${page2[0]?.spend}`);

  const sortOk = page1Min >= page2Max;
  console.log(`  Sort order OK (page1 min >= page2 max): ${sortOk ? 'YES ✓' : 'NO ✗'}\n`);

  const ad = await pgQuery(`
    SELECT ad_name, SUM(spend)::numeric(14,2) AS spend
    FROM meta_ads_daily
    WHERE brand = 'NOBL' AND date BETWEEN $1 AND $2
      AND ad_name ILIKE $3
    GROUP BY ad_name
    ORDER BY spend DESC
    LIMIT 5
  `, [START, END, `%${AD_NEEDLE}%`]);

  console.log(`Search "${AD_NEEDLE}" in meta_ads_daily:`);
  if (!ad.rows.length) {
    console.log('  NOT FOUND in Meta sync for this range ✗');
  } else {
    ad.rows.forEach((r) => console.log(`  ✓ ${r.ad_name} — $${r.spend}`));
    const merged = await pgQuery(`
      SELECT ad_name, SUM(spend)::numeric(14,2) AS spend
      FROM ${metaAdsDailySourceSql('$1::date AND $2::date')} src
      WHERE brand = 'NOBL' AND ad_name ILIKE $3
      GROUP BY ad_name
    `, [START, END, `%${AD_NEEDLE}%`]);
    console.log(`  In merged dashboard source: $${merged.rows[0]?.spend ?? 0}`);
  }

  const totalGrouped = await pgQuery(`
    SELECT COUNT(*)::int AS n FROM (
      SELECT ad_id
      FROM ${metaAdsDailySourceSql('$1::date AND $2::date')} src
      WHERE brand = 'NOBL'
      GROUP BY ad_id, ad_name, campaign_id, campaign_name, adset_id, adset_name
      HAVING SUM(spend) > 0 OR SUM(purchases) > 0
    ) t
  `, [START, END]);
  console.log(`\nTotal ads with spend in dashboard query: ${totalGrouped.rows[0].n}`);
  console.log(`Pages at ${PAGE_SIZE}/page: ${Math.ceil(totalGrouped.rows[0].n / PAGE_SIZE)}`);

  const failed = !sortOk || !c.meta_rows;
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
