/**
 * Backfill meta_ads_daily from Meta Marketing API, then refresh Air Meta cache.
 *
 * Usage:
 *   node server/scripts/syncMetaAdsBackfill.js
 *   node server/scripts/syncMetaAdsBackfill.js 2025-01-01 2026-05-26
 *   node server/scripts/syncMetaAdsBackfill.js 2025-01-01 2026-05-26 FLO
 *   node server/scripts/syncMetaAdsBackfill.js 2025-01-01 2026-05-26 ALL
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { syncMetaAds } = require('../etl/metaAdsSync');
const { metaConfiguredBrands } = require('../config/metaConfig');
const { refreshNoblAirMetaAdDaily } = require('../etl/noblAirMetaAdDaily');
const { invalidateNoblAirDataVersionCache } = require('../utils/noblAirDataVersion');
const { clearResponseCache } = require('../utils/responseCache');

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** 3-day chunks to avoid Meta “reduce the amount of data” errors on large accounts. */
function syncChunks(startDate, endDate) {
  const chunks = [];
  let cur = startDate;
  while (cur <= endDate) {
    const end = addDays(cur, 2) > endDate ? endDate : addDays(cur, 2);
    chunks.push({ start: cur, end });
    cur = addDays(end, 1);
  }
  return chunks;
}

async function main() {
  const today = toISO(new Date());
  const start = process.argv[2] || (() => {
    const d = new Date();
    d.setDate(1);
    return toISO(d);
  })();
  const end = process.argv[3] || today;
  const brandArg = String(process.argv[4] || 'NOBL').toUpperCase();
  const brands = brandArg === 'ALL'
    ? (metaConfiguredBrands().length ? metaConfiguredBrands() : ['NOBL'])
    : [brandArg];

  console.log(`Meta ads backfill: ${start} → ${end} | brands: ${brands.join(',')}`);
  const chunks = syncChunks(start, end);
  let total = 0;
  const errors = [];

  for (const brand of brands) {
    let brandTotal = 0;
    for (const chunk of chunks) {
      console.log(`  ${brand} ${chunk.start} .. ${chunk.end}`);
      const r = await syncMetaAds(brand, chunk.start, chunk.end);
      brandTotal += r.rows || 0;
      total += r.rows || 0;
      if (r.errors?.length) errors.push(...r.errors);
      if (r.skipped) {
        console.error(`Skipped ${brand}:`, r.errors?.[0] || 'no credentials');
        break;
      }
    }
    console.log(`  ${brand} upserted: ${brandTotal} row(s)`);
  }

  console.log(`Meta upserted total: ${total} row(s)`);
  if (errors.length) {
    console.warn('Errors:', errors.slice(0, 10).join('; '));
  }

  // The Air Meta cache is NOBL-specific; only refresh it when NOBL was synced.
  if (brands.includes('NOBL')) {
    console.log('Refreshing nobl_air_meta_ad_daily cache…');
    const agg = await refreshNoblAirMetaAdDaily(start, end);
    console.log(`Cache rows: ${agg.rows}`);
    invalidateNoblAirDataVersionCache();
    clearResponseCache('nobl-air');
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
