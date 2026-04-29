/**
 * ══════════════════════════════════════════════════════════════════
 *  Full Database Backfill Script
 *
 *  • Clears ALL ETL tables first (full reset)
 *  • Uses TW Summary Page API (working) — NOT Willy SQL (unavailable)
 *  • tw_refresh now also populates tw_channel_daily in one pass
 *
 *  Revenue (canonical, matches TW UI):
 *    order_revenue  = sales metric  (Shopify + Amazon, before refunds)
 *    amazon_revenue = amazonSales   (Amazon portion)
 *    shopify_revenue= sales − amazonSales
 *    total_sales    = netSales      (after refunds)
 *    total_spend    = blendedAds    (all Shopify-connected ad platforms)
 *
 *  Safe to re-run — all upserts use ON CONFLICT DO UPDATE.
 *  Run: node server/etl/runFullBackfill.js
 * ══════════════════════════════════════════════════════════════════
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pgRun } = require('../db/postgres');
const { runSync } = require('./syncEngine');

const TODAY      = new Date().toISOString().slice(0, 10);
const START_DATE = '2024-01-01';
const BRANDS     = ['NOBL', 'FLO'];

let stepsDone  = 0;
let stepsTotal = 0;
const stepResults = [];

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

function logStep(label, result) {
  stepsDone++;
  const pct  = Math.round((stepsDone / stepsTotal) * 100);
  const rows  = result?.totalRows ?? 0;
  const errs  = result?.errors?.length ?? 0;
  log(`[${pct}%] ✓ ${label} — ${rows} rows${errs ? `, ${errs} errors` : ''}`);
  stepResults.push({ label, rows, errors: result?.errors ?? [] });
}

async function step(label, tasks, startDate, endDate, brands) {
  log(`▶ ${label} (${startDate} → ${endDate}, brands: ${brands.join(',')})`);
  try {
    const result = await runSync({
      runId:     `backfill_${label.replace(/\s+/g, '_')}_${Date.now()}`,
      tasks,
      startDate,
      endDate,
      brands,
      mode: 'backfill',
    });
    logStep(label, result);
    return result;
  } catch (e) {
    log(`✗ ${label} FAILED: ${e.message}`);
    stepResults.push({ label, rows: 0, errors: [e.message] });
  }
}

async function clearAllTables() {
  log('🗑  Clearing all ETL tables for full reset…');
  const tables = [
    'tw_summary_daily',
    'tw_channel_daily',
    'tw_geo_daily',
    'tw_ads_daily',
    'tw_orders_detail',
    'tw_sessions_daily',
    'tw_customers',
    'tw_customer_segments',
    'tw_refunds_daily',
    'tw_email_sms_daily',
    'tw_benchmarks',
    'klaviyo_daily',
    'appstle_subscriptions',
    'nobl_air_sub_revenue_daily',
  ];

  for (const t of tables) {
    try {
      await pgRun(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`, []);
      log(`  ✓ ${t} cleared`);
    } catch (e) {
      log(`  ⚠ ${t}: ${e.message}`);
    }
  }
  log('🗑  All tables cleared.\n');
}

async function main() {
  const t0 = Date.now();
  log('═══════════════════════════════════════════════════════════');
  log(`  FULL DATABASE BACKFILL — COMPLETE RESET`);
  log(`  Range: ${START_DATE} → ${TODAY}`);
  log(`  Brands: ${BRANDS.join(', ')}`);
  log('═══════════════════════════════════════════════════════════');

  await clearAllTables();

  stepsTotal = 3;

  // ── 1. TW Summary + Channels (tw_refresh now populates both) ────
  //    Pulls: order_revenue, amazon_revenue, shopify_revenue,
  //           total_sales, refund_amount, total_spend (blendedAds),
  //           total_orders, new/returning customers
  //    ALSO:  tw_channel_daily — META, GOOGLE, TIKTOK, SNAPCHAT,
  //           PINTEREST, BING, APPLOVIN spend + attributed revenue
  await step('TW Summary + Channels', ['tw_refresh'], START_DATE, TODAY, BRANDS);

  // ── 2. Klaviyo (email stats — separate Klaviyo API) ─────────────
  await step('Klaviyo', ['klaviyo'], START_DATE, TODAY, BRANDS);

  // ── 3. Appstle (subscription revenue — NOBL only) ───────────────
  await step('Appstle', ['appstle'], START_DATE, TODAY, ['NOBL']);

  // ── Summary ───────────────────────────────────────────────────
  const elapsed     = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  const totalRows   = stepResults.reduce((s, r) => s + r.rows,          0);
  const totalErrors = stepResults.reduce((s, r) => s + r.errors.length, 0);

  log('');
  log('═══════════════════════════════════════════════════════════');
  log(`  BACKFILL COMPLETE — ${elapsed} minutes`);
  log(`  Total rows written: ${totalRows.toLocaleString()}`);
  log(`  Total errors: ${totalErrors}`);
  log('═══════════════════════════════════════════════════════════');
  log('Step summary:');
  stepResults.forEach(r => {
    const status = r.errors.length ? '⚠' : '✓';
    log(`  ${status} ${r.label.padEnd(30)} ${String(r.rows).padStart(8)} rows`);
  });

  if (totalErrors > 0) {
    log('\nErrors:');
    stepResults.forEach(r => {
      if (r.errors.length) {
        log(`  [${r.label}]`);
        r.errors.slice(0, 5).forEach(e => log(`    - ${e}`));
        if (r.errors.length > 5) log(`    ... and ${r.errors.length - 5} more`);
      }
    });
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
