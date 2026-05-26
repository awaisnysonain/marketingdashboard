/**
 * Full Meta + TW ads + Air attribution backfill (no table truncate).
 *
 *   node server/scripts/runFullMetaAirBackfill.js
 *   node server/scripts/runFullMetaAirBackfill.js 2024-01-01 2026-05-26
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { runSync } = require('../etl/syncEngine');
const { invalidateNoblAirDataVersionCache } = require('../utils/noblAirDataVersion');
const { clearResponseCache } = require('../utils/responseCache');

const TODAY = new Date().toISOString().slice(0, 10);
const START = process.argv[2] || '2024-01-01';
const END = process.argv[3] || TODAY;

async function main() {
  const t0 = Date.now();
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  FULL META + ADS BACKFILL`);
  console.log(`  Range: ${START} → ${END}`);
  console.log(`  Tasks: meta_ads → tw_ads → tw_air_attribution (+ cache rebuild)`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const result = await runSync({
    runId: `full_meta_air_${Date.now()}`,
    tasks: ['meta_ads', 'tw_ads', 'tw_air_attribution'],
    startDate: START,
    endDate: END,
    brands: ['NOBL', 'FLO'],
    mode: 'backfill',
  });

  invalidateNoblAirDataVersionCache();
  clearResponseCache('nobl-air');

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  FINISHED in ${mins} min — ${result.totalRows?.toLocaleString?.() ?? result.totalRows} rows`);
  console.log(`  Errors: ${result.errors?.length ?? 0}`);
  if (result.errors?.length) {
    result.errors.slice(0, 15).forEach((e) => console.log(`    - ${e}`));
    if (result.errors.length > 15) console.log(`    ... +${result.errors.length - 15} more`);
  }
  console.log('═══════════════════════════════════════════════════════════');

  process.exit(result.errors?.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
