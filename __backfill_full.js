/**
 * FULL BACKFILL — Shopify orders + Appstle contracts + nobl_air_daily + product_daily
 * Range: 2024-01-01 → today
 * Memory-safe: processes 30-day chunks, persists after each chunk.
 *
 * Run:  node __backfill_full.js
 * Background:  node __backfill_full.js > data/full_backfill.log 2>&1 &
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { syncShopifyOrders } = require('./server/etl/shopifyOrders');
const { syncAppstleContracts } = require('./server/etl/appstleContracts');
const { aggregateNoblAir, aggregateProductDaily } = require('./server/etl/noblAirAggregate');
const { pgQuery, pgRun } = require('./server/db/postgres');

const START = '2024-01-01';
const END   = new Date().toISOString().slice(0, 10);
const CHUNK_DAYS = 30;

function addDays(d, n) {
  const x = new Date(d); x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

async function fillWatermark(taskName, lastDate) {
  await pgRun(`
    INSERT INTO etl_watermarks (task_name, last_complete_date, last_run_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (task_name) DO UPDATE SET
      last_complete_date = EXCLUDED.last_complete_date,
      last_run_at = NOW()
  `, [taskName, lastDate]);
}

(async () => {
  const t0 = Date.now();
  console.log(`[BACKFILL] full pipeline ${START} → ${END}\n`);

  // ── PHASE 1: Appstle (one-shot, gets all 18,775 contracts) ───────────
  console.log('[BACKFILL] Phase 1: Appstle contracts (one-shot)');
  const appstle = await syncAppstleContracts();
  console.log(`  → ${appstle.rows} contracts loaded, ${appstle.errors.length} errors\n`);

  // ── PHASE 2: Shopify orders for both brands, 30-day chunks ────────────
  console.log('[BACKFILL] Phase 2: Shopify orders (NOBL + FLO), 30-day chunks');
  let chunkStart = START;
  while (chunkStart <= END) {
    let chunkEnd = addDays(chunkStart, CHUNK_DAYS - 1);
    if (chunkEnd > END) chunkEnd = END;
    const t1 = Date.now();
    process.stdout.write(`  ${chunkStart}..${chunkEnd}  `);
    try {
      const nobl = await syncShopifyOrders('NOBL', chunkStart, chunkEnd);
      const flo  = await syncShopifyOrders('FLO',  chunkStart, chunkEnd);
      const elapsed = ((Date.now() - t1) / 1000).toFixed(0);
      console.log(`NOBL=${nobl.rows} FLO=${flo.rows} [${elapsed}s]`);
    } catch (e) {
      console.log('ERR:', e.message);
    }
    chunkStart = addDays(chunkEnd, 1);
  }
  console.log();

  // ── PHASE 3: Aggregate nobl_air_daily over the full range ─────────────
  console.log('[BACKFILL] Phase 3: nobl_air_daily aggregation');
  const t3 = Date.now();
  const a = await aggregateNoblAir(START, END);
  console.log(`  → ${a.rows} day-rows written [${((Date.now()-t3)/1000).toFixed(0)}s]\n`);

  // ── PHASE 4: Product daily for both brands ────────────────────────────
  console.log('[BACKFILL] Phase 4: shopify_product_daily aggregation');
  const t4 = Date.now();
  const p1 = await aggregateProductDaily('NOBL', START, END);
  const p2 = await aggregateProductDaily('FLO',  START, END);
  console.log(`  → NOBL: ${p1.rows} rows, FLO: ${p2.rows} rows [${((Date.now()-t4)/1000).toFixed(0)}s]\n`);

  // ── Watermarks ────────────────────────────────────────────────────────
  await fillWatermark('shopify_orders', END);
  await fillWatermark('appstle_contracts', END);
  await fillWatermark('nobl_air_daily', END);
  await fillWatermark('shopify_product_daily', END);

  // ── Verification summary ──────────────────────────────────────────────
  console.log('=== VERIFICATION ===');
  const v1 = await pgQuery(`
    SELECT brand, COUNT(*)::int AS n, MIN(date_key)::date AS first, MAX(date_key)::date AS last
    FROM shopify_orders_raw GROUP BY brand`, []);
  console.log('shopify_orders_raw:'); v1.rows.forEach(r => console.log(' ', r));

  const v2 = await pgQuery(`
    SELECT COUNT(*)::int AS n,
           SUM(CASE WHEN status='active' THEN 1 ELSE 0 END)::int AS active,
           ROUND(AVG(contract_amount)::numeric,2) AS avg_tier
    FROM nobl_air_subscribers`, []);
  console.log('nobl_air_subscribers:', v2.rows[0]);

  const v3 = await pgQuery(`
    SELECT COUNT(*)::int AS days, MIN(date)::date AS first, MAX(date)::date AS last,
           SUM(combined_net_revenue)::numeric(14,2) AS total_rev,
           SUM(air_orders)::int AS total_air, SUM(total_orders)::int AS total_ord,
           ROUND(AVG(attach_rate)::numeric, 4) AS avg_attach
    FROM nobl_air_daily`, []);
  console.log('nobl_air_daily:', v3.rows[0]);

  const v4 = await pgQuery(`
    SELECT brand, COUNT(*)::int AS rows, COUNT(DISTINCT product_title)::int AS distinct_products
    FROM shopify_product_daily GROUP BY brand`, []);
  console.log('shopify_product_daily:'); v4.rows.forEach(r => console.log(' ', r));

  console.log(`\n[BACKFILL] DONE in ${((Date.now()-t0)/60000).toFixed(1)} min`);
  process.exit(0);
})().catch(e => { console.error('[BACKFILL] FATAL:', e); process.exit(1); });
