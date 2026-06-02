/**
 * Backfill tw_summary_daily, tw_channel_daily, tw_geo_daily, tw_product_daily
 * using tripleWhaleSQL (Brad queries). Recent months first so the dashboard updates quickly.
 *
 * Usage: node server/scripts/backfillTwSql.js [startYmd] [endYmd]
 * Default: 2024-01-01 → today
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { refreshBrand } = require('../etl/tripleWhaleSQL');
const { pgQuery, pgRun } = require('../db/postgres');

const DEFAULT_START = '2024-01-01';
const DEFAULT_END = new Date().toISOString().slice(0, 10);
const CHUNK_DAYS = 30;

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildChunks(start, end) {
  const chunks = [];
  let cur = start;
  while (cur <= end) {
    let chunkEnd = addDays(cur, CHUNK_DAYS - 1);
    if (chunkEnd > end) chunkEnd = end;
    chunks.push({ start: cur, end: chunkEnd });
    cur = addDays(chunkEnd, 1);
  }
  return chunks;
}

/** Newest windows first (e.g. May 2026 before Jan 2024). */
function prioritizeRecent(chunks) {
  return [...chunks].sort((a, b) => b.start.localeCompare(a.start));
}

async function verifyMayFlo() {
  const r = await pgQuery(`
    SELECT product_line,
           SUM(spend)::numeric(12,2) spend,
           SUM(revenue)::numeric(12,2) rev,
           SUM(new_cust_orders)::int units
    FROM tw_product_daily
    WHERE brand='FLO' AND date >= '2026-05-01' AND date < '2026-06-01'
    GROUP BY product_line ORDER BY product_line
  `);
  console.log('\n[VERIFY] FLO May 2026 tw_product_daily:');
  for (const row of r.rows) console.log(' ', row);
}

(async () => {
  const start = process.argv[2] || DEFAULT_START;
  const end = process.argv[3] || DEFAULT_END;
  const t0 = Date.now();
  console.log(`[backfillTwSql] ${start} → ${end} (recent-first, ${CHUNK_DAYS}-day chunks)`);

  const chunks = prioritizeRecent(buildChunks(start, end));
  console.log(`[backfillTwSql] ${chunks.length} chunks × 2 brands\n`);

  let ok = 0;
  let fail = 0;
  for (const { start: cs, end: ce } of chunks) {
    for (const brand of ['FLO', 'NOBL']) {
      const t1 = Date.now();
      try {
        const r = await refreshBrand(brand, cs, ce);
        console.log(`  ✓ ${brand} ${cs}..${ce}  summary=${r.rows} channels=${r.channelRows}  [${((Date.now() - t1) / 1000).toFixed(0)}s]`);
        ok++;
        if (brand === 'FLO' && cs >= '2026-05-01' && ce <= '2026-05-31') await verifyMayFlo();
      } catch (e) {
        console.log(`  ✗ ${brand} ${cs}..${ce}  ${e.message}`);
        fail++;
      }
    }
  }

  await verifyMayFlo();
  const v = await pgQuery(`
    SELECT brand, COUNT(*)::int n, MIN(date)::date first, MAX(date)::date last
    FROM tw_product_daily GROUP BY brand
  `);
  console.log('\n[backfillTwSql] tw_product_daily coverage:', v.rows);
  console.log(`[backfillTwSql] DONE in ${((Date.now() - t0) / 60000).toFixed(1)} min (${ok} ok, ${fail} fail)`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('[backfillTwSql] FATAL:', e); process.exit(1); });
