require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pgQuery, pgRun } = require('../db/postgres');
const { syncKlaviyoDaily, getKlaviyoApiKey } = require('./klaviyo');
const { syncNoblAirSubs } = require('./noblAirSubs'); // legacy — kept for backward compat
const { syncShopifyOrders } = require('./shopifyOrders');
const { syncAppstleContracts, syncFloAppstleContracts } = require('./appstleContracts');
const { aggregateNoblAir, aggregateProductDaily } = require('./noblAirAggregate');
const { refreshNoblAirMetaAdDaily } = require('./noblAirMetaAdDaily');
const { syncMetaAds } = require('./metaAdsSync');
const { getMetaAccount } = require('../config/metaConfig');
const { invalidateNoblAirDataVersionCache } = require('../utils/noblAirDataVersion');
const { clearResponseCache } = require('../utils/responseCache');
// Use the new SQL-based TW ETL (matches Brad's queries — Triple Attribution + Amazon + EU)
const { refreshSummary } = require('./tripleWhaleSQL');
const {
  syncTWChannels,
  syncTWGeo,
  syncTWAds,
  syncTWAirOrderAttribution,
  syncTWOrders,
  syncTWSessions,
  syncTWCustomers,
  syncTWSegments,
  syncTWRefunds,
  syncTWEmailSms,
  syncTWBenchmarks,
  syncTWOrderRevenue,
} = require('./twFullSync');
const { runShopifyDisputes } = require('./syncShopifyDisputes');

// ── Helpers ──────────────────────────────────────────────────────────────────

function toDateStr(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** Split a date range into weekly chunks to avoid large API timeouts. */
function weeklyChunks(startDate, endDate) {
  const chunks = [];
  let cur = startDate;
  while (cur <= endDate) {
    const end = addDays(cur, 6) > endDate ? endDate : addDays(cur, 6);
    chunks.push({ start: cur, end });
    cur = addDays(end, 1);
  }
  return chunks;
}

/**
 * Log an ETL run step to etl_run_log.
 * Returns the inserted row id.
 */
async function logStart(runId, brand, task, startDate, endDate) {
  try {
    const r = await pgQuery(
      `INSERT INTO etl_run_log (run_id, brand, task, start_date, end_date, status, started_at)
       VALUES ($1,$2,$3,$4,$5,'running',NOW())
       RETURNING id`,
      [runId, brand, task, startDate, endDate]
    );
    return r.rows[0]?.id;
  } catch (e) {
    console.error('[SyncEngine] logStart error:', e.message);
    return null;
  }
}

async function logFinish(logId, status, rowsWritten, errorMessage = null) {
  if (!logId) return;
  try {
    await pgRun(
      `UPDATE etl_run_log
       SET status=$1, rows_written=$2, error_message=$3, finished_at=NOW()
       WHERE id=$4`,
      [status, rowsWritten, errorMessage, logId]
    );
  } catch (e) {
    console.error('[SyncEngine] logFinish error:', e.message);
  }
}

async function logTaskResult(logId, result) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  await logFinish(logId, errors.length ? 'error' : 'success', result?.rows || 0, errors.join('; ') || null);
}

// ── Public API ────────────────────────────────────────────────────────────────

let syncRunning = false;

function isSyncRunning() {
  return syncRunning;
}

/**
 * Get the most recent finished_at date for a brand+task combination.
 * Returns a Date or null.
 */
async function getLastSyncDate(brand, task) {
  try {
    const r = await pgQuery(
      `SELECT end_date FROM etl_run_log
       WHERE brand=$1 AND task=$2 AND status='success'
       ORDER BY finished_at DESC LIMIT 1`,
      [brand, task]
    );
    return r.rows[0]?.end_date ? new Date(r.rows[0].end_date) : null;
  } catch (e) {
    console.error('[SyncEngine] getLastSyncDate error:', e.message);
    return null;
  }
}

/**
 * Scan a PG table for date gaps.
 * Returns { missing: string[], incomplete: string[] }
 * "missing" = dates where no row exists.
 * "incomplete" = rows that exist but have zero/null in key numeric columns.
 *
 * @param {string} table
 * @param {string} brand - used as a WHERE filter if the table has a 'brand' column
 * @returns {Promise<{missing: string[], incomplete: string[]}>}
 */
async function checkDataGaps(table, brand) {
  try {
    // Check if table has a brand column
    const colCheck = await pgQuery(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name=$1 AND column_name='brand'`,
      [table]
    );
    const hasBrand = colCheck.rows.length > 0;
    const brandFilter = hasBrand ? `WHERE brand = '${brand}'` : '';

    const r = await pgQuery(
      `SELECT date FROM ${table} ${brandFilter} ORDER BY date`
    );

    if (!r.rows.length) return { missing: [], incomplete: [] };

    const existingDates = new Set(r.rows.map(row => toDateStr(row.date)));
    const first = toDateStr(r.rows[0].date);
    const last  = toDateStr(r.rows[r.rows.length - 1].date);

    const missing = [];
    let cur = first;
    while (cur <= last) {
      if (!existingDates.has(cur)) missing.push(cur);
      cur = addDays(cur, 1);
    }

    return { missing, incomplete: [] };
  } catch (e) {
    console.error(`[SyncEngine] checkDataGaps(${table}) error:`, e.message);
    return { missing: [], incomplete: [] };
  }
}

/**
 * Main sync orchestrator.
 *
 * @param {object} options
 * @param {string}   options.runId      - unique run identifier (auto-generated if omitted)
 * @param {string[]} options.tasks      - e.g. ['klaviyo','appstle','tw_refresh']
 * @param {string[]} options.brands     - e.g. ['NOBL','FLO'] (default: both)
 * @param {string}   options.startDate  - YYYY-MM-DD (defaults to 30 days ago)
 * @param {string}   options.endDate    - YYYY-MM-DD (defaults to today)
 * @returns {Promise<{results: object[], errors: string[], duration: number}>}
 */
async function runSync(options = {}) {
  if (syncRunning) {
    console.warn(`[SyncEngine] Skip ${options.runId || 'sync'} — another sync is already running`);
    return {
      runId: options.runId || null,
      skipped: true,
      results: [],
      errors: ['Sync already running'],
      duration: 0,
      totalRows: 0,
    };
  }

  syncRunning = true;
  const t0 = Date.now();
  const runId = options.runId || `sync_${Date.now()}`;

  try {
  // Defaults
  const today    = new Date().toISOString().slice(0, 10);
  const ago30    = addDays(today, -30);
  const startDate = options.startDate || ago30;
  const endDate   = options.endDate   || today;
  const brands    = options.brands    || ['NOBL', 'FLO'];
  const tasks     = options.tasks     || ['klaviyo', 'appstle'];

  console.log(`\n[SyncEngine] ▶ Run ${runId} | tasks: ${tasks.join(',')} | brands: ${brands.join(',')} | ${startDate} → ${endDate}`);

  const results = [];
  const errors  = [];

  // ── Klaviyo ──────────────────────────────────────────────────────────────
  if (tasks.includes('klaviyo')) {
    for (const brand of brands) {
      if (!getKlaviyoApiKey(brand)) {
        console.warn(`[SyncEngine] Skipping Klaviyo ${brand}: missing ${String(brand).toUpperCase()}_KLAVIYO_API_KEY`);
        continue;
      }

      const chunks = weeklyChunks(startDate, endDate);

      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'klaviyo', chunk.start, chunk.end);
        try {
          const r = await syncKlaviyoDaily(brand, chunk.start, chunk.end);
          await logTaskResult(logId, r);
          results.push({ task: 'klaviyo', brand, chunk, rows: r.rows });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `klaviyo ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── NOBL Air subscriptions (Shopify direct — replaces old Appstle/tag-filter ETL) ─
  if (tasks.includes('appstle')) {
    const chunks = weeklyChunks(startDate, endDate);

    for (const chunk of chunks) {
      const logId = await logStart(runId, 'NOBL', 'appstle', chunk.start, chunk.end);
      try {
        const r = await syncNoblAirSubs(chunk.start, chunk.end);
        const status = r.errors.length ? 'error' : 'success';
        await logFinish(logId, status, r.rows, r.errors.join('; ') || null);
        results.push({ task: 'appstle', brand: 'NOBL', chunk, rows: r.rows });
        if (r.errors.length) errors.push(...r.errors);
      } catch (e) {
        const msg = `appstle ${chunk.start}-${chunk.end}: ${e.message}`;
        console.error('[SyncEngine]', msg);
        errors.push(msg);
        await logFinish(logId, 'error', 0, e.message);
      }
    }
  }

  // ── Triple Whale Summary Refresh ──────────────────────────────────────────
  if (tasks.includes('tw_refresh')) {
    const twBrandMap = { NOBL: 'NOBL', FLO: 'FLO' };
    for (const brand of brands) {
      const twBrand = twBrandMap[brand];
      if (!twBrand) continue;

      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_refresh', chunk.start, chunk.end);
        try {
          const r = await refreshSummary(twBrand, chunk.start, chunk.end);
          await logFinish(logId, 'success', r.rows);
          results.push({ task: 'tw_refresh', brand, chunk, rows: r.rows });
        } catch (e) {
          const msg = `tw_refresh ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── TW Channels (fixes 6-day lag via Willy SQL) ───────────────────────────
  if (tasks.includes('tw_channels')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_channels', chunk.start, chunk.end);
        try {
          const r = await syncTWChannels(brand, chunk.start, chunk.end);
          await logTaskResult(logId, r);
          results.push({ task: 'tw_channels', brand, chunk, rows: r.rows });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `tw_channels ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── TW Geo (fixes 6-day lag via Willy SQL) ────────────────────────────────
  if (tasks.includes('tw_geo')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_geo', chunk.start, chunk.end);
        try {
          const r = await syncTWGeo(brand, chunk.start, chunk.end);
          await logTaskResult(logId, r);
          results.push({ task: 'tw_geo', brand, chunk, rows: r.rows });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `tw_geo ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── Meta Ads API — per-brand spend (primary; TW remains fallback at read time) ─
  if (tasks.includes('meta_ads')) {
    const metaBrands = brands.filter((b) => getMetaAccount(b));
    if (!metaBrands.length) {
      console.warn('[SyncEngine] meta_ads: no Meta accounts configured for', brands.join(','), '— skipping (Triple Whale fallback used at read)');
    }
    for (const brand of metaBrands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'meta_ads', chunk.start, chunk.end);
        try {
          const r = await syncMetaAds(brand, chunk.start, chunk.end);
          const status = r.skipped ? 'skipped' : 'success';
          await logFinish(logId, status, r.rows, r.errors.join('; ') || null);
          results.push({ task: 'meta_ads', brand, chunk, rows: r.rows, skipped: r.skipped });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `meta_ads ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── TW Ads — campaign/adset/ad level ─────────────────────────────────────
  if (tasks.includes('tw_ads')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_ads', chunk.start, chunk.end);
        try {
          const r = await syncTWAds(brand, chunk.start, chunk.end);
          await logTaskResult(logId, r);
          results.push({ task: 'tw_ads', brand, chunk, rows: r.rows });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `tw_ads ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── TW NOBL Air order-level attribution ──────────────────────────────────
  if (tasks.includes('tw_air_attribution')) {
    const chunks = weeklyChunks(startDate, endDate);
    for (const chunk of chunks) {
      const logId = await logStart(runId, 'NOBL', 'tw_air_attribution', chunk.start, chunk.end);
      try {
        const r = await syncTWAirOrderAttribution('NOBL', chunk.start, chunk.end);
        await logTaskResult(logId, r);
        results.push({ task: 'tw_air_attribution', brand: 'NOBL', chunk, rows: r.rows });
        if (r.errors.length) errors.push(...r.errors);
        try {
          const agg = await refreshNoblAirMetaAdDaily(chunk.start, chunk.end);
          results.push({ task: 'nobl_air_meta_ad_daily', brand: 'NOBL', chunk, rows: agg.rows });
          invalidateNoblAirDataVersionCache();
          clearResponseCache('nobl-air');
        } catch (aggErr) {
          const aggMsg = `nobl_air_meta_ad_daily NOBL ${chunk.start}-${chunk.end}: ${aggErr.message}`;
          console.error('[SyncEngine]', aggMsg);
          errors.push(aggMsg);
        }
      } catch (e) {
        const msg = `tw_air_attribution NOBL ${chunk.start}-${chunk.end}: ${e.message}`;
        console.error('[SyncEngine]', msg);
        errors.push(msg);
        await logFinish(logId, 'error', 0, e.message);
      }
    }
  }

  // ── TW Orders — order-level detail ───────────────────────────────────────
  if (tasks.includes('tw_orders')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_orders', chunk.start, chunk.end);
        try {
          const r = await syncTWOrders(brand, chunk.start, chunk.end);
          await logTaskResult(logId, r);
          results.push({ task: 'tw_orders', brand, chunk, rows: r.rows });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `tw_orders ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── TW Sessions — daily traffic ───────────────────────────────────────────
  if (tasks.includes('tw_sessions')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_sessions', chunk.start, chunk.end);
        try {
          const r = await syncTWSessions(brand, chunk.start, chunk.end);
          await logTaskResult(logId, r);
          results.push({ task: 'tw_sessions', brand, chunk, rows: r.rows });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `tw_sessions ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── TW Customers — LTV snapshot (no date chunking needed) ────────────────
  if (tasks.includes('tw_customers')) {
    for (const brand of brands) {
      const logId = await logStart(runId, brand, 'tw_customers', startDate, endDate);
      try {
        const r = await syncTWCustomers(brand);
        await logTaskResult(logId, r);
        results.push({ task: 'tw_customers', brand, rows: r.rows });
        if (r.errors.length) errors.push(...r.errors);
      } catch (e) {
        const msg = `tw_customers ${brand}: ${e.message}`;
        console.error('[SyncEngine]', msg);
        errors.push(msg);
        await logFinish(logId, 'error', 0, e.message);
      }
    }
  }

  // ── TW Segments — RFM today snapshot ──────────────────────────────────────
  if (tasks.includes('tw_segments')) {
    for (const brand of brands) {
      const logId = await logStart(runId, brand, 'tw_segments', startDate, endDate);
      try {
        const r = await syncTWSegments(brand);
        await logTaskResult(logId, r);
        results.push({ task: 'tw_segments', brand, rows: r.rows });
        if (r.errors.length) errors.push(...r.errors);
      } catch (e) {
        const msg = `tw_segments ${brand}: ${e.message}`;
        console.error('[SyncEngine]', msg);
        errors.push(msg);
        await logFinish(logId, 'error', 0, e.message);
      }
    }
  }

  // ── TW Refunds — daily refund summary ────────────────────────────────────
  if (tasks.includes('tw_refunds')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_refunds', chunk.start, chunk.end);
        try {
          const r = await syncTWRefunds(brand, chunk.start, chunk.end);
          await logTaskResult(logId, r);
          results.push({ task: 'tw_refunds', brand, chunk, rows: r.rows });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `tw_refunds ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── TW Email/SMS — campaign performance ───────────────────────────────────
  if (tasks.includes('tw_email_sms')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_email_sms', chunk.start, chunk.end);
        try {
          const r = await syncTWEmailSms(brand, chunk.start, chunk.end);
          await logTaskResult(logId, r);
          results.push({ task: 'tw_email_sms', brand, chunk, rows: r.rows });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `tw_email_sms ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── TW Benchmarks — monthly industry benchmarks ───────────────────────────
  if (tasks.includes('tw_benchmarks')) {
    for (const brand of brands) {
      const logId = await logStart(runId, brand, 'tw_benchmarks', startDate, endDate);
      try {
        const r = await syncTWBenchmarks(brand);
        await logTaskResult(logId, r);
        results.push({ task: 'tw_benchmarks', brand, rows: r.rows });
        if (r.errors.length) errors.push(...r.errors);
      } catch (e) {
        const msg = `tw_benchmarks ${brand}: ${e.message}`;
        console.error('[SyncEngine]', msg);
        errors.push(msg);
        await logFinish(logId, 'error', 0, e.message);
      }
    }
  }

  // ── TW Order Revenue — canonical revenue split (Shopify + Amazon) ──
  // Does NOT overwrite total_spend; tw_refresh owns ads_table spend.
  // MER = order_revenue / total_spend (spend from tw_refresh)
  if (tasks.includes('tw_order_revenue')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_order_revenue', chunk.start, chunk.end);
        try {
          const r = await syncTWOrderRevenue(brand, chunk.start, chunk.end);
          await logTaskResult(logId, r);
          results.push({ task: 'tw_order_revenue', brand, chunk, rows: r.rows });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `tw_order_revenue ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── Shopify orders direct (NOBL + FLO) ──────────────────────────────
  if (tasks.includes('shopify_orders')) {
    const chunks = weeklyChunks(startDate, endDate);
    for (const brand of brands) {
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'shopify_orders', chunk.start, chunk.end);
        try {
          const r = await syncShopifyOrders(brand, chunk.start, chunk.end);
          const status = r.errors.length ? 'error' : 'success';
          await logFinish(logId, status, r.rows, r.errors.join('; ') || null);
          results.push({ task: 'shopify_orders', brand, chunk, rows: r.rows });
          if (r.errors.length) errors.push(...r.errors);
        } catch (e) {
          const msg = `shopify_orders ${brand} ${chunk.start}-${chunk.end}: ${e.message}`;
          console.error('[SyncEngine]', msg);
          errors.push(msg);
          await logFinish(logId, 'error', 0, e.message);
        }
      }
    }
  }

  // ── Appstle contracts (full sync, no chunking) ────────────────────────
  if (tasks.includes('appstle_contracts')) {
    for (const cfg of [
      { brand: 'NOBL', sync: syncAppstleContracts },
      { brand: 'FLO', sync: syncFloAppstleContracts },
    ]) {
      const logId = await logStart(runId, cfg.brand, 'appstle_contracts', startDate, endDate);
      try {
        const r = await cfg.sync();
        const status = r.errors.length ? 'error' : 'success';
        await logFinish(logId, status, r.rows, r.errors.join('; ') || null);
        results.push({ task: 'appstle_contracts', brand: cfg.brand, rows: r.rows });
        if (r.errors.length) errors.push(...r.errors);
      } catch (e) {
        const msg = `appstle_contracts ${cfg.brand}: ${e.message}`;
        console.error('[SyncEngine]', msg);
        errors.push(msg);
        await logFinish(logId, 'error', 0, e.message);
      }
    }
  }

  // ── NOBL Air Meta ad daily cache (reads tw_air_order_attribution + tw_ads_daily) ──
  if (tasks.includes('nobl_air_meta_ad_daily')) {
    const chunks = weeklyChunks(startDate, endDate);
    for (const chunk of chunks) {
      const logId = await logStart(runId, 'NOBL', 'nobl_air_meta_ad_daily', chunk.start, chunk.end);
      try {
        const r = await refreshNoblAirMetaAdDaily(chunk.start, chunk.end);
        await logFinish(logId, 'success', r.rows);
        results.push({ task: 'nobl_air_meta_ad_daily', brand: 'NOBL', chunk, rows: r.rows });
      } catch (e) {
        const msg = `nobl_air_meta_ad_daily NOBL ${chunk.start}-${chunk.end}: ${e.message}`;
        console.error('[SyncEngine]', msg);
        errors.push(msg);
        await logFinish(logId, 'error', 0, e.message);
      }
    }
  }

  // ── NOBL Air daily aggregation (re-runs SQL CTE over the range) ──────
  if (tasks.includes('nobl_air_aggregate')) {
    const logId = await logStart(runId, 'NOBL', 'nobl_air_aggregate', startDate, endDate);
    try {
      const r = await aggregateNoblAir(startDate, endDate);
      await logFinish(logId, 'success', r.rows);
      results.push({ task: 'nobl_air_aggregate', brand: 'NOBL', rows: r.rows, ttp_snapshot_rows: r.ttp_snapshot_rows });
      invalidateNoblAirDataVersionCache();
      clearResponseCache('nobl-air');
    } catch (e) {
      const msg = `nobl_air_aggregate: ${e.message}`;
      console.error('[SyncEngine]', msg);
      errors.push(msg);
      await logFinish(logId, 'error', 0, e.message);
    }
  }

  // ── Forecast import (NOBL store + air daily targets → forecast_daily) ─
  if (tasks.includes('forecast_sheet')) {
    const logId = await logStart(runId, 'NOBL', 'forecast_sheet', startDate, endDate);
    try {
      const { importForecastDaily } = require('./forecastImport');
      const r = await importForecastDaily();
      await logFinish(logId, 'success', r.rows);
      results.push({ task: 'forecast_sheet', brand: 'NOBL', rows: r.rows, range: `${r.min_date}..${r.max_date}` });
      clearResponseCache('forecast');
    } catch (e) {
      const msg = `forecast_sheet: ${e.message}`;
      console.error('[SyncEngine]', msg);
      errors.push(msg);
      await logFinish(logId, 'error', 0, e.message);
    }
  }

  // ── Performance dashboard import (NOBL + FLO CPMR, A vs F revenue) ───
  if (tasks.includes('performance_dashboard')) {
    const logId = await logStart(runId, 'ALL', 'performance_dashboard', startDate, endDate);
    try {
      const { importPerformanceDashboard } = require('./performanceDashboardImport');
      const r = await importPerformanceDashboard();
      await logFinish(logId, 'success', r.rows);
      results.push({ task: 'performance_dashboard', rows: r.rows, flo_forecast: r.flo_forecast_rows, range: `${r.min_date}..${r.max_date}` });
      clearResponseCache('performance');
      clearResponseCache('forecast');
    } catch (e) {
      const msg = `performance_dashboard: ${e.message}`;
      console.error('[SyncEngine]', msg);
      errors.push(msg);
      await logFinish(logId, 'error', 0, e.message);
    }
  }

  // ── Product daily aggregation (NOBL + FLO from Shopify orders) ───────
  if (tasks.includes('product_daily')) {
    for (const brand of brands) {
      const logId = await logStart(runId, brand, 'product_daily', startDate, endDate);
      try {
        const r = await aggregateProductDaily(brand, startDate, endDate);
        await logFinish(logId, 'success', r.rows);
        results.push({ task: 'product_daily', brand, rows: r.rows });
      } catch (e) {
        const msg = `product_daily ${brand}: ${e.message}`;
        console.error('[SyncEngine]', msg);
        errors.push(msg);
        await logFinish(logId, 'error', 0, e.message);
      }
    }
  }

  // ── Ops metrics (ERP Postgres + UPS API → ops_metrics_daily) ──────────
  // The ETL pulls both brands in one shot (single ERP query + single UPS pass),
  // so it logs under brand='ALL' — the same pattern as IAP.
  if (tasks.includes('ops_metrics')) {
    const logId = await logStart(runId, 'ALL', 'ops_metrics', startDate, endDate);
    try {
      const { runOpsMetrics } = require('./syncOpsMetrics');
      const r = await runOpsMetrics({ start: startDate, end: endDate, commit: true });
      await logFinish(logId, 'success', r.written);
      results.push({ task: 'ops_metrics', rows: r.written, statusCounts: r.statusCounts });
    } catch (e) {
      const msg = `ops_metrics ${startDate}-${endDate}: ${e.message}`;
      console.error('[SyncEngine]', msg);
      errors.push(msg);
      await logFinish(logId, 'error', 0, e.message);
    }
  }

  // ── CS tickets (crmdb + flodb Mongo → cs_tickets_daily) ──────────────
  if (tasks.includes('cs_tickets')) {
    // Each brand has its own Mongo DB, so we can fail one without the other.
    for (const brand of brands) {
      const logId = await logStart(runId, brand, 'cs_tickets', startDate, endDate);
      try {
        const { runCsTickets } = require('./syncCsTickets');
        const r = await runCsTickets({ start: startDate, end: endDate, commit: true, brands: [brand] });
        await logFinish(logId, 'success', r.rows);
        results.push({ task: 'cs_tickets', brand, rows: r.rows });
      } catch (e) {
        const msg = `cs_tickets ${brand} ${startDate}-${endDate}: ${e.message}`;
        console.error('[SyncEngine]', msg);
        errors.push(msg);
        await logFinish(logId, 'error', 0, e.message);
      }
    }
  }

  // ── Shopify Payments disputes/chargebacks → shopify_disputes_daily ───
  if (tasks.includes('shopify_disputes')) {
    const logId = await logStart(runId, 'ALL', 'shopify_disputes', startDate, endDate);
    try {
      const r = await runShopifyDisputes({ start: startDate, end: endDate, commit: true, brands });
      await logFinish(logId, 'success', r.rows, (r.summaries || []).flatMap(s => s.errors || []).join('; ') || null);
      results.push({ task: 'shopify_disputes', rows: r.rows, summaries: r.summaries });
    } catch (e) {
      const msg = `shopify_disputes ${startDate}-${endDate}: ${e.message}`;
      console.error('[SyncEngine]', msg);
      errors.push(msg);
      await logFinish(logId, 'error', 0, e.message);
    }
  }

  // ── IAP sync (Apple App Store + Google Play → iap_daily) ────────────
  if (tasks.includes('iap')) {
    // Google earnings reports publish ~1 month late, so always re-sync a wider
    // ~45-day window (regardless of the daily 7-day backfill) to capture them.
    const iapEnd = endDate;
    const ws = new Date(`${endDate}T00:00:00Z`);
    ws.setUTCDate(ws.getUTCDate() - 45);
    const iapStart = ws.toISOString().slice(0, 10);
    const logId = await logStart(runId, 'ALL', 'iap', iapStart, iapEnd);
    try {
      const { syncIap } = require('./syncIap');
      const r = await syncIap({ start: iapStart, end: iapEnd, commit: true, brands });
      await logFinish(logId, 'success', r.written);
      results.push({ task: 'iap', rows: r.written, apple: r.apple, google: r.google });
    } catch (e) {
      const msg = `iap: ${e.message}`;
      console.error('[SyncEngine]', msg);
      errors.push(msg);
      await logFinish(logId, 'error', 0, e.message);
    }
  }

  const duration = Date.now() - t0;
  const totalRows = results.reduce((s, r) => s + (r.rows || 0), 0);
  const KPI_PULSE_TASKS = new Set([
    'tw_refresh', 'tw_geo', 'tw_ads', 'tw_sessions', 'tw_order_revenue', 'tw_refunds', 'tw_email_sms',
    'meta_ads', 'shopify_orders', 'nobl_air_aggregate', 'product_daily', 'ops_metrics',
    'cs_tickets', 'shopify_disputes', 'iap', 'appstle_contracts',
  ]);
  if (tasks.some(t => KPI_PULSE_TASKS.has(t))) clearResponseCache('kpi-pulse');
  console.log(`[SyncEngine] ✓ Run ${runId} complete in ${(duration / 1000).toFixed(1)}s | ${totalRows} rows total | ${errors.length} errors`);

  return { runId, results, errors, duration, totalRows };
  } finally {
    syncRunning = false;
  }
}

module.exports = { runSync, getLastSyncDate, checkDataGaps, isSyncRunning };
