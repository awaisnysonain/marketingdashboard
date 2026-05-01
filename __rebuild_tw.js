/**
 * Clean rebuild of tw_summary_daily, tw_channel_daily, tw_geo_daily, tw_product_daily
 * using Brad's queries via the (now working) /orcabase/api/sql endpoint.
 *
 * 1. TRUNCATE the four tables
 * 2. Refresh NOBL + FLO for 2024-01-01 → today in 30-day chunks
 * 3. Verify final state
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { refreshBrand } = require('./server/etl/tripleWhaleSQL');
const { pgQuery, pgRun } = require('./server/db/postgres');

const START = '2024-01-01';
const END   = new Date().toISOString().slice(0, 10);
const CHUNK = 30; // days per chunk

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

(async () => {
  const t0 = Date.now();
  console.log(`[REBUILD-TW] ${START} → ${END}`);

  // 1. Truncate the affected tables (NOT shopify_orders_raw, NOT nobl_air_*)
  console.log('[REBUILD-TW] Truncating tw_summary_daily, tw_channel_daily, tw_geo_daily, tw_product_daily…');
  await pgRun(`TRUNCATE TABLE tw_summary_daily RESTART IDENTITY`);
  await pgRun(`TRUNCATE TABLE tw_channel_daily RESTART IDENTITY`);
  await pgRun(`TRUNCATE TABLE tw_geo_daily     RESTART IDENTITY`);
  await pgRun(`TRUNCATE TABLE tw_product_daily RESTART IDENTITY`);
  console.log('[REBUILD-TW] Cleared.\n');

  // 2. Iterate chunks for each brand
  let chunkStart = START;
  while (chunkStart <= END) {
    let chunkEnd = addDays(chunkStart, CHUNK - 1);
    if (chunkEnd > END) chunkEnd = END;
    for (const brand of ['NOBL', 'FLO']) {
      const t1 = Date.now();
      try {
        const r = await refreshBrand(brand, chunkStart, chunkEnd);
        console.log(`  ${brand} ${chunkStart}..${chunkEnd}  rows=${r.rows} channels=${r.channelRows}  [${((Date.now()-t1)/1000).toFixed(0)}s]`);
      } catch (e) {
        console.log(`  ${brand} ${chunkStart}..${chunkEnd}  FAIL: ${e.message}`);
      }
    }
    chunkStart = addDays(chunkEnd, 1);
  }

  // 3. Verify
  const v1 = await pgQuery(`
    SELECT brand, COUNT(*)::int n, MIN(date)::date AS first, MAX(date)::date AS last,
           SUM(total_revenue)::numeric(14,2) AS total_rev,
           SUM(amazon_revenue)::numeric(14,2) AS total_amazon,
           SUM(total_spend)::numeric(14,2) AS total_spend
    FROM tw_summary_daily GROUP BY brand`, []);
  console.log('\n=== tw_summary_daily ==='); v1.rows.forEach(r => console.log(' ', r));

  const v2 = await pgQuery(`
    SELECT brand, COUNT(*)::int n, COUNT(DISTINCT channel)::int channels
    FROM tw_channel_daily GROUP BY brand`, []);
  console.log('\n=== tw_channel_daily ==='); v2.rows.forEach(r => console.log(' ', r));

  const v3 = await pgQuery(`
    SELECT brand, region, COUNT(*)::int n, SUM(revenue_actual)::numeric(14,2) AS total_rev
    FROM tw_geo_daily GROUP BY brand, region ORDER BY brand, region`, []);
  console.log('\n=== tw_geo_daily ==='); v3.rows.forEach(r => console.log(' ', r));

  const v4 = await pgQuery(`
    SELECT brand, product_line, COUNT(*)::int n, SUM(revenue)::numeric(14,2) AS rev, SUM(spend)::numeric(14,2) AS spend
    FROM tw_product_daily GROUP BY brand, product_line ORDER BY brand, product_line`, []);
  console.log('\n=== tw_product_daily ==='); v4.rows.forEach(r => console.log(' ', r));

  console.log(`\n[REBUILD-TW] DONE in ${((Date.now()-t0)/60000).toFixed(1)} min`);
  process.exit(0);
})().catch(e => { console.error('[REBUILD-TW] FATAL:', e); process.exit(1); });
