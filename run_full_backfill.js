/**
 * Full backfill: 2025-01-01 → 2026-04-27
 * Runs: TW summary (NOBL + FLO) + Klaviyo (NOBL + FLO)
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { runSync } = require('./server/etl/syncEngine');

const START  = '2025-01-01';
const END    = '2026-04-27';
const RUN_ID = `backfill_${Date.now()}`;

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`FULL BACKFILL: ${START} → ${END}`);
  console.log(`Run ID: ${RUN_ID}`);
  console.log(`${'='.repeat(60)}\n`);

  const t0 = Date.now();

  const result = await runSync({
    runId: RUN_ID,
    tasks: ['tw_refresh', 'klaviyo'],
    brands: ['NOBL', 'FLO'],
    startDate: START,
    endDate: END,
  });

  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`BACKFILL COMPLETE in ${elapsed} minutes`);
  console.log(`Total rows: ${result.totalRows}`);
  console.log(`Errors: ${result.errors.length}`);
  if (result.errors.length) {
    console.log('Error details:');
    result.errors.slice(0, 20).forEach(e => console.log(' ', e));
  }
  console.log(`${'='.repeat(60)}\n`);

  process.exit(0);
}

main().catch(e => { console.error('[Backfill FATAL]', e); process.exit(1); });
