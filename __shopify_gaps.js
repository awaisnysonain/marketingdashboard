/**
 * Backfill Shopify orders for the months that are missing or partial.
 * Uses our (corrected) shopifyOrders ETL with America/New_York date keys
 * and proper has_air / has_luggage / is_rebill detection.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { syncShopifyOrders } = require('./server/etl/shopifyOrders');
const { pgQuery } = require('./server/db/postgres');

// Months that were missing or had < expected counts
const RANGES = [
  // Catch the gap days in 2025-07 (only 1K orders found vs ~25K expected)
  ['2025-07-01', '2025-07-31'],
  // 2025-08 had 8K vs expected ~25K — partial
  ['2025-08-01', '2025-08-31'],
  // 2025-12 was partial
  ['2025-12-01', '2025-12-31'],
  // All of 2026 was never fetched
  ['2026-01-01', '2026-01-31'],
  ['2026-02-01', '2026-02-28'],
  ['2026-03-01', '2026-03-31'],
  ['2026-04-01', '2026-04-30'],
];

(async () => {
  const t0 = Date.now();
  for (const [s, e] of RANGES) {
    for (const brand of ['NOBL', 'FLO']) {
      const t1 = Date.now();
      try {
        const r = await syncShopifyOrders(brand, s, e);
        console.log(`  ${brand} ${s}..${e}  rows=${r.rows}  errs=${r.errors.length}  [${((Date.now()-t1)/1000).toFixed(0)}s]`);
      } catch (err) {
        console.log(`  ${brand} ${s}..${e}  FAIL: ${err.message}`);
      }
    }
  }

  // Re-classify the WHOLE table (handles the older orders' has_air/has_luggage from JSONB)
  console.log('\nRe-classifying has_air/has_luggage/is_rebill from JSONB…');
  await pgQuery(`
    UPDATE shopify_orders_raw o SET
      has_air     = (SELECT BOOL_OR(UPPER(li ->> 'sku') LIKE 'NOBLAIR%') FROM jsonb_array_elements(o.line_items) li),
      has_luggage = (SELECT BOOL_OR(
                       UPPER(li ->> 'sku') LIKE 'ALL%' OR UPPER(li ->> 'sku') LIKE 'DUO%' OR
                       UPPER(li ->> 'sku') LIKE 'METAL%' OR UPPER(li ->> 'sku') LIKE 'FD%' OR
                       UPPER(li ->> 'sku') LIKE 'WB%' OR UPPER(li ->> 'sku') LIKE 'EP%')
                     FROM jsonb_array_elements(o.line_items) li),
      updated_at  = NOW()
  `);
  await pgQuery(`UPDATE shopify_orders_raw SET is_rebill = (has_air AND NOT has_luggage)`);

  console.log('\nFinal verification (NOBL by month):');
  const v = await pgQuery(`
    SELECT date_trunc('month', date_key)::date AS m, COUNT(*)::int total,
           COUNT(*) FILTER (WHERE has_air AND has_luggage)::int air,
           COUNT(*) FILTER (WHERE is_rebill)::int rebill
    FROM shopify_orders_raw WHERE brand='NOBL' GROUP BY m ORDER BY m`, []);
  v.rows.forEach(r => console.log(' ', {
    m: r.m.toISOString().slice(0,7), total: r.total, air: r.air, rebill: r.rebill,
    attach: r.total > 0 ? (r.air / r.total * 100).toFixed(2) + '%' : '',
  }));

  console.log(`\nDONE in ${((Date.now()-t0)/60000).toFixed(1)} min`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
