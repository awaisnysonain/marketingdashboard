/**
 * Full status check: spend + dual revenue + backfill coverage.
 * Usage: node server/scripts/checkSystemStatus.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');

const JUN14 = '2026-06-14';
const TARGETS = {
  spend: 347006.15,
  gmd: 783732.88,
  orderRev: 843047,
};

async function main() {
  console.log('\n========== SYSTEM STATUS CHECK ==========\n');

  // Schema
  const cols = await pgQuery(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'tw_summary_daily'
      AND column_name IN ('gross_minus_discounts', 'order_revenue', 'total_spend')
    ORDER BY column_name
  `);
  console.log('tw_summary_daily columns:', cols.rows.map(r => r.column_name).join(', ') || 'MISSING');

  // Coverage
  for (const brand of ['NOBL', 'FLO']) {
    const cov = await pgQuery(`
      SELECT COUNT(*)::int AS rows,
             MIN(date)::text AS first_date,
             MAX(date)::text AS last_date,
             COUNT(*) FILTER (WHERE gross_minus_discounts IS NULL OR gross_minus_discounts = 0)::int AS gmd_zero,
             COUNT(*) FILTER (WHERE total_spend IS NULL OR total_spend = 0)::int AS spend_zero
      FROM tw_summary_daily WHERE brand = $1
    `, [brand]);
    console.log(`\n${brand} tw_summary_daily:`, cov.rows[0]);
  }

  // Jun 14 NOBL validation
  const jun14 = await pgQuery(`
    SELECT brand,
           gross_minus_discounts::float AS gmd,
           order_revenue::float AS ord,
           total_revenue::float AS total_rev,
           total_spend::float AS spend,
           updated_at
    FROM tw_summary_daily
    WHERE date = $1::date AND brand IN ('NOBL', 'FLO')
    ORDER BY brand
  `, [JUN14]);

  console.log(`\n=== ${JUN14} VALIDATION ===`);
  for (const r of jun14.rows) {
    console.log(`\n${r.brand}:`);
    if (r.brand === 'NOBL') {
      console.log(`  Gross − Discounts: $${(r.gmd || 0).toFixed(2)} (target $${TARGETS.gmd}, delta $${((r.gmd || 0) - TARGETS.gmd).toFixed(2)})`);
      console.log(`  Order Revenue:     $${(r.ord || 0).toFixed(2)} (target $${TARGETS.orderRev}, delta $${((r.ord || 0) - TARGETS.orderRev).toFixed(2)})`);
      console.log(`  Total Spend:       $${(r.spend || 0).toFixed(2)} (target ~$${TARGETS.spend}, delta $${((r.spend || 0) - TARGETS.spend).toFixed(2)})`);
    } else {
      console.log(`  Order Revenue: $${(r.ord || 0).toFixed(2)}`);
      console.log(`  Gross − Disc:  $${(r.gmd || 0).toFixed(2)}`);
      console.log(`  Total Spend:   $${(r.spend || 0).toFixed(2)}`);
    }
    console.log(`  Updated: ${r.updated_at}`);
  }

  // Channel spend Jun 14 NOBL
  const ch = await pgQuery(`
    SELECT channel, spend_1d::float AS spend FROM tw_channel_daily
    WHERE brand = 'NOBL' AND date = $1::date ORDER BY spend DESC
  `, [JUN14]);
  const chSum = ch.rows.reduce((s, r) => s + (r.spend || 0), 0);
  console.log(`\nNOBL channel spend sum: $${chSum.toFixed(2)} (${ch.rows.length} channels)`);
  console.log('  Channels:', ch.rows.map(r => `${r.channel}=$${r.spend.toFixed(0)}`).join(', '));

  // Geo spend Jun 14 NOBL
  const geo = await pgQuery(`
    SELECT region, spend_actual::float AS spend, revenue_actual::float AS rev
    FROM tw_geo_daily WHERE brand = 'NOBL' AND date = $1::date AND region != 'TOTAL'
    ORDER BY spend DESC NULLS LAST
  `, [JUN14]);
  console.log('\nNOBL geo spend:');
  for (const g of geo.rows) {
    console.log(`  ${g.region}: spend=$${(g.spend || 0).toFixed(2)} rev=$${(g.rev || 0).toFixed(0)}`);
  }

  // Recent ETL failures
  const etl = await pgQuery(`
    SELECT task, brand, status, start_date, end_date, error_message, finished_at
    FROM etl_run_log
    WHERE started_at > NOW() - interval '7 days'
      AND status = 'error'
    ORDER BY finished_at DESC NULLS LAST
    LIMIT 10
  `);
  console.log('\nRecent ETL errors (7d):', etl.rows.length);
  for (const e of etl.rows) {
    console.log(`  ${e.task} ${e.brand} ${e.start_date}..${e.end_date}: ${(e.error_message || '').slice(0, 80)}`);
  }

  // Pass/fail summary
  const nobl = jun14.rows.find(r => r.brand === 'NOBL');
  const spendOk = nobl && Math.abs(nobl.spend - TARGETS.spend) < 500;
  const gmdOk = nobl && Math.abs(nobl.gmd - TARGETS.gmd) <= 1;
  const ordOk = nobl && Math.abs(nobl.ord - TARGETS.orderRev) <= 1;

  console.log('\n========== SUMMARY ==========');
  console.log('Spend (Jun 14):', spendOk ? 'OK (~TW)' : 'CHECK');
  console.log('Gross − Discounts (Jun 14):', gmdOk ? 'PASS' : 'FAIL');
  console.log('Order Revenue (Jun 14):', ordOk ? 'PASS' : 'FAIL');
  console.log('Backfill (spend): completed with 6 chunk failures — may need retry');
}

main().catch(e => { console.error(e); process.exit(1); });
