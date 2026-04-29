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
 * Writes to tw_summary_daily and tw_channel_daily via upsert.
 *
 * Revenue rules (canonical, matches TW UI):
 *   order_revenue   = sales metric        (Shopify + Amazon, before refunds)
 *   amazon_revenue  = amazonSales metric  (Amazon portion)
 *   shopify_revenue = sales - amazonSales (Shopify-only)
 *   total_sales     = netSales metric     (after refunds)
 *   refund_amount   = totalRefunds metric
 *   total_spend     = blendedAds metric   (all Shopify-connected ad platforms)
 *
 * For FLO: order_revenue = Gross Sales + Shipping + Taxes − Discounts (same formula)
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

  console.log(`[TW] Refreshing ${brand} summary ${startDate} → ${endDate}`);

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

  // ── Revenue metrics ───────────────────────────────────────────────
  //  blendedSales = "Blended Sales" = Shopify + Amazon, before refunds
  //               = same as blended_stats_tvf(include_amazon=TRUE).order_revenue
  //               = the canonical "Order Revenue" shown in TW UI
  //  sales        = TW pixel-attributed revenue (different, do NOT use for revenue KPIs)
  const orderRevMap    = extractDailyMap(metrics, 'blendedSales',   baseYear); // ← CANONICAL
  const twAttrRevMap   = extractDailyMap(metrics, 'sales',          baseYear); // TW attributed (kept for reference)
  const amazonRevMap   = extractDailyMap(metrics, 'amazonSales',    baseYear); // Amazon portion
  const amazonNetMap   = extractDailyMap(metrics, 'amazonNetSales', baseYear); // Amazon net (after refunds)
  const netSalesMap    = extractDailyMap(metrics, 'netSales',       baseYear); // Shopify net (after refunds)
  const refundsMap     = extractDailyMap(metrics, 'totalRefunds',   baseYear); // Shopify returns
  const amazonRefMap   = extractDailyMap(metrics, 'amazonRefunds',  baseYear); // Amazon returns
  const merMap         = extractDailyMap(metrics, 'mer',            baseYear);
  const ordersMap      = extractDailyMap(metrics, 'orders',         baseYear);
  const ncOrdersMap    = extractDailyMap(metrics, 'newCustomersOrders', baseYear);

  // ── Spend — use blendedAds (all Shopify-connected platforms, excl. Amazon) ─
  // Falls back to summing individual channels if blendedAds is missing
  const blendedAdsMap  = extractDailyMap(metrics, 'blendedAds', baseYear);
  const SPEND_IDS = [
    'facebookAds', 'googleAds', 'tiktokAds', 'snapchatAds', 'pinterestAds',
    'bingAdSpend', 'twitterAds', 'redditSpend', 'applovinSpend',
  ];
  const channelSpendMap = {};
  for (const id of SPEND_IDS) {
    const m = extractDailyMap(metrics, id, baseYear);
    for (const [date, val] of Object.entries(m)) {
      channelSpendMap[date] = (channelSpendMap[date] ?? 0) + val;
    }
  }

  // ── Channel revenue maps (TW-attributed, per platform) ───────────
  const CHANNEL_DEFS = [
    { key: 'META',      spendId: 'facebookAds',   revId: 'facebookConversionValue', purchId: 'facebookPurchases' },
    { key: 'GOOGLE',    spendId: 'googleAds',      revId: 'googleConversionValue',  purchId: null },
    { key: 'TIKTOK',    spendId: 'tiktokAds',      revId: 'tiktokConversionValue',  purchId: 'tiktokPurchases' },
    { key: 'SNAPCHAT',  spendId: 'snapchatAds',    revId: 'snapchatConversionValue',purchId: 'snapchatConversions' },
    { key: 'PINTEREST', spendId: 'pinterestAds',   revId: 'pinterestConversionValue',purchId: 'pinterestPurchases' },
    { key: 'BING',      spendId: 'bingAdSpend',    revId: 'bingConversionValue',    purchId: 'bingConversions' },
    { key: 'APPLOVIN',  spendId: 'applovinSpend',  revId: 'applovinConversionValue',purchId: 'applovinConversions' },
  ];
  const channelMaps = CHANNEL_DEFS.map(def => ({
    ...def,
    spend: extractDailyMap(metrics, def.spendId, baseYear),
    rev:   extractDailyMap(metrics, def.revId,   baseYear),
    purch: def.purchId ? extractDailyMap(metrics, def.purchId, baseYear) : {},
  }));

  // ── Collect all dates ─────────────────────────────────────────────
  const allDates = new Set([
    ...Object.keys(orderRevMap),
    ...Object.keys(ordersMap),
    ...Object.keys(merMap),
  ]);
  const start = new Date(startDate);
  const end   = new Date(endDate);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    allDates.add(d.toISOString().slice(0, 10));
  }

  let written = 0;

  for (const date of [...allDates].sort()) {
    const twAttrRev     = twAttrRevMap[date]  ?? 0;  // TW pixel-attributed (sales metric)
    const orderRevenue  = orderRevMap[date]   ?? 0;  // Canonical: blendedSales (Shopify+Amazon)
    const amazonRev     = amazonRevMap[date]  ?? 0;
    const shopifyRev    = Math.max(0, orderRevenue - amazonRev);
    const totalSales    = netSalesMap[date]   ?? 0;
    const refundAmt     = refundsMap[date]    ?? 0;
    // Blended spend is preferred; fall back to sum of channels
    const totalSpend    = (blendedAdsMap[date] && blendedAdsMap[date] > 0)
      ? blendedAdsMap[date]
      : (channelSpendMap[date] ?? 0);
    const mer           = merMap[date]        ?? null;
    const totalOrders   = ordersMap[date]     ?? 0;
    const ncOrders      = ncOrdersMap[date]   ?? 0;
    const rcOrders      = Math.max(0, totalOrders - ncOrders);

    try {
      await pgRun(`
        INSERT INTO tw_summary_daily
          (brand, date,
           total_revenue, order_revenue, shopify_revenue, amazon_revenue,
           total_sales, refund_amount,
           total_spend, mer,
           total_orders, new_customer_orders, returning_customer_orders)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (brand, date) DO UPDATE SET
          total_revenue             = EXCLUDED.total_revenue,
          order_revenue             = EXCLUDED.order_revenue,
          shopify_revenue           = EXCLUDED.shopify_revenue,
          amazon_revenue            = EXCLUDED.amazon_revenue,
          total_sales               = EXCLUDED.total_sales,
          refund_amount             = EXCLUDED.refund_amount,
          total_spend               = EXCLUDED.total_spend,
          mer                       = EXCLUDED.mer,
          total_orders              = EXCLUDED.total_orders,
          new_customer_orders       = EXCLUDED.new_customer_orders,
          returning_customer_orders = EXCLUDED.returning_customer_orders,
          updated_at                = NOW()
      `, [
        brand, date,
        parseFloat(twAttrRev.toFixed(4)),      // $3  total_revenue  (TW pixel-attributed)
        parseFloat(orderRevenue.toFixed(4)),   // $4  order_revenue  (blendedSales — canonical)
        parseFloat(shopifyRev.toFixed(4)),     // $5  shopify_revenue
        parseFloat(amazonRev.toFixed(4)),      // $6  amazon_revenue
        parseFloat(totalSales.toFixed(4)),     // $7  total_sales
        parseFloat(refundAmt.toFixed(4)),      // $8  refund_amount
        parseFloat(totalSpend.toFixed(4)),     // $9  total_spend
        mer != null ? parseFloat(mer.toFixed(6)) : null, // $10 mer
        Math.round(totalOrders),               // $11 total_orders
        Math.round(ncOrders),                  // $12 new_customer_orders
        Math.round(rcOrders),                  // $13 returning_customer_orders
      ]);
      written++;
    } catch (e) {
      const msg = `Upsert ${brand}/${date}: ${e.message}`;
      console.error('[TW]', msg);
      errors.push(msg);
    }

    // ── Upsert channel rows for this date ─────────────────────────
    for (const ch of channelMaps) {
      const spend = ch.spend[date] ?? 0;
      if (spend <= 0) continue; // skip channels with no spend on this day

      const rev   = ch.rev[date]   ?? 0;
      const purch = ch.purch[date] ?? 0;
      const roas  = spend > 0 ? parseFloat((rev / spend).toFixed(4)) : null;
      const cac   = purch > 0 ? parseFloat((spend / purch).toFixed(4)) : null;

      try {
        await pgRun(`
          INSERT INTO tw_channel_daily
            (brand, date, channel, spend_1d, revenue_1d, purchases_1d, roas_1d, cac)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (brand, date, channel) DO UPDATE SET
            spend_1d     = EXCLUDED.spend_1d,
            revenue_1d   = EXCLUDED.revenue_1d,
            purchases_1d = EXCLUDED.purchases_1d,
            roas_1d      = EXCLUDED.roas_1d,
            cac          = EXCLUDED.cac,
            updated_at   = NOW()
        `, [
          brand, date, ch.key,
          parseFloat(spend.toFixed(4)),
          parseFloat(rev.toFixed(4)),
          Math.round(purch),
          roas,
          cac,
        ]);
      } catch (e) {
        errors.push(`channel ${brand}/${date}/${ch.key}: ${e.message}`);
      }
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
