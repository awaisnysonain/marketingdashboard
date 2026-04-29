require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pgQuery, pgRun } = require('../db/postgres');
const { syncKlaviyoDaily } = require('./klaviyo');
const { syncAppstleSubRevenue } = require('./appstle');
const { refreshSummary } = require('./tripleWhale');
const {
  syncTWChannels,
  syncTWGeo,
  syncTWAds,
  syncTWOrders,
  syncTWSessions,
  syncTWCustomers,
  syncTWSegments,
  syncTWRefunds,
  syncTWEmailSms,
  syncTWBenchmarks,
  syncTWOrderRevenue,
} = require('./twFullSync');

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

// ── Public API ────────────────────────────────────────────────────────────────

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
  const t0 = Date.now();
  const runId = options.runId || `sync_${Date.now()}`;

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
      const chunks = weeklyChunks(startDate, endDate);

      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'klaviyo', chunk.start, chunk.end);
        try {
          const r = await syncKlaviyoDaily(brand, chunk.start, chunk.end);
          await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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

  // ── Appstle / Subscription Revenue ───────────────────────────────────────
  if (tasks.includes('appstle')) {
    const chunks = weeklyChunks(startDate, endDate);

    for (const chunk of chunks) {
      const logId = await logStart(runId, 'NOBL', 'appstle', chunk.start, chunk.end);
      try {
        const r = await syncAppstleSubRevenue(chunk.start, chunk.end);
        await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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
          await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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
          await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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

  // ── TW Ads — campaign/adset/ad level ─────────────────────────────────────
  if (tasks.includes('tw_ads')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_ads', chunk.start, chunk.end);
        try {
          const r = await syncTWAds(brand, chunk.start, chunk.end);
          await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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

  // ── TW Orders — order-level detail ───────────────────────────────────────
  if (tasks.includes('tw_orders')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_orders', chunk.start, chunk.end);
        try {
          const r = await syncTWOrders(brand, chunk.start, chunk.end);
          await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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
          await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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
        await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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
        await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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
          await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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
          await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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
        await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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

  // ── TW Order Revenue — real Shopify+Amazon order_revenue (fixes attribution gap) ──
  // This is the canonical revenue metric: all paid orders before refunds.
  // MER = order_revenue / total_spend (NOT total_revenue which is TW attributed)
  if (tasks.includes('tw_order_revenue')) {
    for (const brand of brands) {
      const chunks = weeklyChunks(startDate, endDate);
      for (const chunk of chunks) {
        const logId = await logStart(runId, brand, 'tw_order_revenue', chunk.start, chunk.end);
        try {
          const r = await syncTWOrderRevenue(brand, chunk.start, chunk.end);
          await logFinish(logId, 'success', r.rows, r.errors.join('; ') || null);
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

  const duration = Date.now() - t0;
  const totalRows = results.reduce((s, r) => s + (r.rows || 0), 0);
  console.log(`[SyncEngine] ✓ Run ${runId} complete in ${(duration / 1000).toFixed(1)}s | ${totalRows} rows total | ${errors.length} errors`);

  return { runId, results, errors, duration, totalRows };
}

module.exports = { runSync, getLastSyncDate, checkDataGaps };
