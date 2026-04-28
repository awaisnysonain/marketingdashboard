require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const TW_SUMMARY_URL = 'https://api.triplewhale.com/api/v2/summary-page/get-data';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POST to Triple Whale summary-page/get-data with retry + backoff.
 *
 * @param {string} shopDomain  e.g. "nobltravel.myshopify.com"
 * @param {string} apiKey
 * @param {string} startDate   YYYY-MM-DD
 * @param {string} endDate     YYYY-MM-DD
 * @param {number} maxRetries
 * @returns {Promise<Array>}   metrics array from TW response
 */
async function fetchTWSummaryPage(shopDomain, apiKey, startDate, endDate, maxRetries = 3) {
  const body = {
    shopDomain,
    period: {
      start: `${startDate}T00:00:00.000Z`,
      end:   `${endDate}T23:59:59.000Z`,
    },
    todayHour: 25,  // 25 = full day (use for past dates)
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(TW_SUMMARY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.status === 429) {
        const wait = Math.pow(2, attempt) * 2000;
        console.warn(`[TW] Rate limited, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`TW HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = await res.json();
      return json.metrics ?? [];

    } catch (err) {
      if (attempt === maxRetries) throw err;
      const wait = Math.pow(2, attempt) * 1500;
      console.warn(`[TW] Error attempt ${attempt}/${maxRetries}: ${err.message}. Retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
  return [];
}

/**
 * Convert Triple Whale's day-of-year (x) value to a YYYY-MM-DD string.
 * TW uses 1-indexed day-of-year (Jan 1 = 1).
 * Handles year-boundary crossings by detecting when x decreases (wraps to next year).
 *
 * @param {number} x        day-of-year
 * @param {number} baseYear year of the start of the date range
 * @param {number} prevX    previous x value (to detect year rollover)
 * @returns {{ date: string, year: number }}
 */
function twDayToDate(x, baseYear, prevX, currentYear) {
  // Detect year rollover: x went from high (e.g. 365) to low (e.g. 1)
  let year = currentYear;
  if (prevX !== null && x < prevX && prevX > 300 && x < 100) {
    year = currentYear + 1;
  }
  const d = new Date(Date.UTC(year, 0, x));
  return { date: d.toISOString().slice(0, 10), year };
}

/**
 * Extract a map of { 'YYYY-MM-DD': value } from a metric's charts.current array.
 * Returns empty object if metric not found or has no chart data.
 *
 * @param {Array}  metrics    TW metrics array
 * @param {string} metricId   e.g. 'sales', 'mer', 'orders'
 * @param {number} baseYear   year of the query start date
 * @returns {Object}
 */
function extractDailyMap(metrics, metricId, baseYear) {
  const metric = metrics.find(m => m.id === metricId);
  if (!metric?.charts?.current?.length) return {};

  const result = {};
  let prevX = null;
  let currentYear = baseYear;

  for (const point of metric.charts.current) {
    const { x, y } = point;
    const { date, year } = twDayToDate(x, baseYear, prevX, currentYear);
    currentYear = year;
    prevX = x;
    result[date] = (result[date] ?? 0) + (y ?? 0);
  }

  return result;
}

/**
 * Refresh summary rows for a brand between startDate and endDate.
 * Writes to the appropriate PG table via upsert.
 *
 * Metrics pulled from TW:
 *   sales              → total_revenue  (Order Revenue)
 *   facebookAds +
 *   googleAds   +
 *   tiktokAds   +
 *   snapchatAds +
 *   pinterestAds       → total_spend    (sum of channel spends)
 *   mer                → mer
 *   orders             → total_orders
 *   newCustomersOrders → new_customer_orders
 *   orders - newCust   → returning_customer_orders
 *
 * @param {'NOBL'|'FLO'|'FLO_EU'} brand
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 * @returns {Promise<{rows: number, errors: string[]}>}
 */
async function refreshSummary(brand, startDate, endDate) {
  const { pgRun } = require('../db/postgres');
  const errors = [];

  const shopDomain = brand === 'NOBL'
    ? process.env.NOBL_TW_SHOP_ID
    : brand === 'FLO_EU'
      ? process.env.FLO_EU_TW_SHOP_ID
      : process.env.FLO_TW_SHOP_ID;

  const apiKey = brand === 'NOBL'
    ? process.env.NOBL_TW_API_KEY
    : brand === 'FLO_EU'
      ? process.env.FLO_EU_TW_API_KEY
      : process.env.FLO_TW_API_KEY;

  // Insert directly into the underlying table (the brand-specific names are views)
  const pgTable = 'tw_summary_daily';

  console.log(`[TW] Refreshing ${brand} summary ${startDate} → ${endDate}`);

  // Fetch all metrics for the range
  let metrics;
  try {
    metrics = await fetchTWSummaryPage(shopDomain, apiKey, startDate, endDate);
    if (!metrics.length) {
      console.log(`[TW] No metrics returned for ${brand} ${startDate}→${endDate}`);
      return { rows: 0, errors };
    }
    console.log(`[TW] ${brand}: ${metrics.length} metrics returned`);
  } catch (e) {
    const msg = `fetchTWSummaryPage(${brand}): ${e.message}`;
    console.error('[TW]', msg);
    errors.push(msg);
    return { rows: 0, errors };
  }

  const baseYear = parseInt(startDate.slice(0, 4), 10);

  // Extract daily maps for each metric we care about
  const revenueMap   = extractDailyMap(metrics, 'sales', baseYear);
  const merMap       = extractDailyMap(metrics, 'mer', baseYear);
  const ordersMap    = extractDailyMap(metrics, 'orders', baseYear);
  const ncOrdersMap  = extractDailyMap(metrics, 'newCustomersOrders', baseYear);

  // Sum all available channel ad spends per day
  const SPEND_IDS = ['facebookAds', 'googleAds', 'tiktokAds', 'snapchatAds', 'pinterestAds',
                     'bingAdSpend', 'twitterAds', 'redditSpend'];
  const spendMap = {};
  for (const id of SPEND_IDS) {
    const m = extractDailyMap(metrics, id, baseYear);
    for (const [date, val] of Object.entries(m)) {
      spendMap[date] = (spendMap[date] ?? 0) + val;
    }
  }

  // Union all dates that appear in any metric
  const allDates = new Set([
    ...Object.keys(revenueMap),
    ...Object.keys(ordersMap),
    ...Object.keys(merMap),
  ]);

  // Also fill the full requested range with zeros
  const start = new Date(startDate);
  const end   = new Date(endDate);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    allDates.add(d.toISOString().slice(0, 10));
  }

  let written = 0;
  for (const date of [...allDates].sort()) {
    const totalRevenue   = revenueMap[date]  ?? 0;
    const totalSpend     = spendMap[date]    ?? 0;
    const mer            = merMap[date]      ?? null;
    const totalOrders    = ordersMap[date]   ?? 0;
    const ncOrders       = ncOrdersMap[date] ?? 0;
    const rcOrders       = Math.max(0, (ordersMap[date] ?? 0) - ncOrders);

    try {
      await pgRun(`
        INSERT INTO tw_summary_daily
          (brand, date, total_revenue, total_spend, mer,
           total_orders, new_customer_orders, returning_customer_orders)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (brand, date) DO UPDATE SET
          total_revenue              = EXCLUDED.total_revenue,
          total_spend                = EXCLUDED.total_spend,
          mer                        = EXCLUDED.mer,
          total_orders               = EXCLUDED.total_orders,
          new_customer_orders        = EXCLUDED.new_customer_orders,
          returning_customer_orders  = EXCLUDED.returning_customer_orders,
          updated_at                 = NOW()
      `, [brand, date, totalRevenue, totalSpend, mer, totalOrders, ncOrders, rcOrders]);
      written++;
    } catch (e) {
      const msg = `Upsert ${brand}/${date}: ${e.message}`;
      console.error('[TW]', msg);
      errors.push(msg);
    }
  }

  console.log(`[TW] ${brand} summary: ${written} rows upserted, ${errors.length} errors`);
  return { rows: written, errors };
}

/**
 * Legacy aliases (kept for compatibility with syncEngine.js)
 */
async function fetchTW(shopId, apiKey, sql, params = []) {
  // The old SQL-based API is gone; return empty to avoid crashes
  console.warn('[TW] fetchTW (SQL API) is no longer supported. Use refreshSummary instead.');
  return [];
}

async function fetchTW_NOBL(sql, params = []) { return []; }
async function fetchTW_FLO(sql, params = [])  { return []; }
async function fetchTW_FLO_EU(sql, params = []) { return []; }

module.exports = { fetchTW, fetchTW_NOBL, fetchTW_FLO, fetchTW_FLO_EU, refreshSummary };
