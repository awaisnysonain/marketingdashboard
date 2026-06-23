/**
 * NOBL UK backfill ETL — ADDITIVE, read-path-safe.
 *
 * Pulls the NOBL UK store's own Triple Whale workspace (wdwzan-tc) and writes
 * region='UK' rows into tw_geo_daily under brand='NOBL'. Those rows surface
 * automatically in the nobl_brand_tw_geo_daily view and every region-aware page
 * (UK is already a first-class region on the client).
 *
 * SAFETY GUARANTEES
 *   • Only ever upserts region='UK' rows. It never reads, updates, or deletes
 *     any existing region (US/CA/AUS/DUBAI/EU/OTHER/TOTAL) — so existing trusted
 *     numbers stay byte-for-byte identical.
 *   • It does NOT touch tw_summary_daily, so the headline NOBL total is unchanged.
 *     UK store revenue is exposed as a region breakdown only, not folded into the
 *     grand total (that would be a separate, explicit business decision).
 *   • DRY-RUN by default — it fetches and prints what it *would* write, but writes
 *     nothing. Pass --commit to actually upsert.
 *   • Spend is NOT written unless --include-spend is passed. The UK workspace's
 *     ads_table reports ~$320K/day — that is the shared/global NOBL ad account,
 *     not UK-attributed spend (UK store revenue is ~$7K/day). Writing it as UK
 *     spend would produce a nonsensical UK MER, so revenue-only is the default.
 *
 * Revenue metric matches how every other geo region is computed in
 * tripleWhaleSQL.js (raw orders_table.order_revenue, platform='shopify').
 *
 * Usage:
 *   node server/etl/syncNoblUk.js                            # dry-run 2026-06-01 → yesterday
 *   node server/etl/syncNoblUk.js 2026-06-01 2026-06-22      # dry-run explicit range
 *   node server/etl/syncNoblUk.js 2026-06-01 2026-06-22 --commit
 *   node server/etl/syncNoblUk.js 2026-06-01 2026-06-22 --commit --include-spend
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgRun, pool } = require('../db/postgres');
const { fetchShopifyRevenue, fetchAdSpend } = require('./tripleWhaleSQL');
const { brandCreds } = require('./twSqlApi');

const UK_BRAND = 'NOBL';        // UK rows live under the NOBL brand
const UK_REGION = 'UK';
const UK_WORKSPACE = 'NOBL_UK'; // brandCreds key for the UK TW workspace

function yesterdayISO() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {{ start?: string, end?: string, commit?: boolean, includeSpend?: boolean }} opts
 * @returns {Promise<{start,end,rows,written,totalRevenue,commit,includeSpend}>}
 */
async function syncNoblUk({ start, end, commit = false, includeSpend = false } = {}) {
  const startYmd = start || '2026-06-01';
  const endYmd = end || yesterdayISO();

  const { shopId, apiKey } = brandCreds(UK_WORKSPACE);
  if (!shopId || !apiKey) {
    throw new Error('[NOBL UK] Missing NOBL_UK_TW_SHOP_ID / NOBL_UK_TW_API_KEY in .env');
  }

  console.log(`[NOBL UK] ${commit ? 'COMMIT' : 'DRY-RUN'} ${startYmd} → ${endYmd}  (shop ${shopId}, includeSpend=${includeSpend})`);

  // Revenue: raw orders_table.order_revenue — identical metric to every other
  // geo region (see fetchRegionRevenue in tripleWhaleSQL.js).
  const revByDate = await fetchShopifyRevenue(UK_WORKSPACE, startYmd, endYmd);
  const spendByDate = includeSpend ? await fetchAdSpend(UK_WORKSPACE, startYmd, endYmd) : {};

  const allDates = new Set([...Object.keys(revByDate), ...Object.keys(spendByDate)]);
  const rows = [...allDates]
    .sort()
    .map((date) => {
      const revenue = Number(revByDate[date] || 0);
      const spend = includeSpend ? Number(spendByDate[date] || 0) : null;
      const mer = includeSpend && spend > 0 ? revenue / spend : null;
      return { date, revenue, spend, mer };
    })
    // Only days with real UK activity — skip pre-launch zero-revenue days.
    .filter((r) => r.revenue > 0 || (includeSpend && r.spend > 0));

  if (includeSpend) {
    const totRev = rows.reduce((s, r) => s + r.revenue, 0);
    const totSp = rows.reduce((s, r) => s + (r.spend || 0), 0);
    if (totSp > totRev * 3) {
      console.warn(`[NOBL UK] ⚠ spend ($${totSp.toFixed(0)}) ≫ revenue ($${totRev.toFixed(0)}). This is almost certainly the global ad account, not UK-attributed spend. Re-run without --include-spend unless you are sure.`);
    }
  }

  let totalRev = 0;
  let written = 0;
  for (const r of rows) {
    totalRev += r.revenue;
    console.log(`  ${r.date}  rev=${r.revenue.toFixed(2)}  spend=${r.spend == null ? 'NULL' : r.spend.toFixed(2)}  mer=${r.mer == null ? 'NULL' : r.mer.toFixed(2)}`);
    if (commit) {
      await pgRun(
        `INSERT INTO tw_geo_daily (brand, date, region, revenue_actual, spend_actual, mer)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (brand, date, region) DO UPDATE SET
           revenue_actual = EXCLUDED.revenue_actual,
           spend_actual   = EXCLUDED.spend_actual,
           mer            = EXCLUDED.mer,
           updated_at     = NOW()`,
        [UK_BRAND, r.date, UK_REGION, r.revenue, r.spend, r.mer],
      );
      written++;
    }
  }

  console.log(
    `[NOBL UK] ${commit ? `wrote ${written}` : `${rows.length} would-write`} region=UK rows · total revenue $${totalRev.toFixed(2)}${commit ? '' : '  (DRY-RUN — nothing written)'}`,
  );
  return { start: startYmd, end: endYmd, rows: rows.length, written, totalRevenue: totalRev, commit, includeSpend };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));
  syncNoblUk({
    start: positional[0],
    end: positional[1],
    commit: flags.includes('--commit'),
    includeSpend: flags.includes('--include-spend'),
  })
    .then(async (s) => { console.log('[NOBL UK] done:', JSON.stringify(s)); await pool.end().catch(() => {}); })
    .catch(async (e) => { console.error('[NOBL UK] failed:', e.message); await pool.end().catch(() => {}); process.exitCode = 1; });
}

module.exports = { syncNoblUk };
