/**
 * IAP sync — ADDITIVE, dry-run by default.
 *
 * Pulls Apple App Store Connect (real, validated) and Google Play (auth +
 * catalog validated; daily revenue is round 2) and upserts per-day IAP rollups
 * into iap_daily. Writes ONLY to iap_daily / iap_subscription_daily — brand-new
 * tables — so nothing existing is touched.
 *
 * Apply the schema first:  node server/db/applySchema.js   (loads iap_schema.sql)
 *
 * Usage:
 *   node server/etl/syncIap.js                          # dry-run, last 7 days, both brands
 *   node server/etl/syncIap.js 2026-06-15 2026-06-21    # dry-run explicit range
 *   node server/etl/syncIap.js 2026-06-15 2026-06-21 --commit
 *   node server/etl/syncIap.js 2026-06-15 2026-06-21 --commit --brand=NOBL
 *   node server/etl/syncIap.js 2026-04-01 2026-06-23 --commit --platform=google  # Play only
 *
 * Schedule (when ready): add an 'iap' task to syncEngine.runSync and the cron —
 * intentionally NOT auto-wired here so it never writes to prod unattended.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgRun, pool } = require('../db/postgres');
const { fetchAppleIapDaily, fetchAppleSubsDaily } = require('./iap/appleAppStore');
const { fetchPlayEarningsDaily, fetchPlaySubsDaily } = require('./iap/googlePlay');

const BRANDS = ['NOBL', 'FLO'];

// Skip brand/platform combos that don't have credentials configured. Prevents
// the nightly cron from logging 45 warnings-per-day for a brand that was never
// set up (e.g. NOBL has no Apple/Google IAP account) and lets the alerting
// layer surface a single "no creds" line instead.
function brandHasAppleCreds(brand) {
  const B = String(brand).toUpperCase();
  return !!(process.env[`${B}_APPLE_ISSUER_ID`]
    && process.env[`${B}_APPLE_KEY_ID`]
    && process.env[`${B}_APPLE_PRIVATE_KEY_PATH`]
    && process.env[`${B}_APPLE_VENDOR_NUMBER`]);
}
function brandHasGoogleCreds(brand) {
  const B = String(brand).toUpperCase();
  return !!(process.env[`${B}_GOOGLE_DEVELOPER_ACCOUNT_ID`]
    && process.env[`${B}_GOOGLE_PACKAGE_NAME`]
    && process.env[`${B}_GOOGLE_SERVICE_ACCOUNT_PATH`]);
}

function eachDate(start, end) {
  const out = [];
  for (let d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function daysAgoISO(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function upsertDay(brand, platform, agg, commit) {
  // Rollup row (product_id='ALL') + per-SKU rows.
  const rows = [['ALL', { units: agg.units, proceeds: agg.proceeds_raw, currency: agg.currency }]];
  for (const [sku, p] of Object.entries(agg.byProduct || {})) {
    rows.push([sku, { units: p.units, proceeds: p.proceeds, currency: p.currency || agg.currency }]);
  }
  if (!commit) return rows.length;
  for (const [productId, p] of rows) {
    const revUsd = productId === 'ALL'
      ? agg.revenue_usd
      : (p.currency === 'USD' ? p.proceeds : 0);
    await pgRun(
      `INSERT INTO iap_daily (brand, platform, date, product_id, units, revenue_usd, proceeds_raw, currency, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (brand, platform, date, product_id) DO UPDATE SET
         units=EXCLUDED.units, revenue_usd=EXCLUDED.revenue_usd, proceeds_raw=EXCLUDED.proceeds_raw,
         currency=EXCLUDED.currency, source=EXCLUDED.source, updated_at=NOW()`,
      [brand, platform, agg.date, productId, Math.round(p.units), revUsd, p.proceeds, p.currency || null, platform === 'apple' ? 'asc_sales_daily' : 'play'],
    );
  }
  return rows.length;
}

async function upsertSubsDay(brand, platform, agg, commit) {
  if (!commit) return;
  await pgRun(
    `INSERT INTO iap_subscription_daily (brand, platform, date, active_subs, new_subs, cancelled_subs, trials, proceeds_usd, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (brand, platform, date) DO UPDATE SET
       active_subs=EXCLUDED.active_subs, new_subs=EXCLUDED.new_subs, cancelled_subs=EXCLUDED.cancelled_subs,
       trials=EXCLUDED.trials, proceeds_usd=EXCLUDED.proceeds_usd, source=EXCLUDED.source, updated_at=NOW()`,
    [brand, platform, agg.date, Math.round(agg.active || 0), Math.round(agg.new || 0), Math.round(agg.cancelled || 0), Math.round(agg.trials || 0), agg.proceeds_usd || 0, platform === 'google' ? 'play_financial_stats' : 'asc_subscription_daily'],
  );
}

async function syncIap({ start, end, commit = false, brands = BRANDS, platforms = ['apple', 'google'], subs = true } = {}) {
  const startYmd = start || daysAgoISO(7);
  const endYmd = end || daysAgoISO(1);
  const doApple = platforms.includes('apple');
  const doGoogle = platforms.includes('google');
  console.log(`[IAP] ${commit ? 'COMMIT' : 'DRY-RUN'} ${startYmd} → ${endYmd}  brands=${brands.join(',')}  platforms=${platforms.join(',')}  subs=${subs}`);

  const dates = eachDate(startYmd, endYmd);
  const summary = { apple: { units: 0, revenueUsd: 0, daysWithData: 0 }, google: { units: 0, revenueUsd: 0, daysWithData: 0 }, subsRows: 0, written: 0 };

  const skipped = [];
  for (const brand of brands) {
    const hasApple = doApple && brandHasAppleCreds(brand);
    const hasGoogle = doGoogle && brandHasGoogleCreds(brand);
    if (doApple && !hasApple) { skipped.push(`${brand}/apple (no creds)`); }
    if (doGoogle && !hasGoogle) { skipped.push(`${brand}/google (no creds)`); }
    if (!hasApple && !hasGoogle) {
      console.log(`  ${brand}: no IAP credentials configured — skipping entire brand`);
      continue;
    }
    // ── Google Play earnings — monthly zips, loaded once for the whole range ──
    let googleByDate = {};
    let googleSubsByDate = {};
    if (hasGoogle) {
      try {
        const g = await fetchPlayEarningsDaily(brand, startYmd, endYmd);
        googleByDate = g.byDate;
        console.log(`  ${brand} google: ${g.monthsLoaded.length} earnings file(s), merchant ${g.merchantCurrency} @ ${g.merchantPerUsd}/USD`);
      } catch (e) {
        console.warn(`  ${brand} google earnings ERR ${e.message}`);
      }
      if (subs) {
        try {
          const gs = await fetchPlaySubsDaily(brand, startYmd, endYmd);
          googleSubsByDate = gs.byDate;
          console.log(`  ${brand} google subs: ${gs.filesLoaded.length} stats file(s)`);
        } catch (e) {
          console.warn(`  ${brand} google subs ERR ${e.message}`);
        }
      }
    }

    for (const date of dates) {
      // ── Apple (Sales reports, per day) ──
      if (hasApple) try {
        const agg = await fetchAppleIapDaily(brand, date);
        if (agg.units !== 0 || agg.proceeds_raw !== 0) {
          summary.apple.units += agg.units;
          summary.apple.revenueUsd += agg.revenue_usd;
          summary.apple.daysWithData++;
          console.log(`  ${brand} apple   ${date}  units=${agg.units}  usd=$${agg.revenue_usd.toFixed(2)}  (${agg.currency})`);
          summary.written += await upsertDay(brand, 'apple', agg, commit);
        }
      } catch (e) {
        console.warn(`  ${brand} apple  ${date}  ERR ${e.message}`);
      }
      // ── Apple subscription state (snapshot + events) ──
      if (subs && hasApple) try {
        const s = await fetchAppleSubsDaily(brand, date);
        if (s.active || s.new || s.cancelled) {
          summary.subsRows++;
          await upsertSubsDay(brand, 'apple', s, commit);
        }
      } catch (e) {
        console.warn(`  ${brand} subs   ${date}  ERR ${e.message}`);
      }
      // ── Google Play (from the earnings map) ──
      const gAgg = googleByDate[date];
      if (gAgg && (gAgg.units !== 0 || gAgg.revenue_usd !== 0)) {
        summary.google.units += gAgg.units;
        summary.google.revenueUsd += gAgg.revenue_usd;
        summary.google.daysWithData++;
        console.log(`  ${brand} google  ${date}  units=${gAgg.units}  usd=$${gAgg.revenue_usd.toFixed(2)}  (${gAgg.currency})`);
        summary.written += await upsertDay(brand, 'google', gAgg, commit);
      }
      // ── Google Play subscription state (from financial-stats) ──
      const gSub = googleSubsByDate[date];
      if (gSub && (gSub.active || gSub.new || gSub.cancelled)) {
        summary.subsRows++;
        await upsertSubsDay(brand, 'google', gSub, commit);
      }
    }
  }

  const skippedSuffix = skipped.length ? `  Skipped (no creds): ${skipped.join(', ')}.` : '';
  console.log(`[IAP] Apple: ${summary.apple.units} units · $${summary.apple.revenueUsd.toFixed(2)} USD (${summary.apple.daysWithData}d). Google: ${summary.google.units} units · $${summary.google.revenueUsd.toFixed(2)} USD (${summary.google.daysWithData}d). Subs: ${summary.subsRows} day(s). ${commit ? `Wrote ${summary.written} revenue + ${summary.subsRows} subs rows.` : 'DRY-RUN — nothing written.'}${skippedSuffix}`);
  return { start: startYmd, end: endYmd, commit, skipped, ...summary };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));
  const brandFlag = flags.find((f) => f.startsWith('--brand='));
  const platFlag = flags.find((f) => f.startsWith('--platform='));
  syncIap({
    start: positional[0],
    end: positional[1],
    commit: flags.includes('--commit'),
    brands: brandFlag ? [brandFlag.split('=')[1].toUpperCase()] : BRANDS,
    platforms: platFlag ? [platFlag.split('=')[1].toLowerCase()] : ['apple', 'google'],
    subs: !flags.includes('--no-subs'),
  })
    .then(async (s) => { console.log('[IAP] done:', JSON.stringify(s)); await pool.end().catch(() => {}); })
    .catch(async (e) => { console.error('[IAP] failed:', e.message); await pool.end().catch(() => {}); process.exitCode = 1; });
}

module.exports = { syncIap };
