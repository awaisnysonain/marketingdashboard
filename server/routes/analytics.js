const express = require('express');
const router  = express.Router();
const { pgQuery, pgQueryBatch } = require('../db/postgres');
const { METRICS: REVENUE_METRICS } = require('../config/revenueMetrics');
const { refreshNoblAirMetaAdDaily } = require('../etl/noblAirMetaAdDaily');
const { metaAdsDailySourceSql } = require('../etl/metaAdsSync');
const { getNoblAirDataVersion } = require('../utils/noblAirDataVersion');
const { getDataVersion } = require('../utils/dataVersion');
const { withResponseCache } = require('../utils/responseCache');
const { NOBL_PLAN_2026, NOBL_MER_TARGETS_2026 } = require('../config/forecastSheetConfig');
const { computeNoblStoreDailyForecast } = require('../forecast/noblForecastEngine');
const { buildAirAssumptions, buildNoblAirDailyForecast: buildAirDailyFromEngine } = require('../forecast/noblAirForecastEngine');

const metaAirWarmInFlight = new Set();

/*
 * ══════════════════════════════════════════════════════════════
 *  BRAND RULE: NOBL TRAVEL + NOBL EU = ONE STORE, ALWAYS COMBINED
 *  All queries using brand='NOBL' automatically include EU because
 *  NOBL operates a single Shopify store for all regions.
 *  See server/config/brandConfig.js for full documentation.
 * ══════════════════════════════════════════════════════════════
 */
// eslint-disable-next-line no-unused-vars
const { NOBL_BRAND, FLO_US_BRAND, getBrand, calcMer } = require('../config/brandConfig');
const {
  enrichSummaryRows, enrichChannelRows, enrichGeoRows,
} = require('../utils/twRowEnrich');

const NOBL_SUBS_DAILY_SQL = `
  SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
         sub_gross AS shopify_sub_gross,
         sub_discounts AS shopify_sub_disc,
         sub_refunds AS shopify_sub_refunds,
         rebill_revenue,
         new_sub_revenue,
         (sub_net_sales + rebill_revenue) AS sub_revenue_actual
  FROM nobl_air_daily
  WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
  ORDER BY date`;

// Default date range: current month-to-date
function getDefaultDates(req) {
  const end = req.query.end || new Date().toISOString().slice(0, 10);
  const start = req.query.start || (() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  })();
  return { start, end };
}

const ANALYTICS_REGION_ALLOWED = new Set(['US', 'UK', 'EU', 'CA', 'AUS', 'DUBAI', 'HK', 'INTL']);

function parseAnalyticsRegions(value) {
  const raw = String(value || 'ALL').toUpperCase();
  return Array.from(new Set(raw.split(',').map(s => s.trim()).filter(Boolean)))
    .filter(r => r !== 'ALL' && ANALYTICS_REGION_ALLOWED.has(r));
}

function regionSummarySql(tableName) {
  return `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                 SUM(revenue_actual) AS total_revenue,
                 SUM(spend_actual) AS total_spend,
                 CASE WHEN SUM(spend_actual) > 0 THEN SUM(revenue_actual) / SUM(spend_actual) ELSE NULL END AS mer,
                 NULL::numeric AS total_orders,
                 NULL::numeric AS new_customer_orders,
                 NULL::numeric AS returning_customer_orders,
                 SUM(revenue_actual) AS order_revenue,
                 NULL::numeric AS shopify_revenue,
                 NULL::numeric AS amazon_revenue,
                 SUM(revenue_actual) AS total_sales,
                 NULL::numeric AS refund_amount
          FROM ${tableName}
          WHERE UPPER(region) = ANY($3::text[])
            AND region != 'TOTAL'
            AND DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
          GROUP BY DATE(date AT TIME ZONE 'UTC'), TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD')
          ORDER BY date`;
}

function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function firstFinite(...values) {
  for (const v of values) {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function findNumericDeep(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  const wanted = new Set(names.map(s => String(s).toLowerCase()));
  const stack = [obj];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur)) {
      if (wanted.has(String(k).toLowerCase())) {
        const n = parseFloat(v);
        if (Number.isFinite(n)) return n;
      }
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

async function fetchJsonWithTimeout(url, { headers = {}, timeoutMs = 12000, attempts = 2 } = {}) {
  if (!url) return null;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

function appendQuery(url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
}

function parseDauMauMetric(payload, brand) {
  // FLO label is DAU / MAU stickiness. NOBL's legacy Daily Pulse label for the
  // same internal series key is "MAU / Active Subs", so it intentionally uses a
  // different numerator/denominator from the NOBL tag API.
  if (brand === 'NOBL') {
    const direct = findNumericDeep(payload, ['mauActiveSubscribersRatio', 'mau_active_subscribers_ratio', 'mauActiveSubsRatio']);
    if (direct != null) return direct;
    const mau = findNumericDeep(payload, ['mauCount', 'mau', 'monthlyActiveUsers', 'monthly_active_users']);
    const activeSubs = findNumericDeep(payload, ['activeSubscribersAmongMau', 'active_subscribers_among_mau', 'activeSubscribers']);
    return (mau != null && activeSubs > 0) ? mau / activeSubs : null;
  }
  const direct = findNumericDeep(payload, ['stickiness', 'dauMau', 'dau_mau', 'dauMauRatio', 'dau_mau_ratio', 'ratio']);
  if (direct != null) return direct > 1 ? direct / 100 : direct;
  const dau = findNumericDeep(payload, ['dau', 'dauCount', 'dailyActiveUsers', 'daily_active_users', 'activeUsers24h', 'active_users_24h', 'activeUsers']);
  const mau = findNumericDeep(payload, ['mau', 'mauCount', 'monthlyActiveUsers', 'monthly_active_users', 'activeUsers30d', 'active_users_30d']);
  return (dau != null && mau > 0) ? dau / mau : null;
}

function parseSessionDensity(payload, brand) {
  if (brand === 'NOBL') {
    const sessions = findNumericDeep(payload, ['sessionsInMauWindowCount', 'sessions_in_mau_window_count', 'totalSessionCount']);
    const mau = findNumericDeep(payload, ['mau', 'mauCount', 'monthlyActiveUsers', 'monthly_active_users']);
    return (sessions != null && mau > 0) ? sessions / mau : null;
  }
  const sessions = findNumericDeep(payload, ['totalSessionCountDauDay', 'sessionsPerDauNumerator', 'sessions_in_dau_day', 'sessions']);
  const dau = findNumericDeep(payload, ['dau', 'dauCount', 'dailyActiveUsers', 'daily_active_users']);
  const direct = findNumericDeep(payload, ['sessionsPerDau', 'sessions_per_dau']);
  if (direct != null) return direct;
  return (sessions != null && dau > 0) ? sessions / dau : null;
}

async function fetchDauMauMetrics(brand) {
  const isNobl = brand === 'NOBL';
  const baseUrl = isNobl ? process.env.NOBL_TAG_DAU_MAU_URL : process.env.FLO_DAU_MAU_URL;
  const token = isNobl ? process.env.NOBL_TAG_DAU_MAU_SECRET : process.env.FLO_DAU_MAU_API_KEY;
  if (!baseUrl || !token) return null;
  const url = isNobl ? appendQuery(baseUrl, { secret: token }) : baseUrl;
  // NOBL cloud function checks x-sprint-kpi-secret; FLO uses x-api-key. Provide
  // both header variants so we work with either implementation.
  const headers = isNobl
    ? { 'x-sprint-kpi-secret': token, 'x-secret': token }
    : { 'x-api-key': token };
  const payload = await fetchJsonWithTimeout(url, {
    headers,
    timeoutMs: 20000,
    attempts: 1,
  });
  return {
    dau_mau_stickiness: parseDauMauMetric(payload, brand),
    sessions_per_mau: brand === 'NOBL' ? parseSessionDensity(payload, brand) : null,
    sessions_per_dau: brand === 'FLO' ? parseSessionDensity(payload, brand) : null,
  };
}

// NOBL Airplus API — provides Air Paid Churn Rate/Count + AIR+ popup metrics.
async function fetchNoblAirplusMetrics() {
  const url = process.env.NOBL_AIRPLUS_URL;
  const secret = process.env.NOBL_AIRPLUS_SECRET;
  if (!url || !secret) return null;
  try {
    const full = appendQuery(url, { secret });
    const payload = await fetchJsonWithTimeout(full, {
      headers: { 'x-sprint-kpi-secret': secret, 'x-secret': secret },
      timeoutMs: 20000,
      attempts: 1,
    });
    // The endpoint returns per-period metrics; extract the top-level ones.
    const churnRate = firstFinite(
      payload?.paidChurnRate, payload?.airPaidChurnRate,
      payload?.churnRate, payload?.data?.paidChurnRate,
    );
    const churnCount = firstFinite(
      payload?.paidChurnCount, payload?.airPaidChurnCount,
      payload?.churnCount, payload?.data?.paidChurnCount,
    );
    const popupShown = firstFinite(payload?.popupShown, payload?.popup?.shown, payload?.data?.popupShown);
    const popupDismissed = firstFinite(payload?.popupDismissed, payload?.popup?.dismissed, payload?.data?.popupDismissed);
    const popupCta = firstFinite(payload?.popupCtaTapped, payload?.popup?.ctaTapped, payload?.data?.popupCtaTapped);
    const popupPurchases = firstFinite(payload?.popupPurchases, payload?.popup?.purchases, payload?.data?.popupPurchases);
    return {
      air_paid_churn_rate: churnRate,
      air_paid_churn_count: churnCount,
      airplus_popup_shown: popupShown,
      airplus_popup_dismissed: popupDismissed,
      airplus_popup_cta_tapped: popupCta,
      airplus_popup_purchases: popupPurchases,
    };
  } catch (e) {
    console.warn('[KPI Pulse Airplus]', e.message);
    return null;
  }
}

function envList(name) {
  return String(process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
}

function parsePageSpeedScore(payload) {
  const score = payload?.lighthouseResult?.categories?.performance?.score;
  const n = firstFinite(score);
  if (n != null) return n <= 1 ? n * 100 : n;
  return firstFinite(
    payload?.loadingExperience?.metrics?.FIRST_CONTENTFUL_PAINT_MS?.percentile,
    payload?.originLoadingExperience?.metrics?.FIRST_CONTENTFUL_PAINT_MS?.percentile,
  );
}

async function fetchPageSpeedMetric(brand) {
  const key = process.env.PAGESPEED_API_KEY;
  const urls = [
    ...envList(brand === 'NOBL' ? 'PAGESPEED_NOBL_URLS' : 'PAGESPEED_FLO_URLS'),
    ...envList(brand === 'NOBL' ? 'NOBL_PAGESPEED_URL' : 'FLO_PAGESPEED_URL'),
  ];
  if (!urls.length) urls.push(brand === 'NOBL' ? 'https://nobltravel.com' : 'https://pilatesflo.com');
  const scores = [];
  for (const pageUrl of urls) {
    const apiUrl = appendQuery('https://www.googleapis.com/pagespeedonline/v5/runPagespeed', {
      url: pageUrl,
      key,
      strategy: 'mobile',
      category: 'performance',
    });
    try {
      const payload = await fetchJsonWithTimeout(apiUrl, { timeoutMs: 240000, attempts: 1 });
      const score = parsePageSpeedScore(payload);
      if (score != null) scores.push(score);
    } catch (e) {
      console.warn(`[KPI Pulse PageSpeed] ${brand} ${pageUrl}: ${e.message}`);
    }
  }
  return scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
}

async function fetchKpiPulseLiveMetrics() {
  const safe = (p) => p.catch((e) => { console.warn(`[KPI Pulse live source] ${e.message}`); return null; });
  // DAU/MAU cloud functions are lightweight but can be picky about concurrent
  // calls/headers. Fetch them first and sequentially, then run PageSpeed in
  // parallel (PageSpeed is the slow source).
  const floDau = await safe(fetchDauMauMetrics('FLO'));
  const noblDau = await safe(fetchDauMauMetrics('NOBL'));
  const airplus = await safe(fetchNoblAirplusMetrics());
  const [noblPs, floPs] = await Promise.all([
    safe(fetchPageSpeedMetric('NOBL')),
    safe(fetchPageSpeedMetric('FLO')),
  ]);
  return {
    NOBL: { ...(noblDau || {}), ...(airplus || {}), pagespeed_pdp_aio: noblPs },
    FLO:  { ...(floDau || {}),  pagespeed_pdp_aio: floPs },
  };
}

const kpiLiveMetricsCache = { ts: 0, data: null, promise: null };
const KPI_LIVE_TTL_MS = 6 * 60 * 60 * 1000;
function refreshKpiPulseLiveMetricsBackground() {
  if (kpiLiveMetricsCache.promise) return kpiLiveMetricsCache.promise;
  kpiLiveMetricsCache.promise = fetchKpiPulseLiveMetrics()
    .then((data) => {
      kpiLiveMetricsCache.ts = Date.now();
      kpiLiveMetricsCache.data = data;
      return data;
    })
    .catch((e) => {
      console.warn(`[KPI Pulse live refresh] ${e.message}`);
      return kpiLiveMetricsCache.data;
    })
    .finally(() => { kpiLiveMetricsCache.promise = null; });
  return kpiLiveMetricsCache.promise;
}

async function getKpiPulseLiveMetricsFast() {
  const fresh = kpiLiveMetricsCache.data && (Date.now() - kpiLiveMetricsCache.ts < KPI_LIVE_TTL_MS);
  if (fresh) return kpiLiveMetricsCache.data;
  // Never block the KPI matrix on live APIs. PageSpeed can take 1–3 minutes and
  // sometimes aborts/rate-limits; the database-backed matrix must still render.
  // The background refresh will be overlaid onto subsequent responses once ready.
  refreshKpiPulseLiveMetricsBackground();
  return kpiLiveMetricsCache.data;
}

function applyKpiPulseLiveMetrics(cadenceData, liveMetrics) {
  if (!liveMetrics || !cadenceData?.periods?.length) return cadenceData;
  // Live APIs are current snapshots, not historical series. Only stamp them
  // onto the latest visible period (daily/latest week/current QTD), never onto
  // older periods.
  for (const brand of ['NOBL', 'FLO']) {
    if (!cadenceData.series[brand]) cadenceData.series[brand] = {};
    for (const key of ['pagespeed_pdp_aio', 'dau_mau_stickiness', 'sessions_per_mau', 'sessions_per_dau',
      'air_paid_churn_rate', 'air_paid_churn_count',
      'airplus_popup_shown', 'airplus_popup_dismissed', 'airplus_popup_cta_tapped', 'airplus_popup_purchases']) {
      const v = liveMetrics?.[brand]?.[key];
      if (v == null || !Number.isFinite(Number(v))) continue;
      cadenceData.series[brand][key] = cadenceData.periods.map((_, idx) => (idx === 0 ? Number(v) : null));
    }
  }
  return cadenceData;
}

function firstActionValue(items, actionTypes) {
  if (!Array.isArray(items)) return 0;
  for (const actionType of actionTypes) {
    const match = items.find(item => item.action_type === actionType);
    if (match) return toNum(match.value);
  }
  return 0;
}

function normalizeMetaAdSet(row) {
  const purchaseTypes = [
    'omni_purchase',
    'purchase',
    'web_in_store_purchase',
    'onsite_web_purchase',
    'offsite_conversion.fb_pixel_purchase',
  ];
  const spend = toNum(row.spend);
  const purchases = firstActionValue(row.actions, purchaseTypes);
  const purchaseRevenue = firstActionValue(row.action_values, purchaseTypes);
  const reportedRoas = firstActionValue(row.purchase_roas, purchaseTypes);
  const roas = reportedRoas || (spend > 0 ? purchaseRevenue / spend : 0);

  return {
    campaign_id: row.campaign_id || '',
    campaign_name: row.campaign_name || '',
    adset_id: row.adset_id || '',
    adset_name: row.adset_name || 'Unknown ad set',
    spend,
    impressions: Math.round(toNum(row.impressions)),
    reach: Math.round(toNum(row.reach)),
    clicks: Math.round(toNum(row.clicks)),
    inline_link_clicks: Math.round(toNum(row.inline_link_clicks)),
    ctr: toNum(row.ctr),
    cpc: toNum(row.cpc),
    cpm: toNum(row.cpm),
    purchases,
    purchase_revenue: purchaseRevenue,
    purchase_roas: roas,
    cost_per_purchase: purchases > 0 ? spend / purchases : null,
  };
}

// Format rows: parse numeric fields as floats, date fields as YYYY-MM-DD strings
function fmtRows(rows) {
  return rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined) {
        out[k] = null;
      } else if (v instanceof Date) {
        out[k] = v.toISOString().slice(0, 10);
      } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        out[k] = v.slice(0, 10);
      } else {
        const num = parseFloat(v);
        out[k] = isNaN(num) || typeof v === 'string' && isNaN(Number(v)) ? v : num;
      }
    }
    return out;
  });
}

function buildNoblAirSubscriberTtpSql(regionJoin, matureWhereSql) {
  return `
    WITH subscribers AS (
      SELECT
        s.appstle_id,
        s.customer_id,
        s.created_at,
        s.cancelled_on,
        COALESCE(
          s.last_billing_date,
          (CASE
            WHEN jsonb_typeof(s.raw_json->'lastSuccessfulOrder') = 'object'
              THEN (s.raw_json->'lastSuccessfulOrder'->>'orderDate')::timestamptz
            WHEN jsonb_typeof(s.raw_json->'lastSuccessfulOrder') = 'string'
              THEN ((s.raw_json->>'lastSuccessfulOrder')::jsonb->>'orderDate')::timestamptz
            ELSE NULL
          END)
        ) AS paid_billing_date
      FROM nobl_air_subscribers s
      ${regionJoin}
      WHERE ${matureWhereSql}
    ), subscriber_rebills AS (
      SELECT DISTINCT s.appstle_id
      FROM subscribers s
      JOIN shopify_orders_raw o ON o.brand = 'NOBL'
        AND o.is_rebill
        AND (
          s.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
          OR s.customer_id = o.customer_id
        )
      WHERE o.created_at > s.created_at
    )
    SELECT
      COUNT(*)::int AS mature,
      COUNT(*) FILTER (WHERE s.paid_billing_date > s.created_at OR rb.appstle_id IS NOT NULL)::int AS converted,
      COUNT(*) FILTER (WHERE
        s.cancelled_on IS NOT NULL
        AND s.cancelled_on <= s.created_at + INTERVAL '30 days'
      )::int AS cancelled_30d
    FROM subscribers s
    LEFT JOIN subscriber_rebills rb ON rb.appstle_id = s.appstle_id
  `;
}

const ttpAsOfMemCache = new Map();
const TTP_ASOF_MEM_TTL_MS = 5 * 60 * 1000;

async function loadNoblAirTtpAsOfEndFromSnapshot(end) {
  const mem = ttpAsOfMemCache.get(end);
  if (mem && Date.now() - mem.ts < TTP_ASOF_MEM_TTL_MS) return mem.data;

  const r = await pgQuery(`
    SELECT mature, converted, cancelled_30d, ttp_rate, cancel_rate_30d
    FROM nobl_air_ttp_snapshot
    WHERE as_of_date <= $1::date
    ORDER BY as_of_date DESC
    LIMIT 1
  `, [end]);
  const row = r.rows[0];
  if (!row) return null;

  const data = {
    mature: Number(row.mature || 0),
    converted: Number(row.converted || 0),
    cancelled_30d: Number(row.cancelled_30d || 0),
    ttp_rate: row.ttp_rate != null ? Number(row.ttp_rate) : null,
    cancel_rate_30d: row.cancel_rate_30d != null ? Number(row.cancel_rate_30d) : null,
  };
  ttpAsOfMemCache.set(end, { ts: Date.now(), data });
  return data;
}

async function loadNoblAirTtpAsOfEnd(end, countryCodes = null) {
  if (!countryCodes) {
    const cached = await loadNoblAirTtpAsOfEndFromSnapshot(end);
    if (cached) return cached;
  }

  const regionJoin = countryCodes ? `
    JOIN shopify_orders_raw o ON o.brand = 'NOBL'
      AND o.has_air
      AND o.has_luggage
      AND o.shipping_country = ANY($2::text[])
      AND (
        o.order_name = s.order_name
        OR o.order_id = s.graph_order_id
        OR o.order_id = CONCAT('gid://shopify/Order/', s.graph_order_id)
        OR CONCAT('gid://shopify/Order/', o.order_id) = s.graph_order_id
      )` : '';
  const matureWhere = `(s.created_at AT TIME ZONE 'UTC')::date <= ($1::date - INTERVAL '14 days')::date`;
  const params = countryCodes ? [end, countryCodes] : [end];
  const r = await pgQuery(buildNoblAirSubscriberTtpSql(regionJoin, matureWhere), params);
  const row = r.rows[0] || {};
  const mature = Number(row.mature || 0);
  const converted = Number(row.converted || 0);
  const cancelled30d = Number(row.cancelled_30d || 0);
  return {
    mature,
    converted,
    cancelled_30d: cancelled30d,
    ttp_rate: mature > 0 ? Number((converted / mature).toFixed(4)) : null,
    cancel_rate_30d: mature > 0 ? Number((cancelled30d / mature).toFixed(4)) : null,
  };
}

async function loadNoblAirTtpPeriod(start, end, countryCodes = null) {
  if (!countryCodes) {
    const r = await pgQuery(`
      SELECT
        COALESCE(SUM(mature_count), 0)::int AS mature,
        COALESCE(SUM(converted_count), 0)::int AS converted
      FROM nobl_air_daily
      WHERE date BETWEEN $1::date AND $2::date
    `, [start, end]);
    const row = r.rows[0] || {};
    return {
      mature: Number(row.mature || 0),
      converted: Number(row.converted || 0),
    };
  }
  const regionJoin = countryCodes ? `
    JOIN shopify_orders_raw o ON o.brand = 'NOBL'
      AND o.has_air
      AND o.has_luggage
      AND o.shipping_country = ANY($3::text[])
      AND (
        o.order_name = s.order_name
        OR o.order_id = s.graph_order_id
        OR o.order_id = CONCAT('gid://shopify/Order/', s.graph_order_id)
        OR CONCAT('gid://shopify/Order/', o.order_id) = s.graph_order_id
      )` : '';
  const matureWhere = `(s.created_at AT TIME ZONE 'UTC')::date + 14 BETWEEN $1::date AND $2::date`;
  const r = await pgQuery(buildNoblAirSubscriberTtpSql(regionJoin, matureWhere), [start, end, countryCodes]);
  const row = r.rows[0] || {};
  return {
    mature: Number(row.mature || 0),
    converted: Number(row.converted || 0),
  };
}

async function loadNoblAirTtpCohort(start, end, countryCodes = null) {
  const [asOf, period] = await Promise.all([
    loadNoblAirTtpAsOfEnd(end, countryCodes),
    loadNoblAirTtpPeriod(start, end, countryCodes),
  ]);
  const matureInPeriod = Number(period.mature || 0);
  const convertedInPeriod = Number(period.converted || 0);
  return {
    ...asOf,
    ttp_rate_as_of: asOf.ttp_rate,
    paid_conversions_in_period: convertedInPeriod,
    mature_in_period: matureInPeriod,
    ttp_rate_in_period: matureInPeriod > 0
      ? Number((convertedInPeriod / matureInPeriod).toFixed(4))
      : null,
  };
}

/** @deprecated use loadNoblAirTtpCohort */
async function loadNoblAirOverallTtp(start, end, countryCodes = null) {
  return loadNoblAirTtpCohort(start, end, countryCodes);
}

async function loadNoblAirRegionalDaily(start, end, countryCodes) {
  const r = await pgQuery(`
    WITH o AS (
      SELECT *, (created_at AT TIME ZONE 'UTC')::date AS report_date
      FROM shopify_orders_raw
      WHERE brand = 'NOBL'
        AND (created_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
        AND shipping_country = ANY($3::text[])
    ),
    daily_orders AS (
      SELECT
        report_date AS date,
        COUNT(*) FILTER (WHERE NOT is_rebill) AS total_orders,
        COUNT(*) FILTER (WHERE has_air AND has_luggage) AS air_orders,
        COUNT(*) FILTER (WHERE has_air AND has_luggage AND has_paid_air) AS paid_air_orders,
        COUNT(*) FILTER (WHERE has_air AND has_luggage AND has_zero_air) AS zero_air_orders,
        COUNT(*) FILTER (WHERE is_rebill) AS rebill_orders,
        COALESCE(SUM(tag_gross) FILTER (WHERE NOT is_rebill), 0) AS tag_gross,
        COALESCE(SUM(tag_discounts) FILTER (WHERE NOT is_rebill), 0) AS tag_discounts,
        COALESCE(SUM(tag_refunds) FILTER (WHERE NOT is_rebill), 0) AS tag_refunds,
        COALESCE(SUM(sub_gross) FILTER (WHERE NOT is_rebill), 0) AS sub_gross,
        COALESCE(SUM(sub_discounts) FILTER (WHERE NOT is_rebill), 0) AS sub_discounts,
        COALESCE(SUM(sub_refunds) FILTER (WHERE NOT is_rebill), 0) AS sub_refunds,
        COALESCE(SUM(total_price) FILTER (WHERE is_rebill), 0) AS rebill_revenue
      FROM o
      GROUP BY report_date
    ),
    new_tiers AS (
      SELECT
        o.report_date AS date,
        s.contract_amount,
        COUNT(*)::int AS n
      FROM o
      JOIN nobl_air_subscribers s ON s.order_name = o.order_name
      WHERE o.has_air AND o.has_luggage
      GROUP BY o.report_date, s.contract_amount
    ),
    rebill_tiers AS (
      SELECT
        o.report_date AS date,
        s.contract_amount,
        COUNT(*)::int AS n
      FROM o
      LEFT JOIN nobl_air_subscribers s ON
        s.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
        OR s.customer_id = o.customer_id
      WHERE o.is_rebill
      GROUP BY o.report_date, s.contract_amount
    ),
    new_tiers_pivot AS (
      SELECT
        date,
        SUM(CASE WHEN ROUND(contract_amount) = 49 THEN n ELSE 0 END)::int AS new_49,
        SUM(CASE WHEN ROUND(contract_amount) = 79 THEN n ELSE 0 END)::int AS new_79,
        SUM(CASE WHEN ROUND(contract_amount) = 89 THEN n ELSE 0 END)::int AS new_89,
        SUM(CASE WHEN ROUND(contract_amount) = 99 THEN n ELSE 0 END)::int AS new_99,
        SUM(CASE WHEN ROUND(contract_amount) = 109 THEN n ELSE 0 END)::int AS new_109,
        SUM(CASE WHEN ROUND(contract_amount) = 119 THEN n ELSE 0 END)::int AS new_119,
        SUM(CASE WHEN ROUND(contract_amount) = 129 THEN n ELSE 0 END)::int AS new_129,
        SUM(CASE WHEN ROUND(contract_amount) = 139 THEN n ELSE 0 END)::int AS new_139,
        SUM(CASE WHEN ROUND(contract_amount) = 149 THEN n ELSE 0 END)::int AS new_149,
        SUM(CASE WHEN ROUND(contract_amount) = 159 THEN n ELSE 0 END)::int AS new_159
      FROM new_tiers
      GROUP BY date
    ),
    rebill_tiers_pivot AS (
      SELECT
        date,
        SUM(CASE WHEN ROUND(contract_amount) = 49 THEN n ELSE 0 END)::int AS rebill_49,
        SUM(CASE WHEN ROUND(contract_amount) = 79 THEN n ELSE 0 END)::int AS rebill_79,
        SUM(CASE WHEN ROUND(contract_amount) = 89 THEN n ELSE 0 END)::int AS rebill_89,
        SUM(CASE WHEN ROUND(contract_amount) = 99 THEN n ELSE 0 END)::int AS rebill_99,
        SUM(CASE WHEN ROUND(contract_amount) = 109 THEN n ELSE 0 END)::int AS rebill_109,
        SUM(CASE WHEN ROUND(contract_amount) = 119 THEN n ELSE 0 END)::int AS rebill_119,
        SUM(CASE WHEN ROUND(contract_amount) = 129 THEN n ELSE 0 END)::int AS rebill_129,
        SUM(CASE WHEN ROUND(contract_amount) = 139 THEN n ELSE 0 END)::int AS rebill_139,
        SUM(CASE WHEN ROUND(contract_amount) = 149 THEN n ELSE 0 END)::int AS rebill_149,
        SUM(CASE WHEN ROUND(contract_amount) = 159 THEN n ELSE 0 END)::int AS rebill_159
      FROM rebill_tiers
      GROUP BY date
    ),
    regional_subscribers AS (
        SELECT DISTINCT
          s.appstle_id,
          s.customer_id,
          s.created_at,
          s.cancelled_on,
        COALESCE(
          s.last_billing_date,
          (CASE
            WHEN jsonb_typeof(s.raw_json->'lastSuccessfulOrder') = 'object'
              THEN (s.raw_json->'lastSuccessfulOrder'->>'orderDate')::timestamptz
            WHEN jsonb_typeof(s.raw_json->'lastSuccessfulOrder') = 'string'
              THEN ((s.raw_json->>'lastSuccessfulOrder')::jsonb->>'orderDate')::timestamptz
            ELSE NULL
          END)
          ) AS paid_billing_date,
          s.is_same_day_cancel
      FROM nobl_air_subscribers s
      JOIN shopify_orders_raw so ON so.brand = 'NOBL'
        AND so.has_air
        AND so.has_luggage
        AND so.shipping_country = ANY($3::text[])
        AND (
          so.order_name = s.order_name
          OR so.order_id = s.graph_order_id
          OR so.order_id = CONCAT('gid://shopify/Order/', s.graph_order_id)
          OR CONCAT('gid://shopify/Order/', so.order_id) = s.graph_order_id
        )
      WHERE (s.created_at AT TIME ZONE 'UTC')::date BETWEEN ($1::date - INTERVAL '14 days')::date AND $2::date
    ), regional_rebills AS (
      SELECT DISTINCT s.appstle_id
      FROM regional_subscribers s
      JOIN shopify_orders_raw o ON o.brand = 'NOBL'
        AND o.is_rebill
        AND (
          s.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
          OR s.customer_id = o.customer_id
        )
      WHERE o.created_at > s.created_at
    ),
    same_day_cancel_cohorts AS (
      SELECT
        (created_at AT TIME ZONE 'UTC')::date AS date,
        COUNT(*) FILTER (WHERE is_same_day_cancel)::int AS same_day_cancels
      FROM regional_subscribers
      WHERE (created_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
      GROUP BY (created_at AT TIME ZONE 'UTC')::date
    ),
    ttp_cohorts AS (
      SELECT
        (created_at AT TIME ZONE 'UTC')::date + 14 AS date,
        COUNT(*)::int AS mature_count,
        COUNT(*) FILTER (WHERE paid_billing_date > created_at OR rb.appstle_id IS NOT NULL)::int AS converted_count
      FROM regional_subscribers
      LEFT JOIN regional_rebills rb USING (appstle_id)
      WHERE (created_at AT TIME ZONE 'UTC')::date + 14 BETWEEN $1::date AND $2::date
      GROUP BY (created_at AT TIME ZONE 'UTC')::date + 14
    ),
    lag_attach AS (
      SELECT
        d.date,
        CASE
          WHEN COUNT(*) FILTER (WHERE NOT so.is_rebill) > 0
            THEN ROUND(
              COUNT(*) FILTER (WHERE so.has_air AND so.has_luggage)::numeric
              / COUNT(*) FILTER (WHERE NOT so.is_rebill),
              4
            )
          ELSE NULL
        END AS attach_rate_14d_prior
      FROM daily_orders d
      LEFT JOIN shopify_orders_raw so ON so.brand = 'NOBL'
        AND (so.created_at AT TIME ZONE 'UTC')::date = (d.date - INTERVAL '14 days')::date
        AND so.shipping_country = ANY($3::text[])
      GROUP BY d.date
    )
    SELECT
      TO_CHAR(d.date, 'YYYY-MM-DD') AS date,
      d.total_orders, d.air_orders,
      CASE WHEN d.total_orders > 0 THEN ROUND(d.air_orders::numeric / d.total_orders, 4) ELSE NULL END AS attach_rate,
      CASE
        WHEN COALESCE(t.mature_count, 0) > 0 THEN ROUND(t.converted_count::numeric / NULLIF(t.mature_count,0), 4)
        ELSE NULL
      END AS ttp_rate,
      CASE
        WHEN la.attach_rate_14d_prior IS NOT NULL AND (
          CASE
            WHEN COALESCE(t.mature_count, 0) > 0 THEN t.converted_count::numeric / NULLIF(t.mature_count, 0)
            ELSE NULL
          END
        ) IS NOT NULL THEN ROUND(la.attach_rate_14d_prior * (
          CASE
            WHEN COALESCE(t.mature_count, 0) > 0 THEN t.converted_count::numeric / NULLIF(t.mature_count, 0)
            ELSE NULL
          END
        ), 4)
        ELSE NULL
      END AS activation_rate,
      d.zero_air_orders, d.paid_air_orders, d.rebill_orders, COALESCE(sc.same_day_cancels, 0) AS same_day_cancels,
      d.tag_gross, d.tag_discounts, (d.tag_gross - d.tag_discounts) AS tag_net_sales,
      d.sub_gross, d.sub_discounts, (d.sub_gross - d.sub_discounts) AS sub_net_sales,
      d.rebill_revenue, (d.sub_gross - d.sub_discounts) AS new_sub_revenue,
      (d.tag_gross + d.sub_gross + d.rebill_revenue) AS combined_gross,
      (d.tag_gross + d.sub_gross - d.tag_discounts - d.sub_discounts + d.rebill_revenue) AS combined_net_sales,
      d.tag_refunds, d.sub_refunds,
      (d.tag_gross + d.sub_gross - d.tag_discounts - d.sub_discounts - d.tag_refunds - d.sub_refunds + d.rebill_revenue) AS combined_net_revenue,
      COALESCE(np.new_49, 0) AS new_49,
      COALESCE(np.new_79, 0) AS new_79,
      COALESCE(np.new_89, 0) AS new_89,
      COALESCE(np.new_99, 0) AS new_99,
      COALESCE(np.new_109, 0) AS new_109,
      COALESCE(np.new_119, 0) AS new_119,
      COALESCE(np.new_129, 0) AS new_129,
      COALESCE(np.new_139, 0) AS new_139,
      COALESCE(np.new_149, 0) AS new_149,
      COALESCE(np.new_159, 0) AS new_159,
      COALESCE(rp.rebill_49, 0) AS rebill_49,
      COALESCE(rp.rebill_79, 0) AS rebill_79,
      COALESCE(rp.rebill_89, 0) AS rebill_89,
      COALESCE(rp.rebill_99, 0) AS rebill_99,
      COALESCE(rp.rebill_109, 0) AS rebill_109,
      COALESCE(rp.rebill_119, 0) AS rebill_119,
      COALESCE(rp.rebill_129, 0) AS rebill_129,
      COALESCE(rp.rebill_139, 0) AS rebill_139,
      COALESCE(rp.rebill_149, 0) AS rebill_149,
      COALESCE(rp.rebill_159, 0) AS rebill_159
    FROM daily_orders d
    LEFT JOIN ttp_cohorts t ON t.date = d.date
    LEFT JOIN same_day_cancel_cohorts sc ON sc.date = d.date
    LEFT JOIN lag_attach la ON la.date = d.date
    LEFT JOIN new_tiers_pivot np ON np.date = d.date
    LEFT JOIN rebill_tiers_pivot rp ON rp.date = d.date
    ORDER BY d.date ASC
  `, [start, end, countryCodes]);
  return fmtRows(r.rows);
}

async function loadNoblAirRegionalCachedDaily(start, end, regionKey) {
  const r = await pgQuery(`
    SELECT
      TO_CHAR(date, 'YYYY-MM-DD') AS date,
              total_orders, air_orders, attach_rate, ttp_rate, activation_rate,
              mature_count, converted_count, cancelled_30d_count, cancel_rate_30d,
              zero_air_orders, paid_air_orders, rebill_orders, same_day_cancels,
      tag_gross, tag_discounts, tag_net_sales,
      sub_gross, sub_discounts, sub_net_sales,
      rebill_revenue, new_sub_revenue,
      combined_gross, combined_net_sales,
      tag_refunds, sub_refunds, combined_net_revenue,
      new_49, new_79, new_89, new_99, new_109, new_119, new_129, new_139, new_149, new_159,
      rebill_49, rebill_79, rebill_89, rebill_99, rebill_109, rebill_119, rebill_129, rebill_139, rebill_149, rebill_159
    FROM nobl_air_region_daily
    WHERE region_key = $1
      AND date BETWEEN $2::date AND $3::date
    ORDER BY date ASC
  `, [regionKey, start, end]);
  return fmtRows(r.rows);
}

async function loadNoblAirRegionalCachedTtp(start, end, regionKey) {
  const [asOfRes, periodRes] = await Promise.all([
    pgQuery(`
      SELECT
        COALESCE(SUM(mature_count), 0)::int AS mature,
        COALESCE(SUM(converted_count), 0)::int AS converted,
        COALESCE(SUM(cancelled_30d_count), 0)::int AS cancelled_30d
      FROM nobl_air_region_daily
      WHERE region_key = $1
        AND date <= $2::date
    `, [regionKey, end]),
    pgQuery(`
      SELECT
        COALESCE(SUM(mature_count), 0)::int AS mature,
        COALESCE(SUM(converted_count), 0)::int AS converted
      FROM nobl_air_region_daily
      WHERE region_key = $1
        AND date BETWEEN $2::date AND $3::date
    `, [regionKey, start, end]),
  ]);
  const asOf = asOfRes.rows[0] || {};
  const period = periodRes.rows[0] || {};
  const mature = Number(asOf.mature || 0);
  const converted = Number(asOf.converted || 0);
  const cancelled30d = Number(asOf.cancelled_30d || 0);
  return {
    mature,
    converted,
    cancelled_30d: cancelled30d,
    ttp_rate: mature > 0 ? Number((converted / mature).toFixed(4)) : null,
    cancel_rate_30d: mature > 0 ? Number((cancelled30d / mature).toFixed(4)) : null,
    paid_conversions_in_period: Number(period.converted || 0),
    mature_in_period: Number(period.mature || 0),
    ttp_rate_as_of: mature > 0 ? Number((converted / mature).toFixed(4)) : null,
    ttp_rate_in_period: Number(period.mature || 0) > 0
      ? Number((Number(period.converted || 0) / Number(period.mature || 0)).toFixed(4))
      : null,
  };
}

function monthKey(dateString) {
  return String(dateString || '').slice(0, 7);
}

function daysInMonthFromKey(key) {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthEndFromKey(key) {
  return `${key}-${String(daysInMonthFromKey(key)).padStart(2, '0')}`;
}

const FORECAST_BRANDS = {
  NOBL: {
    label: 'NOBL Travel',
    summaryTable: 'nobl_brand_tw_summary_daily',
    geoTable: 'nobl_brand_tw_geo_daily',
    plan: { ...NOBL_PLAN_2026 },
    merTargets: { ...NOBL_MER_TARGETS_2026 },
    regionMerRatios: { USA: 1, US: 1, Canada: 0.729, CA: 0.729, Australia: 0.691, AUS: 0.691, UK: 0.729, EU: 0.0031 },
  },
  FLO: {
    label: 'Pilates FLO',
    summaryTable: 'flo_brand_tw_summary_daily',
    geoTable: 'flo_brand_tw_geo_daily',
    plan: {},
    merTargets: {},
    regionMerRatios: {},
  },
};

const FORECAST_MONTHS_2026 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_WEIGHTS = { 0: 1.25, 1: 0.85, 2: 0.85, 3: 0.85, 4: 0.85, 5: 0.95, 6: 1.35 };
const MONTH_SEASONALITY = {
  '01': 0.78, '02': 0.82, '03': 0.90, '04': 0.90,
  '05': 1.08, '06': 1.15, '07': 1.35, '08': 1.32,
  '09': 1.02, '10': 0.82, '11': 2.15, '12': 2.05,
};
const SALE_WINDOWS = [
  { start: '2026-05-22', end: '2026-05-31', tier: 'strong', name: 'Memorial Day' },
  { start: '2026-06-10', end: '2026-06-16', tier: 'medium', name: "Father's Day / UK Launch" },
  { start: '2026-06-27', end: '2026-07-06', tier: 'strong', name: 'July 4th' },
  { start: '2026-08-25', end: '2026-09-07', tier: 'medium', name: 'Labor Day' },
  { start: '2026-11-20', end: '2026-11-30', tier: 'strong', name: 'Black Friday / Cyber Monday' },
  { start: '2026-12-10', end: '2026-12-31', tier: 'strong', name: 'Holiday / Year-End' },
];
const SALE_LIFTS = { gap: 1.00, weak: 1.05, medium: 1.22, strong: 1.50 };
const DROP_WINDOWS = [
  ['2026-05-30','new_product_drop'], ['2026-06-13','variation_drop'], ['2026-06-27','new_color_drop'],
  ['2026-07-11','capsule_drop'], ['2026-07-25','new_product_collection'], ['2026-08-08','variation_drop'],
  ['2026-08-22','color_collection_drop'], ['2026-09-05','new_color_drop'], ['2026-09-19','capsule_drop'],
  ['2026-10-03','variation_drop'], ['2026-10-17','new_product_drop'], ['2026-10-31','color_collection_drop'],
  ['2026-11-14','new_product_collection'], ['2026-11-28','variation_drop'], ['2026-12-12','capsule_drop'],
].map(([start, type]) => ({ start, end: addDaysISO(start, 5), type }));
const DROP_LIFTS = {
  new_product_drop: { weak: 1.30, medium: 1.225, strong: 1.15, gap: 1.30 },
  new_product_collection: { weak: 1.35, medium: 1.2625, strong: 1.175, gap: 1.35 },
  new_color_drop: { weak: 1.20, medium: 1.15, strong: 1.10, gap: 1.20 },
  variation_drop: { weak: 1.18, medium: 1.135, strong: 1.09, gap: 1.18 },
  color_collection_drop: { weak: 1.12, medium: 1.09, strong: 1.06, gap: 1.12 },
  capsule_drop: { weak: 1.10, medium: 1.075, strong: 1.05, gap: 1.10 },
};

function addDaysISO(dateString, days) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function eachDateISO(start, end) {
  const out = [];
  for (let d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function monthLabel(key) {
  const idx = Math.max(0, Math.min(11, Number(key.slice(5, 7)) - 1));
  return `${MONTH_LABELS[idx]} ${key.slice(0, 4)}`;
}

function saleForDate(date) {
  return SALE_WINDOWS.find(s => date >= s.start && date <= s.end) || null;
}

function dropForDate(date) {
  return DROP_WINDOWS.find(d => date >= d.start && date <= d.end) || null;
}

function forecastDayFactors(date) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const sale = saleForDate(date);
  const drop = dropForDate(date);
  const saleTier = sale?.tier || 'gap';
  const dayWeight = DAY_WEIGHTS[dow] || 1;
  const seasonality = MONTH_SEASONALITY[date.slice(5, 7)] || 1;
  const saleLift = SALE_LIFTS[saleTier] || 1;
  const dropLift = drop ? (DROP_LIFTS[drop.type]?.[saleTier] || 1) : 1;
  return {
    day_weight: dayWeight,
    seasonality,
    sale_tier: saleTier,
    sale_name: sale?.name || 'Gap / Evergreen',
    sale_lift: saleLift,
    drop_type: drop?.type || null,
    drop_lift: dropLift,
    weight: dayWeight * seasonality * saleLift * dropLift,
  };
}

function forecastStatus(variancePct) {
  if (variancePct == null) return 'model';
  const abs = Math.abs(variancePct);
  if (abs <= 0.05) return 'green';
  if (abs <= 0.15) return 'amber';
  return 'red';
}

// Directional status for actual-vs-forecast: beating/hitting forecast is green,
// missing is amber/red depending on how far below.
function directionalForecastStatus(variancePct) {
  if (variancePct == null) return 'model';
  if (variancePct >= -0.05) return 'green';
  if (variancePct >= -0.15) return 'amber';
  return 'red';
}

function confidenceForMonth(key, value) {
  const mo = key.slice(5, 7);
  const spread = mo === '11' || mo === '12' ? 0.15 : mo === '10' ? 0.18 : 0.08;
  return { p25: value * (1 - spread), p50: value, p75: value * (1 + spread) };
}

async function loadForecastBrand(brandKey, asOfInput) {
  const cfg = FORECAST_BRANDS[brandKey];
  if (!cfg) throw new Error(`Unknown forecast brand: ${brandKey}`);
  const maxRes = await pgQuery(`SELECT MAX(date)::text AS max_date FROM ${cfg.summaryTable}`, []);
  const latestDate = maxRes.rows[0]?.max_date ? String(maxRes.rows[0].max_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  const asOf = asOfInput && asOfInput < latestDate ? asOfInput : latestDate;
  const yearStart = '2026-01-01';
  const actualRes = await pgQuery(`
    SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
           COALESCE(order_revenue, total_revenue, 0)::numeric(14,2) AS revenue,
           COALESCE(total_spend, 0)::numeric(14,2) AS spend,
           COALESCE(total_orders, 0)::int AS orders,
           COALESCE(new_customer_orders, 0)::int AS new_customer_orders,
           COALESCE(returning_customer_orders, 0)::int AS returning_customer_orders
    FROM ${cfg.summaryTable}
    WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
    ORDER BY date ASC
  `, [yearStart, asOf]);
  const geoRes = await pgQuery(`
    SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
           region,
           COALESCE(revenue_actual, 0)::numeric(14,2) AS revenue,
           COALESCE(spend_actual, 0)::numeric(14,2) AS spend
    FROM ${cfg.geoTable}
    WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
      AND region != 'TOTAL'
    ORDER BY date ASC
  `, [yearStart, asOf]).catch(() => ({ rows: [] }));
  const actuals = fmtRows(actualRes.rows);
  const actualByDate = Object.fromEntries(actuals.map(r => [r.date, r]));
  const currentMonth = monthKey(asOf);
  const currentMonthStart = `${currentMonth}-01`;
  const currentMonthEnd = monthEndFromKey(currentMonth);
  const currentActualDates = eachDateISO(currentMonthStart, asOf).filter(d => actualByDate[d]);
  const actualWeightSum = currentActualDates.reduce((sum, d) => sum + forecastDayFactors(d).weight, 0) || currentActualDates.length || 1;
  const actualRevenueMTD = currentActualDates.reduce((sum, d) => sum + toNum(actualByDate[d]?.revenue), 0);
  const normalizedDailyBase = actualRevenueMTD / actualWeightSum;
  const trailingActual = actuals.slice(-7);
  const trailingMer = trailingActual.reduce((s, r) => s + toNum(r.revenue), 0) / Math.max(1, trailingActual.reduce((s, r) => s + toNum(r.spend), 0));
  const fallbackMer = Number.isFinite(trailingMer) && trailingMer > 0 ? trailingMer : 3;
  const monthlyRows = FORECAST_MONTHS_2026.map(key => {
    const start = `${key}-01`;
    const end = monthEndFromKey(key);
    const monthDates = eachDateISO(start, end);
    const actualDates = monthDates.filter(d => d <= asOf && actualByDate[d]);
    const futureDates = monthDates.filter(d => d > asOf);
    const actualRevenue = actualDates.reduce((s, d) => s + toNum(actualByDate[d]?.revenue), 0);
    const actualSpend = actualDates.reduce((s, d) => s + toNum(actualByDate[d]?.spend), 0);
    const actualOrders = actualDates.reduce((s, d) => s + toNum(actualByDate[d]?.orders), 0);
    const planRevenue = cfg.plan[key] || null;
    const targetMer = cfg.merTargets[key] || fallbackMer;
    const isPast = key < currentMonth;
    const isCurrent = key === currentMonth;
    let projectedRevenue = actualRevenue;
    let projectedSpend = actualSpend;
    let projectedOrders = actualOrders;
    let reason = 'Completed month uses actuals.';
    if (isCurrent) {
      const remainingRevenue = futureDates.reduce((s, d) => s + normalizedDailyBase * forecastDayFactors(d).weight, 0);
      projectedRevenue = actualRevenue + remainingRevenue;
      projectedSpend = actualSpend + (targetMer > 0 ? remainingRevenue / targetMer : 0);
      const aov = actualOrders > 0 ? actualRevenue / actualOrders : 0;
      projectedOrders = actualOrders + (aov > 0 ? remainingRevenue / aov : 0);
      const upcomingEvents = futureDates.map(d => ({ d, f: forecastDayFactors(d) })).filter(x => x.f.sale_tier !== 'gap' || x.f.drop_type).slice(0, 2);
      reason = upcomingEvents.length
        ? `Actual MTD + weighted remaining days. Upcoming: ${upcomingEvents.map(x => `${x.d} ${x.f.sale_name}${x.f.drop_type ? ` + ${x.f.drop_type}` : ''}`).join('; ')}.`
        : 'Actual MTD + weighted remaining days using day-of-week and seasonality.';
    } else if (!isPast) {
      const modelRevenue = monthDates.reduce((s, d) => s + normalizedDailyBase * forecastDayFactors(d).weight, 0);
      projectedRevenue = planRevenue || modelRevenue;
      projectedSpend = targetMer > 0 ? projectedRevenue / targetMer : 0;
      const currentAov = actualOrders > 0 ? actualRevenue / actualOrders : (actuals.reduce((s, r) => s + toNum(r.revenue), 0) / Math.max(1, actuals.reduce((s, r) => s + toNum(r.orders), 0)));
      projectedOrders = currentAov > 0 ? projectedRevenue / currentAov : 0;
      const monthEvents = monthDates.map(d => forecastDayFactors(d)).filter(f => f.sale_tier !== 'gap' || f.drop_type);
      reason = planRevenue
        ? `Target-backed forecast with calendar guardrails (${monthEvents.length} sale/drop days).`
        : `Model forecast from weighted day-of-week, seasonality, sale, and drop calendar (${monthEvents.length} event days).`;
    }
    const actualMer = actualSpend > 0 ? actualRevenue / actualSpend : null;
    const projectedMer = projectedSpend > 0 ? projectedRevenue / projectedSpend : null;
    const variance = planRevenue ? projectedRevenue - planRevenue : null;
    const variancePct = planRevenue ? variance / planRevenue : null;
    const ci = confidenceForMonth(key, projectedRevenue);
    return {
      month: monthLabel(key),
      month_key: key,
      row_type: isPast ? 'actual' : isCurrent ? 'current_projection' : 'future_projection',
      plan_revenue: planRevenue,
      actual_revenue: actualRevenue || null,
      actual_spend: actualSpend || null,
      actual_orders: Math.round(actualOrders || 0),
      actual_mer: actualMer,
      projected_revenue: projectedRevenue,
      projected_spend: projectedSpend,
      projected_orders: Math.round(projectedOrders || 0),
      projected_mer: projectedMer,
      mer_target: targetMer,
      variance,
      variance_pct: variancePct,
      status: forecastStatus(variancePct),
      p25: ci.p25,
      p50: ci.p50,
      p75: ci.p75,
      reason,
    };
  });
  const current = monthlyRows.find(r => r.month_key === currentMonth) || monthlyRows[0];
  const fullYear = monthlyRows.reduce((acc, r) => {
    acc.plan_revenue += toNum(r.plan_revenue);
    acc.actual_revenue += toNum(r.actual_revenue);
    acc.actual_spend += toNum(r.actual_spend);
    acc.projected_revenue += toNum(r.projected_revenue);
    acc.projected_spend += toNum(r.projected_spend);
    return acc;
  }, { plan_revenue: 0, actual_revenue: 0, actual_spend: 0, projected_revenue: 0, projected_spend: 0 });
  fullYear.actual_mer = fullYear.actual_spend > 0 ? fullYear.actual_revenue / fullYear.actual_spend : null;
  fullYear.projected_mer = fullYear.projected_spend > 0 ? fullYear.projected_revenue / fullYear.projected_spend : null;
  fullYear.variance = fullYear.plan_revenue > 0 ? fullYear.projected_revenue - fullYear.plan_revenue : null;
  fullYear.variance_pct = fullYear.plan_revenue > 0 ? fullYear.variance / fullYear.plan_revenue : null;
  fullYear.status = forecastStatus(fullYear.variance_pct);
  const currentStatus = forecastStatus(current?.variance_pct);
  const narrative = `${cfg.label}: ${current?.month || 'current month'} is ${currentStatus === 'green' ? 'on track' : currentStatus === 'amber' ? 'watching variance' : currentStatus === 'red' ? 'off track' : 'model-only'} at ${current?.variance_pct == null ? 'no plan variance' : `${(current.variance_pct * 100).toFixed(1)}% vs plan`}. Full-year projection is ${fullYear.plan_revenue ? `${(fullYear.variance_pct * 100).toFixed(1)}% vs plan` : 'model-driven because no annual plan is configured'}. Forecast uses day-of-week, sale/drop calendar, seasonality, and MER targets rather than a flat rolling average.`;
  const dailyProjection = eachDateISO(asOf, currentMonthEnd).map(date => {
    const actual = actualByDate[date];
    const factors = forecastDayFactors(date);
    const projectedRevenue = actual ? toNum(actual.revenue) : normalizedDailyBase * factors.weight;
    const merTarget = cfg.merTargets[monthKey(date)] || fallbackMer;
    return {
      date,
      is_actual: Boolean(actual),
      actual_revenue: actual ? toNum(actual.revenue) : null,
      projected_revenue: projectedRevenue,
      projected_spend: actual ? toNum(actual.spend) : (merTarget > 0 ? projectedRevenue / merTarget : null),
      mer_target: merTarget,
      ...factors,
    };
  });
  const regionMap = {};
  for (const r of fmtRows(geoRes.rows || [])) {
    if (!regionMap[r.region]) regionMap[r.region] = { region: r.region, actual_revenue: 0, actual_spend: 0 };
    regionMap[r.region].actual_revenue += toNum(r.revenue);
    regionMap[r.region].actual_spend += toNum(r.spend);
  }
  const regions = Object.values(regionMap).map(r => ({
    ...r,
    actual_mer: r.actual_spend > 0 ? r.actual_revenue / r.actual_spend : null,
    mer_ratio_vs_usa: cfg.regionMerRatios[r.region] || null,
  })).sort((a, b) => b.actual_revenue - a.actual_revenue);
  const redlines = [];
  if (brandKey === 'NOBL' && fullYear.projected_revenue < 404000000) redlines.push({ code: 'RL-9', severity: 'review', message: 'Full-year projection is below P25 ($404M); human review gate required before downstream use.' });
  return {
    brand: brandKey,
    label: cfg.label,
    as_of: asOf,
    latest_actual_date: latestDate,
    current_month: current,
    full_year: fullYear,
    monthly: monthlyRows,
    daily_projection: dailyProjection,
    regions,
    narrative,
    redlines,
    assumptions: {
      day_weights: DAY_WEIGHTS,
      sale_lifts: SALE_LIFTS,
      drop_lifts: DROP_LIFTS,
      mer_targets: cfg.merTargets,
      plan_months: cfg.plan,
      redline_p25_floor: brandKey === 'NOBL' ? 404000000 : null,
    },
  };
}

async function loadNoblAirRevenueForecast(start, end, daily, ttpCohort) {
  const forecastAsOf = end;
  const forecastMonths = Object.entries(NOBL_PLAN_2026)
    .filter(([k]) => k >= '2026-03')
    .map(([k, plan]) => [k, monthLabel(k).split(' ')[0], plan]);
  const firstMonth = forecastMonths[0][0];
  const lastMonth = forecastMonths[forecastMonths.length - 1][0];
  const currentMonth = monthKey(forecastAsOf);
  const currentMonthStart = `${currentMonth}-01`;

  const storeRes = await pgQuery(`
    SELECT
      TO_CHAR(date_trunc('month', date), 'YYYY-MM') AS month_key,
      COALESCE(SUM(total_orders), 0)::int AS orders,
      COALESCE(SUM(COALESCE(shopify_revenue, order_revenue, total_revenue)), 0)::numeric(14,2) AS store_revenue
    FROM nobl_brand_tw_summary_daily
    WHERE date >= ($1::text || '-01')::date
      AND date < (($2::text || '-01')::date + INTERVAL '1 month')
      AND date <= $3::date
    GROUP BY 1
  `, [firstMonth, lastMonth, forecastAsOf]);
  const storeByMonth = Object.fromEntries(storeRes.rows.map(r => [r.month_key, {
    orders: Number(r.orders || 0),
    store_revenue: Number(r.store_revenue || 0),
  }]));

  const airMonthlyRes = await pgQuery(`
    SELECT
      TO_CHAR(date_trunc('month', date), 'YYYY-MM') AS month_key,
      COALESCE(SUM(total_orders), 0)::int AS total_orders,
      COALESCE(SUM(air_orders), 0)::int AS air_orders,
      COALESCE(SUM(mature_count), 0)::int AS mature_count,
      COALESCE(SUM(converted_count), 0)::int AS converted_count,
      COALESCE(SUM(tag_net_sales), 0)::numeric(14,2) AS tag_net_sales,
      COALESCE(SUM(sub_net_sales), 0)::numeric(14,2) AS sub_net_sales,
      COALESCE(SUM(rebill_revenue), 0)::numeric(14,2) AS rebill_revenue,
      COALESCE(SUM(combined_net_revenue), 0)::numeric(14,2) AS combined_net_revenue
    FROM nobl_air_daily
    WHERE date >= ($1::text || '-01')::date
      AND date < (($2::text || '-01')::date + INTERVAL '1 month')
      AND date <= $3::date
    GROUP BY 1
  `, [firstMonth, lastMonth, forecastAsOf]);
  const airByMonth = Object.fromEntries(airMonthlyRes.rows.map(r => {
    const totalOrders = Number(r.total_orders || 0);
    const airOrders = Number(r.air_orders || 0);
    const matureCount = Number(r.mature_count || 0);
    const convertedCount = Number(r.converted_count || 0);
    const attach = totalOrders > 0 ? airOrders / totalOrders : 0;
    const ttp = matureCount > 0 ? convertedCount / matureCount : 0;
    return [r.month_key, {
      total_orders: totalOrders,
      air_orders: airOrders,
      mature_count: matureCount,
      converted_count: convertedCount,
      activation_rate: attach * ttp,
      tag_net_sales: Number(r.tag_net_sales || 0),
      sub_net_sales: Number(r.sub_net_sales || 0),
      rebill_revenue: Number(r.rebill_revenue || 0),
      combined_net_revenue: Number(r.combined_net_revenue || 0),
    }];
  }));

  // Month-end TTP from pre-aggregated nobl_air_daily (avoids 10× full subscriber scans).
  const monthKeys = forecastMonths.map(([key]) => key);
  const ttpMonthRes = await pgQuery(`
    SELECT DISTINCT ON (month_key)
      TO_CHAR(date_trunc('month', date), 'YYYY-MM') AS month_key,
      ttp_rate,
      mature_count,
      converted_count
    FROM nobl_air_daily
    WHERE date <= $1::date
      AND TO_CHAR(date_trunc('month', date), 'YYYY-MM') = ANY($2::text[])
    ORDER BY month_key, date DESC
  `, [forecastAsOf, monthKeys]);
  const ttpAsOfByMonth = Object.fromEntries(ttpMonthRes.rows.map((row) => [
    row.month_key,
    {
      ttp_rate: row.ttp_rate != null ? Number(row.ttp_rate) : null,
      mature: Number(row.mature_count || 0),
      converted: Number(row.converted_count || 0),
    },
  ]));
  // Current month may need live cohort if daily row not written yet.
  if (!ttpAsOfByMonth[currentMonth]) {
    ttpAsOfByMonth[currentMonth] = await loadNoblAirTtpAsOfEnd(forecastAsOf, null);
  }

  const selectedStoreRes = await pgQuery(`
    SELECT
      COALESCE(SUM(total_orders), 0)::int AS orders,
      COALESCE(SUM(COALESCE(shopify_revenue, order_revenue, total_revenue)), 0)::numeric(14,2) AS store_revenue
    FROM nobl_brand_tw_summary_daily
    WHERE date BETWEEN $1::date AND $2::date
  `, [currentMonthStart, forecastAsOf]);
  const selectedStore = selectedStoreRes.rows[0] || {};
  const selectedOrders = Number(selectedStore.orders || 0);
  const selectedRevenue = Number(selectedStore.store_revenue || 0);

  const currentAir = airByMonth[currentMonth] || {};
  const rangeTotals = {
    total_orders: Number(currentAir.total_orders || 0),
    air_orders: Number(currentAir.air_orders || 0),
    converted_count: Number(currentAir.converted_count || 0),
    mature_count: Number(currentAir.mature_count || 0),
    tag_net_sales: Number(currentAir.tag_net_sales || 0),
    sub_net_sales: Number(currentAir.sub_net_sales || 0),
    combined_net_revenue: Number(currentAir.combined_net_revenue || 0),
  };
  const selectedEligibleOrders = rangeTotals.total_orders;

  const trailingRes = await pgQuery(`
    SELECT total_orders, air_orders, converted_count, mature_count, activation_rate
    FROM nobl_air_daily
    WHERE date BETWEEN ($1::date - INTERVAL '6 days')::date AND $1::date
    ORDER BY date ASC
  `, [forecastAsOf]);
  const trailing = trailingRes.rows || [];
  const trailingTotals = trailing.reduce((acc, row) => {
    acc.total_orders += Number(row.total_orders || 0);
    acc.air_orders += Number(row.air_orders || 0);
    acc.converted_count += Number(row.converted_count || 0);
    acc.mature_count += Number(row.mature_count || 0);
    if (row.activation_rate != null && Number(row.total_orders || 0) > 0) {
      acc.activation_weighted_sum += Number(row.activation_rate) * Number(row.total_orders);
      acc.activation_weight += Number(row.total_orders);
    }
    return acc;
  }, { total_orders: 0, air_orders: 0, converted_count: 0, mature_count: 0, activation_weighted_sum: 0, activation_weight: 0 });

  const tierRes = await pgQuery(`
    WITH subscribers AS (
      SELECT
        contract_amount,
        created_at,
        COALESCE(
          last_billing_date,
          (CASE
            WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'object'
              THEN (raw_json->'lastSuccessfulOrder'->>'orderDate')::timestamptz
            WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'string'
              THEN ((raw_json->>'lastSuccessfulOrder')::jsonb->>'orderDate')::timestamptz
            ELSE NULL
          END)
        ) AS paid_billing_date
      FROM nobl_air_subscribers
      WHERE contract_amount IS NOT NULL AND contract_amount > 0
    )
    SELECT ROUND(AVG(contract_amount)::numeric, 2) AS avg_tier_price
    FROM subscribers
    WHERE paid_billing_date > created_at
  `, []);
  const avgTierPrice = Number(tierRes.rows[0]?.avg_tier_price || 0);

  const attachRate = rangeTotals.total_orders > 0 ? rangeTotals.air_orders / rangeTotals.total_orders : 0;
  const overallTtpRate = Number(ttpCohort?.ttp_rate || 0);
  const periodActivationRate = attachRate * overallTtpRate;
  // Sheet-style forecast activation: trailing converted daily cohorts / trailing air orders.
  // Actual columns still use Performance activation = attach × TTP.
  const forecastActivationRate = trailingTotals.air_orders > 0
    ? trailingTotals.converted_count / trailingTotals.air_orders
    : periodActivationRate;
  const eligibleOrderRate = selectedOrders > 0 ? selectedEligibleOrders / selectedOrders : 0;
  // Reference only: weighted average of the actual daily Performance activation_rate over the latest 7 complete days.
  const rolling7PerformanceActivationRate = trailingTotals.activation_weight > 0
    ? trailingTotals.activation_weighted_sum / trailingTotals.activation_weight
    : periodActivationRate;
  const avgRevenuePerOrder = selectedEligibleOrders > 0
    ? selectedRevenue / selectedEligibleOrders
    : (selectedOrders > 0 ? selectedRevenue / selectedOrders : 0);
  const tagNetPerAirOrder = rangeTotals.air_orders > 0 ? rangeTotals.tag_net_sales / rangeTotals.air_orders : 0;
  const subNetPerActivation = rangeTotals.converted_count > 0 ? rangeTotals.sub_net_sales / rangeTotals.converted_count : 0;
  const blendedNetRevPerAirOrder = rangeTotals.air_orders > 0 ? rangeTotals.combined_net_revenue / rangeTotals.air_orders : 0;
  const rows = forecastMonths.map(([key, label, targetRevenue]) => {
    const actual = storeByMonth[key] || { orders: 0, store_revenue: 0 };
    const actualAir = airByMonth[key] || null;
    const actualStoreRevenue = actual.store_revenue;
    const actualOrders = actual.orders;
    const actualEligibleOrders = actualAir?.total_orders || 0;
    const actualEligibleRevenue = actualOrders > 0 ? actualStoreRevenue * (actualEligibleOrders / actualOrders) : 0;
    const actualRebillOrders = Math.max(0, actualOrders - actualEligibleOrders);
    const actualRebillRevenue = Math.max(0, actualStoreRevenue - actualEligibleRevenue);
    let storeRevenue = actualStoreRevenue;
    let orders = actualEligibleOrders;
    let eligibleOrders = actualEligibleOrders;
    let eligibleRevenue = actualEligibleRevenue;
    let rowType = actualOrders > 0 ? 'actual' : 'no_data';
    let statusLabel = actualOrders > 0 ? 'Actual' : 'No Data';
    let orderSource = actualOrders > 0 ? `Actual (${actualEligibleOrders.toLocaleString()} eligible orders; ${actualOrders.toLocaleString()} incl. rebills)` : 'No actual data yet';
    let elapsedDays = null;
    let days = null;
    let projectionFactor = 1;

    if (key === currentMonth && actualOrders > 0) {
      elapsedDays = Math.max(1, Math.min(Number(String(forecastAsOf).slice(8, 10)) || 1, daysInMonthFromKey(key)));
      days = daysInMonthFromKey(key);
      projectionFactor = days / elapsedDays;
      storeRevenue = actualStoreRevenue * projectionFactor;
      orders = actualEligibleOrders * projectionFactor;
      eligibleOrders = actualEligibleOrders * projectionFactor;
      eligibleRevenue = actualEligibleRevenue * projectionFactor;
      rowType = 'current_projection';
      statusLabel = 'MTD + Projection';
      orderSource = `MTD eligible orders (${actualEligibleOrders.toLocaleString()}) × ${days}/${elapsedDays} days`;
    } else if (targetRevenue) {
      storeRevenue = targetRevenue;
      orders = avgRevenuePerOrder > 0 ? targetRevenue / avgRevenuePerOrder : 0;
      eligibleOrders = orders;
      eligibleRevenue = targetRevenue;
      rowType = 'target';
      statusLabel = 'Target';
      orderSource = `Estimated (target $${(targetRevenue / 1000000).toFixed(1)}M ÷ $${Math.round(avgRevenuePerOrder).toLocaleString()}/order)`;
    }

    const rowAttachRate = attachRate;
    const rowTtpRate = overallTtpRate;
    const rowActivationRate = forecastActivationRate;
    const actualTtpRate = actualOrders > 0 ? Number(ttpAsOfByMonth[key]?.ttp_rate || overallTtpRate || 0) : null;
    const actualAttachRate = actualAir?.total_orders > 0 ? actualAir.air_orders / actualAir.total_orders : null;
    const actualActivationRate = actualAttachRate != null && actualTtpRate != null ? actualAttachRate * actualTtpRate : null;
    const estActivations = eligibleOrders * rowActivationRate;
    const estAirOrders = eligibleOrders * rowAttachRate;
    const tagRevNetEst = estAirOrders * tagNetPerAirOrder;
    const subRevNetEst = estActivations * avgTierPrice;
    const totalAirRevNetEst = tagRevNetEst + subRevNetEst;
    const rowAov = orders > 0 ? storeRevenue / orders : 0;

    return {
      month: label,
      month_key: key,
      row_type: rowType,
      status_label: statusLabel,
      actual_store_revenue: actualOrders > 0 ? Number(actualStoreRevenue.toFixed(2)) : null,
      actual_orders: actualOrders > 0 ? Math.round(actualOrders) : null,
      actual_eligible_orders: actualOrders > 0 ? Math.round(actualEligibleOrders) : null,
      actual_eligible_revenue: actualOrders > 0 ? Number(actualEligibleRevenue.toFixed(2)) : null,
      actual_rebill_revenue: actualOrders > 0 ? Number(actualRebillRevenue.toFixed(2)) : null,
      actual_rebill_orders: actualOrders > 0 ? Math.round(actualRebillOrders) : null,
      actual_air_orders: actualOrders > 0 ? Math.round(actualAir?.air_orders || 0) : null,
      actual_attach_rate: actualAttachRate != null ? Number(actualAttachRate.toFixed(4)) : null,
      actual_ttp_rate: actualTtpRate != null ? Number(actualTtpRate.toFixed(4)) : null,
      actual_activation_rate: actualActivationRate != null ? Number(actualActivationRate.toFixed(4)) : null,
      actual_tag_rev_net: actualOrders > 0 ? Number((actualAir?.tag_net_sales || 0).toFixed(2)) : null,
      actual_sub_rev_net: actualOrders > 0 ? Number((actualAir?.sub_net_sales || 0).toFixed(2)) : null,
      actual_rebill_rev_net: actualOrders > 0 ? Number((actualAir?.rebill_revenue || 0).toFixed(2)) : null,
      actual_air_rev_net: actualOrders > 0 ? Number((actualAir?.combined_net_revenue || 0).toFixed(2)) : null,
      target_store_revenue: targetRevenue || null,
      projection_factor: Number(projectionFactor.toFixed(4)),
      elapsed_days: elapsedDays,
      days_in_month: days,
      store_revenue: Number(storeRevenue.toFixed(2)),
      orders: Math.round(orders),
      eligible_orders: Math.round(eligibleOrders),
      eligible_revenue: Number(eligibleRevenue.toFixed(2)),
      aov: Number(rowAov.toFixed(2)),
      ttp_rate: Number(rowTtpRate.toFixed(4)),
      activation_rate: Number(rowActivationRate.toFixed(4)),
      est_activations: Math.round(estActivations),
      attach_rate: Number(rowAttachRate.toFixed(4)),
      est_air_orders: Math.round(estAirOrders),
      tag_rev_net_est: Number(tagRevNetEst.toFixed(2)),
      sub_rev_net_est: Number(subRevNetEst.toFixed(2)),
      total_air_rev_net_est: Number(totalAirRevNetEst.toFixed(2)),
      order_source: orderSource,
    };
  });

  const fullYear = rows.reduce((acc, row) => {
    acc.actual_store_revenue += Number(row.actual_store_revenue || 0);
    acc.actual_orders += Number(row.actual_orders || 0);
    acc.actual_eligible_orders += Number(row.actual_eligible_orders || 0);
    acc.actual_eligible_revenue += Number(row.actual_eligible_revenue || 0);
    acc.actual_rebill_orders += Number(row.actual_rebill_orders || 0);
    acc.actual_rebill_revenue += Number(row.actual_rebill_revenue || 0);
    acc.actual_air_orders += Number(row.actual_air_orders || 0);
    acc.actual_tag_rev_net += Number(row.actual_tag_rev_net || 0);
    acc.actual_sub_rev_net += Number(row.actual_sub_rev_net || 0);
    acc.actual_rebill_rev_net += Number(row.actual_rebill_rev_net || 0);
    acc.actual_air_rev_net += Number(row.actual_air_rev_net || 0);
    acc.store_revenue += row.store_revenue || 0;
    acc.orders += row.orders || 0;
    acc.eligible_orders += row.eligible_orders || 0;
    acc.eligible_revenue += row.eligible_revenue || 0;
    acc.est_activations += row.est_activations || 0;
    acc.est_air_orders += row.est_air_orders || 0;
    acc.tag_rev_net_est += row.tag_rev_net_est || 0;
    acc.sub_rev_net_est += row.sub_rev_net_est || 0;
    acc.total_air_rev_net_est += row.total_air_rev_net_est || 0;
    return acc;
  }, { actual_store_revenue: 0, actual_orders: 0, actual_eligible_orders: 0, actual_eligible_revenue: 0, actual_rebill_orders: 0, actual_rebill_revenue: 0, actual_air_orders: 0, actual_tag_rev_net: 0, actual_sub_rev_net: 0, actual_rebill_rev_net: 0, actual_air_rev_net: 0, store_revenue: 0, orders: 0, eligible_orders: 0, eligible_revenue: 0, est_activations: 0, est_air_orders: 0, tag_rev_net_est: 0, sub_rev_net_est: 0, total_air_rev_net_est: 0 });
  const fullYearActualAttachRate = fullYear.actual_eligible_orders > 0 ? fullYear.actual_air_orders / fullYear.actual_eligible_orders : null;
  const fullYearActualActivationRate = fullYearActualAttachRate != null ? fullYearActualAttachRate * overallTtpRate : null;
  const fullYearTotal = {
    month: 'FULL YEAR TOTAL',
    row_type: 'total',
    status_label: 'Full Year Total',
    actual_store_revenue: Number(fullYear.actual_store_revenue.toFixed(2)),
    actual_orders: Math.round(fullYear.actual_orders),
    actual_eligible_orders: Math.round(fullYear.actual_eligible_orders),
    actual_eligible_revenue: Number(fullYear.actual_eligible_revenue.toFixed(2)),
    actual_rebill_orders: Math.round(fullYear.actual_rebill_orders),
    actual_rebill_revenue: Number(fullYear.actual_rebill_revenue.toFixed(2)),
    actual_air_orders: Math.round(fullYear.actual_air_orders),
    actual_attach_rate: fullYearActualAttachRate != null ? Number(fullYearActualAttachRate.toFixed(4)) : null,
    actual_ttp_rate: Number(overallTtpRate.toFixed(4)),
    actual_activation_rate: fullYearActualActivationRate != null ? Number(fullYearActualActivationRate.toFixed(4)) : null,
    actual_tag_rev_net: Number(fullYear.actual_tag_rev_net.toFixed(2)),
    actual_sub_rev_net: Number(fullYear.actual_sub_rev_net.toFixed(2)),
    actual_rebill_rev_net: Number(fullYear.actual_rebill_rev_net.toFixed(2)),
    actual_air_rev_net: Number(fullYear.actual_air_rev_net.toFixed(2)),
    target_store_revenue: null,
    projection_factor: Number(1),
    elapsed_days: null,
    days_in_month: null,
    store_revenue: Number(fullYear.store_revenue.toFixed(2)),
    orders: Math.round(fullYear.orders),
    eligible_orders: Math.round(fullYear.eligible_orders),
    eligible_revenue: Number(fullYear.eligible_revenue.toFixed(2)),
    aov: fullYear.orders > 0 ? Number((fullYear.store_revenue / fullYear.orders).toFixed(2)) : 0,
    ttp_rate: Number(overallTtpRate.toFixed(4)),
    activation_rate: Number(forecastActivationRate.toFixed(4)),
    est_activations: Math.round(fullYear.est_activations),
    attach_rate: Number(attachRate.toFixed(4)),
    est_air_orders: Math.round(fullYear.est_air_orders),
    tag_rev_net_est: Number(fullYear.tag_rev_net_est.toFixed(2)),
    sub_rev_net_est: Number(fullYear.sub_rev_net_est.toFixed(2)),
    total_air_rev_net_est: Number(fullYear.total_air_rev_net_est.toFixed(2)),
    order_source: `Actuals through ${forecastAsOf}; forecast columns include projected/target full year`,
  };

  return {
    title: 'NOBL Air Revenue Forecast 2026',
    assumptions: {
      forecast_activation_rate: Number(forecastActivationRate.toFixed(4)),
      rolling_7d_activation_rate: Number(forecastActivationRate.toFixed(4)),
      rolling_7d_performance_activation_rate: Number(rolling7PerformanceActivationRate.toFixed(4)),
      period_activation_rate: Number(periodActivationRate.toFixed(4)),
      overall_attach_rate: Number(attachRate.toFixed(4)),
      overall_ttp_rate: Number(overallTtpRate.toFixed(4)),
      eligible_order_rate: Number(eligibleOrderRate.toFixed(4)),
      avg_revenue_per_store_order: Number(avgRevenuePerOrder.toFixed(2)),
      avg_tier_price_converted_subs: Number(avgTierPrice.toFixed(2)),
      tag_net_sales_per_air_order: Number(tagNetPerAirOrder.toFixed(2)),
      sub_net_sales_per_activation: Number(subNetPerActivation.toFixed(2)),
      blended_net_rev_per_air_order: Number(blendedNetRevPerAirOrder.toFixed(2)),
    },
    rows,
    full_year: fullYearTotal,
  };
}

async function loadNoblStoreActualDailyMap(start, end) {
  const res = await pgQuery(`
    SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
           COALESCE(order_revenue, shopify_revenue, total_revenue, 0)::numeric(14,2) AS revenue,
           COALESCE(total_spend, 0)::numeric(14,2) AS spend,
           COALESCE(total_orders, 0)::int AS orders
    FROM nobl_brand_tw_summary_daily
    WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
    ORDER BY date ASC
  `, [start, end]);
  return Object.fromEntries(fmtRows(res.rows).map(r => [r.date, {
    date: r.date,
    revenue: toNum(r.revenue),
    spend: toNum(r.spend),
    orders: Math.round(toNum(r.orders)),
  }]));
}

/** Plan calendar from forecast_plan_daily (imported plan — not computed forecast). */
async function loadForecastPlanMap() {
  const res = await pgQuery(`
    SELECT brand, date::text AS date, plan_revenue, plan_spend, plan_meta_spend, plan_mer,
           plan_usa, plan_canada, plan_australia, plan_uk, plan_eu, promo, drop_lift, source,
           updated_at::text AS updated_at
    FROM forecast_plan_daily
    ORDER BY brand, date ASC
  `, []).catch(() => ({ rows: [] }));
  const byBrand = { NOBL: {}, FLO: {} };
  for (const r of fmtRows(res.rows)) {
    if (!byBrand[r.brand]) byBrand[r.brand] = {};
    byBrand[r.brand][r.date] = r;
  }
  const metaRes = await pgQuery(`
    SELECT brand, COUNT(*)::int AS row_count,
           MIN(date)::text AS min_date,
           MAX(date)::text AS max_date,
           MAX(updated_at)::text AS updated_at
    FROM forecast_plan_daily
    GROUP BY brand
    ORDER BY brand
  `, []).catch(() => ({ rows: [] }));
  const brandMeta = fmtRows(metaRes.rows);
  const totalRows = brandMeta.reduce((s, m) => s + (m.row_count || 0), 0);
  return {
    byDate: byBrand.NOBL,
    byBrand,
    meta: totalRows > 0 ? {
      row_count: totalRows,
      brands: brandMeta,
      min_date: brandMeta.reduce((m, b) => (!m || b.min_date < m ? b.min_date : m), null),
      max_date: brandMeta.reduce((m, b) => (!m || b.max_date > m ? b.max_date : m), null),
      updated_at: brandMeta.reduce((m, b) => (!m || b.updated_at > m ? b.updated_at : m), null),
      source: 'forecast_plan_daily',
    } : null,
  };
}

/** @deprecated alias */
async function loadForecastDailyMap() {
  return loadForecastPlanMap();
}

function sheetTargetToStatus(targetStatus, variancePct) {
  const t = String(targetStatus || '').toLowerCase();
  if (t === 'target met') return 'green';
  if (t === 'below target') return 'red';
  if (t === 'future') return 'model';
  return directionalForecastStatus(variancePct);
}

function buildNoblStoreDailyForecast(storeForecast, actualByDate, brandKey = 'NOBL', planByDate = {}) {
  const asOf = storeForecast.as_of;
  if (brandKey === 'NOBL') {
    const computed = computeNoblStoreDailyForecast(actualByDate, asOf, planByDate);
    return computed.daily;
  }

  const currentMonth = monthKey(asOf);
  const monthlyByKey = Object.fromEntries((storeForecast.monthly || []).map(r => [r.month_key, r]));
  const brandMerTargets = (FORECAST_BRANDS[brandKey] || {}).merTargets || {};
  const rows = [];

  FORECAST_MONTHS_2026.forEach(key => {
    const month = monthlyByKey[key] || {};
    const dates = eachDateISO(`${key}-01`, monthEndFromKey(key));
    const futureDates = dates.filter(d => d > asOf);
    const futureWeight = futureDates.reduce((s, d) => s + forecastDayFactors(d).weight, 0) || futureDates.length || 1;
    const actualRevenue = dates.filter(d => d <= asOf).reduce((s, d) => s + toNum(actualByDate[d]?.revenue), 0);
    const projectedMonthRevenue = toNum(month.projected_revenue || month.plan_revenue || actualRevenue);
    const remainingRevenue = key === currentMonth
      ? Math.max(0, projectedMonthRevenue - actualRevenue)
      : (key > currentMonth ? projectedMonthRevenue : 0);
    const targetMer = toNum(month.mer_target || brandMerTargets[key] || 3);
    const monthWeightSum = dates.reduce((s, d) => s + forecastDayFactors(d).weight, 0) || dates.length;
    const planMonthRev = toNum(month.plan_revenue || month.projected_revenue || projectedMonthRevenue);

    dates.forEach(date => {
      const actual = date <= asOf ? actualByDate[date] : null;
      const factors = forecastDayFactors(date);
      const isFuture = date > asOf;
      const planRow = planByDate[date];
      const dayPlan = planRow ? toNum(planRow.plan_revenue) : (planMonthRev > 0 ? planMonthRev * (factors.weight / monthWeightSum) : 0);
      const allocatedRevenue = isFuture ? remainingRevenue * (factors.weight / futureWeight) : 0;
      const forecastRevenue = isFuture ? allocatedRevenue : dayPlan;
      // Plan-derived spend on every day (forecast revenue ÷ target MER), so the
      // spend/MER variance is meaningful instead of echoing the actual back at itself.
      const projectedSpend = targetMer > 0 ? forecastRevenue / targetMer : (actual ? toNum(actual.spend) : 0);
      rows.push({
        date,
        month: monthLabel(key),
        month_key: key,
        row_type: actual ? 'Actual' : (date <= asOf ? 'Missing Actual' : 'Projected'),
        actual_revenue: actual ? toNum(actual.revenue) : null,
        actual_spend: actual ? toNum(actual.spend) : null,
        actual_orders: actual ? Math.round(toNum(actual.orders)) : null,
        actual_mer: actual && toNum(actual.spend) > 0 ? toNum(actual.revenue) / toNum(actual.spend) : null,
        plan_revenue: dayPlan,
        projected_revenue: forecastRevenue,
        forecast_revenue: forecastRevenue,
        forecast_spend: projectedSpend,
        forecast_mer: projectedSpend > 0 ? forecastRevenue / projectedSpend : null,
        plan_revenue_month: month.plan_revenue || null,
        projected_revenue_month: month.projected_revenue || null,
        mer_target: targetMer,
        day_weight: factors.day_weight,
        seasonality: factors.seasonality,
        sale_name: factors.sale_name,
        sale_tier: factors.sale_tier,
        drop_type: factors.drop_type,
        weight: factors.weight,
        target_status: null,
        forecast_source: 'engine',
        reason: actual
          ? 'Database actual from Triple Whale daily summary.'
          : (date <= asOf ? 'Completed day is missing from the database; refresh/backfill ETL.' : 'Model forecast allocated from monthly plan.'),
      });
    });
  });

  return rows;
}

async function loadNoblAirActualDailyMap(start, end) {
  const res = await pgQuery(`
    SELECT date::text AS date,
           total_orders, air_orders, attach_rate, ttp_rate, activation_rate,
           tag_net_sales, sub_net_sales, rebill_revenue, combined_net_revenue,
           mature_count, converted_count
    FROM nobl_air_daily
    WHERE date BETWEEN $1::date AND $2::date
    ORDER BY date ASC
  `, [start, end]);
  return Object.fromEntries(fmtRows(res.rows).map(r => [r.date, r]));
}

function buildNoblAirDailyForecast(storeDailyRows, airActualByDate, airForecast) {
  const assumptions = buildAirAssumptions(airActualByDate, {
    AOV_ELIGIBLE: toNum(airForecast?.assumptions?.avg_revenue_per_store_order) || undefined,
    ATTACH_RATE: toNum(airForecast?.assumptions?.overall_attach_rate) || undefined,
    ACTIVATION_RATE: toNum(airForecast?.assumptions?.forecast_activation_rate) || undefined,
    TAG_REV_PER_AIR: toNum(airForecast?.assumptions?.tag_net_sales_per_air_order) || undefined,
    SUB_REV_PER_ACTIVATION: toNum(airForecast?.assumptions?.avg_tier_price_converted_subs) || undefined,
  });
  return buildAirDailyFromEngine(storeDailyRows, airActualByDate, assumptions);
}

// GET /dashboard-forecast — DB-backed replacement for sheet forecast tabs.
router.get('/dashboard-forecast', async (req, res) => {
  try {
    const requestedAsOf = req.query.asOf ? String(req.query.asOf).slice(0, 10) : null;
    const [dataVersion, auxVersion] = await Promise.all([
      getDataVersion(),
      pgQuery(`
        SELECT CONCAT_WS('|',
          (SELECT COALESCE(MAX(updated_at)::text, 'none') FROM ops_metrics_daily),
          (SELECT COALESCE(MAX(updated_at)::text, 'none') FROM cs_tickets_daily),
          (SELECT COALESCE(MAX(updated_at)::text, 'none') FROM meta_ads_daily),
          (SELECT COALESCE(MAX(created_at)::text, 'none') FROM klaviyo_daily)
        ) AS version
      `).catch(() => ({ rows: [{ version: 'none' }] })),
    ]);
    const version = `${dataVersion}:${auxVersion.rows[0]?.version || 'none'}`;
    const { body } = await withResponseCache('forecast', `df:${requestedAsOf || 'latest'}`, version, async () => {
    const { byDate: planByDate, meta: forecastMeta } = await loadForecastPlanMap();
    const nobl = await loadForecastBrand('NOBL', requestedAsOf);
    const airAsOf = await capNoblAirEndDate(nobl.as_of);
    const ttpCohort = await loadNoblAirTtpAsOfEnd(airAsOf, null);
    const air = await loadNoblAirRevenueForecast('2026-03-01', airAsOf, [], ttpCohort);
    const storeActuals = await loadNoblStoreActualDailyMap('2026-01-01', '2026-12-31');
    const storeDaily = buildNoblStoreDailyForecast(nobl, storeActuals, 'NOBL', planByDate);
    const airActuals = await loadNoblAirActualDailyMap('2026-03-01', '2026-12-31');
    const airDaily = buildNoblAirDailyForecast(storeDaily.filter(r => r.date >= '2026-03-01'), airActuals, air);

    return {
      as_of: nobl.as_of,
      air_as_of: airAsOf,
      forecast_meta: forecastMeta,
      data_source: 'Computed NOBL store + Air forecast engine. Plan calendar from forecast_plan_daily; actuals from nobl_brand_tw_summary_daily + nobl_air_daily.',
      nobl: {
        monthly: nobl.monthly,
        daily: storeDaily,
        full_year: nobl.full_year,
        narrative: nobl.narrative,
        redlines: nobl.redlines,
        assumptions: nobl.assumptions,
      },
      air: {
        monthly: air.rows,
        daily: airDaily,
        full_year: air.full_year,
        assumptions: air.assumptions,
      },
      methodology: {
        purpose: 'One dashboard page for the four forecast tabs: NOBL monthly, NOBL daily, NOBL Air monthly, and NOBL Air daily.',
        checks: [
          'actuals come from database tables first',
          'daily store + air projected values are computed by the forecast engine (not imported sheet output)',
          forecastMeta ? 'plan calendar loaded from forecast_plan_daily' : 'plan calendar uses weighted monthly distribution until plan import runs',
          'red/green compares actual vs computed daily plan/forecast target',
        ],
        database_tables: ['nobl_brand_tw_summary_daily', 'nobl_air_daily', 'forecast_plan_daily'],
      },
    };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /dashboard-forecast]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Generic per-brand actual daily map keyed on the brand's summary table.
async function loadBrandActualDailyMap(brandKey, start, end) {
  const cfg = FORECAST_BRANDS[brandKey];
  if (!cfg) return {};
  const res = await pgQuery(`
    SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
           COALESCE(order_revenue, total_revenue, 0)::numeric(14,2) AS revenue,
           COALESCE(total_spend, 0)::numeric(14,2) AS spend,
           COALESCE(total_orders, 0)::int AS orders
    FROM ${cfg.summaryTable}
    WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
    ORDER BY date ASC
  `, [start, end]).catch(() => ({ rows: [] }));
  return Object.fromEntries(fmtRows(res.rows).map(r => [r.date, {
    date: r.date,
    revenue: toNum(r.revenue),
    spend: toNum(r.spend),
    orders: Math.round(toNum(r.orders)),
  }]));
}

// GET /forecast-daily — per-brand daily forecast vs actual for a date range.
// Powers the Forecast vs Actuals daily view and the red/green daily indicators
// surfaced across the daily pages.
router.get('/forecast-daily', async (req, res) => {
  try {
    const requested = String(req.query.brand || 'ALL').toUpperCase();
    const brandKeys = requested === 'ALL'
      ? Object.keys(FORECAST_BRANDS)
      : requested.split(',').map(s => s.trim()).filter(k => FORECAST_BRANDS[k]);
    const start = req.query.start ? String(req.query.start).slice(0, 10) : '2026-01-01';
    const end = req.query.end ? String(req.query.end).slice(0, 10) : '2026-12-31';
    const requestedAsOf = req.query.asOf ? String(req.query.asOf).slice(0, 10) : null;
    const version = await getDataVersion();
    const cacheKey = `fd:${requested}:${start}:${end}:${requestedAsOf || 'latest'}`;
    const { body } = await withResponseCache('forecast', cacheKey, version, async () => {
      const { byDate: planByDate, byBrand, meta: forecastMeta } = await loadForecastPlanMap();
      const airActualsByDate = (brandKeys.includes('NOBL') || requested === 'ALL')
        ? await loadNoblAirActualDailyMap('2026-01-01', '2026-12-31')
        : {};
      const brands = [];
      for (const brandKey of brandKeys) {
        const brand = await loadForecastBrand(brandKey, requestedAsOf);
        const actuals = await loadBrandActualDailyMap(brandKey, '2026-01-01', '2026-12-31');
        const planForBrand = byBrand[brandKey] || (brandKey === 'NOBL' ? planByDate : {});
        const allRows = buildNoblStoreDailyForecast(brand, actuals, brandKey, planForBrand);
        const airByDate = brandKey === 'NOBL'
          ? Object.fromEntries(
            buildNoblAirDailyForecast(allRows, airActualsByDate, {}).map(r => [r.date, r])
          )
          : {};
        const rows = allRows
          .filter(r => r.date >= start && r.date <= end)
          .map(r => {
            const actualRev = r.actual_revenue;
            const forecastRev = toNum(r.forecast_revenue);
            const planRev = toNum(r.plan_revenue);
            const variance = actualRev != null && forecastRev > 0 ? (actualRev - forecastRev) / forecastRev : null;
            const airActual = brandKey === 'NOBL' ? airActualsByDate[r.date] : null;
            const airRow = airByDate[r.date];
            return {
              date: r.date,
              row_type: r.row_type,
              plan_revenue: planRev,
              forecast_revenue: forecastRev,
              projected_revenue: toNum(r.projected_revenue),
              forecast_air_revenue: airRow ? toNum(airRow.forecast_air_revenue) : null,
              actual_air_revenue: airActual ? toNum(airActual.combined_net_revenue) : null,
              forecast_spend: toNum(r.forecast_spend),
              forecast_mer: r.forecast_mer,
              actual_revenue: actualRev,
              actual_spend: r.actual_spend,
              actual_mer: r.actual_mer,
              mer_target: r.mer_target,
              variance_pct: variance,
              status: directionalForecastStatus(variance),
              target_status: r.target_status || null,
              forecast_source: r.forecast_source || 'engine',
              reason: r.reason || null,
              sale_name: r.sale_name,
              drop_type: r.drop_type,
            };
          });
        brands.push({ brand: brandKey, label: brand.label, as_of: brand.as_of, daily: rows });
      }
      // Combined "ALL" daily series summed across brands by date.
      const combinedByDate = {};
      for (const b of brands) {
        for (const r of b.daily) {
          const c = combinedByDate[r.date] || {
            date: r.date, forecast_revenue: 0, forecast_spend: 0,
            actual_revenue: 0, actual_spend: 0, _hasActual: false,
            nobl_forecast: 0, nobl_actual: 0, flo_forecast: 0, flo_actual: 0,
            _noblHasActual: false, _floHasActual: false,
          };
          c.forecast_revenue += toNum(r.forecast_revenue);
          c.forecast_spend += toNum(r.forecast_spend);
          if (r.actual_revenue != null) { c.actual_revenue += toNum(r.actual_revenue); c._hasActual = true; }
          if (r.actual_spend != null) c.actual_spend += toNum(r.actual_spend);
          if (b.brand === 'NOBL') {
            c.nobl_forecast += toNum(r.forecast_revenue);
            if (r.actual_revenue != null) { c.nobl_actual += toNum(r.actual_revenue); c._noblHasActual = true; }
            c.nobl_forecast_air = r.forecast_air_revenue;
            c.nobl_actual_air = r.actual_air_revenue;
          }
          if (b.brand === 'FLO') {
            c.flo_forecast += toNum(r.forecast_revenue);
            if (r.actual_revenue != null) { c.flo_actual += toNum(r.actual_revenue); c._floHasActual = true; }
          }
          combinedByDate[r.date] = c;
        }
      }
      const combined = Object.values(combinedByDate)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(c => {
          const actualRev = c._hasActual ? c.actual_revenue : null;
          const variance = actualRev != null && c.forecast_revenue > 0 ? (actualRev - c.forecast_revenue) / c.forecast_revenue : null;
          return {
            date: c.date,
            forecast_revenue: c.forecast_revenue,
            forecast_spend: c.forecast_spend,
            forecast_mer: c.forecast_spend > 0 ? c.forecast_revenue / c.forecast_spend : null,
            actual_revenue: actualRev,
            actual_spend: c._hasActual ? c.actual_spend : null,
            actual_mer: c._hasActual && c.actual_spend > 0 ? c.actual_revenue / c.actual_spend : null,
            variance_pct: variance,
            status: sheetTargetToStatus(null, variance),
            nobl_forecast: c.nobl_forecast,
            nobl_actual: c._noblHasActual ? c.nobl_actual : null,
            flo_forecast: c.flo_forecast,
            flo_actual: c._floHasActual ? c.flo_actual : null,
            nobl_forecast_air: c.nobl_forecast_air ?? null,
            nobl_actual_air: c.nobl_actual_air ?? null,
          };
        });
      const asOf = brands.reduce((m, b) => (b.as_of > m ? b.as_of : m), brands[0]?.as_of || end);
      return { as_of: asOf, start, end, brands, combined, forecast_meta: forecastMeta };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /forecast-daily]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /iap — In-app purchase daily revenue/units by brand + platform.
// Reads iap_daily (rollup rows, product_id='ALL'). Returns empty + pending=true
// when the table doesn't exist yet (schema not applied) or no rows are synced.
router.get('/iap', async (req, res) => {
  try {
    const brand = String(req.query.brand || 'ALL').toUpperCase();
    const start = req.query.start ? String(req.query.start).slice(0, 10) : '2026-01-01';
    const end = req.query.end ? String(req.query.end).slice(0, 10) : '2026-12-31';
    const params = [start, end];
    let brandFilter = '';
    if (brand === 'NOBL' || brand === 'FLO') { params.push(brand); brandFilter = `AND brand = $3`; }
    const q = await pgQuery(`
      SELECT date::text AS date, brand, platform,
             SUM(units)::int AS units,
             SUM(revenue_usd)::numeric(14,2) AS revenue_usd,
             SUM(proceeds_raw)::numeric(14,2) AS proceeds_raw
      FROM iap_daily
      WHERE product_id = 'ALL' AND date BETWEEN $1::date AND $2::date ${brandFilter}
      GROUP BY date, brand, platform
      ORDER BY date ASC
    `, params).catch((e) => { throw Object.assign(e, { _missing: e.code === '42P01' || /relation .* does not exist/i.test(e.message || '') }); });

    const rows = fmtRows(q.rows);
    const byPlatform = { apple: { units: 0, revenue_usd: 0 }, google: { units: 0, revenue_usd: 0 } };
    const byDateMap = {};
    for (const r of rows) {
      const p = byPlatform[r.platform] || (byPlatform[r.platform] = { units: 0, revenue_usd: 0 });
      p.units += toNum(r.units); p.revenue_usd += toNum(r.revenue_usd);
      const d = byDateMap[r.date] || (byDateMap[r.date] = { date: r.date, apple_revenue: 0, google_revenue: 0, apple_units: 0, google_units: 0 });
      d[`${r.platform}_revenue`] += toNum(r.revenue_usd);
      d[`${r.platform}_units`] += toNum(r.units);
    }
    const series = Object.values(byDateMap).sort((a, b) => a.date.localeCompare(b.date));
    const totalRevenue = byPlatform.apple.revenue_usd + byPlatform.google.revenue_usd;

    // Subscription state. active/trials are point-in-time snapshots whose recency
    // differs per platform (Apple ~daily, Google lags ~10d), so we FORWARD-FILL
    // each (brand,platform) series before summing — otherwise the latest date
    // would only reflect whichever platform reported last and undercount the
    // total. new/cancelled are flows → summed over the period.
    let subs = { active: 0, trials: 0, new: 0, cancelled: 0, series: [] };
    try {
      const sq = await pgQuery(`
        SELECT date::text AS date, brand, platform, active_subs, trials, new_subs, cancelled_subs
        FROM iap_subscription_daily
        WHERE date BETWEEN $1::date AND $2::date ${brandFilter}
        ORDER BY date ASC
      `, params);
      const srows = fmtRows(sq.rows);
      if (srows.length) {
        const dates = [...new Set(srows.map((r) => r.date))].sort();
        const keys = [...new Set(srows.map((r) => `${r.brand}|${r.platform}`))];
        const snap = {}; // key → date → {active, trials}
        const flow = {}; // date → {new, cancelled}
        for (const r of srows) {
          const k = `${r.brand}|${r.platform}`;
          (snap[k] = snap[k] || {})[r.date] = { active: toNum(r.active_subs), trials: toNum(r.trials) };
          const f = flow[r.date] || (flow[r.date] = { new: 0, cancelled: 0 });
          f.new += toNum(r.new_subs); f.cancelled += toNum(r.cancelled_subs);
        }
        const carry = {};
        const sseries = dates.map((d) => {
          let active = 0; let trials = 0;
          for (const k of keys) {
            if (snap[k][d]) carry[k] = snap[k][d];
            if (carry[k]) { active += carry[k].active; trials += carry[k].trials; }
          }
          return { date: d, active, trials, new_subs: flow[d]?.new || 0, cancelled_subs: flow[d]?.cancelled || 0 };
        });
        const latest = sseries[sseries.length - 1];
        subs = {
          active: latest.active,
          trials: latest.trials,
          new: sseries.reduce((s, r) => s + r.new_subs, 0),
          cancelled: sseries.reduce((s, r) => s + r.cancelled_subs, 0),
          series: sseries,
        };
      }
    } catch (e) { if (e.code !== '42P01') throw e; }

    res.json({
      brand, start, end, rows, series, byPlatform, subs,
      totals: {
        revenue_usd: totalRevenue,
        units: byPlatform.apple.units + byPlatform.google.units,
      },
      pending: rows.length === 0,
      // Google earnings reports lag ~1 month, so Play data trails Apple by a report cycle.
      google_status: byPlatform.google.revenue_usd > 0 ? 'active' : 'no_data',
    });
  } catch (e) {
    if (e._missing) {
      return res.json({ rows: [], series: [], byPlatform: { apple: { units: 0, revenue_usd: 0 }, google: { units: 0, revenue_usd: 0 } }, totals: { revenue_usd: 0, units: 0 }, pending: true, not_applied: true });
    }
    console.error('[Analytics /iap]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /performance-dashboard — NOBL + FLO CPMR, revenue A vs F, weekly & rolling metrics.
router.get('/performance-dashboard', async (req, res) => {
  try {
    const brand = String(req.query.brand || 'ALL').toUpperCase();
    const start = req.query.start ? String(req.query.start).slice(0, 10) : '2026-01-01';
    const end = req.query.end ? String(req.query.end).slice(0, 10) : '2026-12-31';
    const version = await getDataVersion();
    const cacheKey = `perf:${brand}:${start}:${end}`;
    const { body } = await withResponseCache('performance', cacheKey, version, async () => {
      const whereBrand = brand === 'ALL' ? '' : `AND brand = $3`;
      const params = brand === 'ALL' ? [start, end] : [start, end, brand];
      const resRows = await pgQuery(`
        SELECT brand, date::text AS date, gross_sales_tw, meta_cpmr,
               revenue_forecast, revenue_actual, week_start::text AS week_start,
               weekly_gross_sales, avg_meta_cpmr, rolling_7d_reach, rolling_7d_cpmr,
               meta_cpmr_2025, meta_cpmr_2026, tiktok_cpmr_2025, tiktok_cpmr_2026,
               cvr_weekly, updated_at::text AS updated_at
        FROM brand_performance_daily
        WHERE date BETWEEN $1::date AND $2::date ${whereBrand}
        ORDER BY brand, date ASC
      `, params).catch(() => ({ rows: [] }));
      const rows = fmtRows(resRows.rows).map(r => ({
        ...r,
        variance_pct: r.revenue_forecast > 0 && r.revenue_actual != null
          ? (toNum(r.revenue_actual) - toNum(r.revenue_forecast)) / toNum(r.revenue_forecast)
          : null,
        status: sheetTargetToStatus(null, r.revenue_forecast > 0 && r.revenue_actual != null
          ? (toNum(r.revenue_actual) - toNum(r.revenue_forecast)) / toNum(r.revenue_forecast)
          : null),
      }));
      const metaRes = await pgQuery(`
        SELECT COUNT(*)::int AS row_count, MIN(date)::text AS min_date,
               MAX(date)::text AS max_date, MAX(updated_at)::text AS updated_at
        FROM brand_performance_daily
      `, []).catch(() => ({ rows: [{}] }));
      const meta = fmtRows(metaRes.rows)[0] || {};
      const byBrand = {};
      for (const r of rows) {
        if (!byBrand[r.brand]) byBrand[r.brand] = [];
        byBrand[r.brand].push(r);
      }
      const weekly = [];
      const seenWeeks = new Set();
      for (const r of rows) {
        if (!r.week_start || seenWeeks.has(`${r.brand}:${r.week_start}`)) continue;
        seenWeeks.add(`${r.brand}:${r.week_start}`);
        weekly.push({
          brand: r.brand,
          week_start: r.week_start,
          weekly_gross_sales: toNum(r.weekly_gross_sales),
          avg_meta_cpmr: toNum(r.avg_meta_cpmr),
        });
      }
      return {
        start, end, brand, daily: rows, by_brand: byBrand, weekly,
        meta: meta.row_count > 0 ? meta : null,
        charts: [
          { id: 'revenue_af', title: 'Daily Revenue — Actual vs Forecast', brands: ['NOBL', 'FLO'] },
          { id: 'meta_cpmr_yoy', title: 'Meta CPMR 2025 vs 2026', brands: ['NOBL', 'FLO'] },
          { id: 'weekly_gross', title: 'Weekly Gross Sales & Avg Meta CPMR', brands: ['NOBL'] },
          { id: 'rolling_7d', title: '7-Day Rolling Reach & CPMR', brands: ['NOBL'] },
          { id: 'tiktok_cpmr_yoy', title: 'TikTok CPMR 2025 vs 2026', brands: ['NOBL', 'FLO'] },
        ],
        data_source: 'brand_performance_daily (imported via ETL)',
      };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /performance-dashboard]', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function capNoblAirEndDate(end) {
  const r = await pgQuery(
    `SELECT MAX(end_date::date)::text AS latest_complete_date
     FROM etl_run_log
     WHERE task = 'nobl_air_aggregate' AND status = 'success'`,
    []
  );
  const latest = r.rows[0]?.latest_complete_date;
  return latest && latest < end ? latest : end;
}

// GET /forecast-engine — calendar-aware revenue forecast for NOBL + FLO.
router.get('/forecast-engine', async (req, res) => {
  try {
    const brandParam = String(req.query.brand || 'ALL').toUpperCase();
    const asOf = req.query.asOf ? String(req.query.asOf).slice(0, 10) : null;
    const version = await getDataVersion();
    const { body } = await withResponseCache('forecast', `fe:${brandParam}:${asOf || 'latest'}`, version, async () => {
    const brands = brandParam === 'ALL'
      ? ['NOBL', 'FLO']
      : brandParam.split(',').map(s => s.trim()).filter(b => FORECAST_BRANDS[b]);
    if (brands.length === 0) brands.push('NOBL');
    const results = await Promise.all(brands.map(b => loadForecastBrand(b, asOf)));
    const combined = results.reduce((acc, b) => {
      acc.actual_revenue += toNum(b.full_year.actual_revenue);
      acc.projected_revenue += toNum(b.full_year.projected_revenue);
      acc.plan_revenue += toNum(b.full_year.plan_revenue);
      acc.actual_spend += toNum(b.full_year.actual_spend);
      acc.projected_spend += toNum(b.full_year.projected_spend);
      return acc;
    }, { actual_revenue: 0, projected_revenue: 0, plan_revenue: 0, actual_spend: 0, projected_spend: 0 });
    combined.actual_mer = combined.actual_spend > 0 ? combined.actual_revenue / combined.actual_spend : null;
    combined.projected_mer = combined.projected_spend > 0 ? combined.projected_revenue / combined.projected_spend : null;
    combined.variance = combined.plan_revenue > 0 ? combined.projected_revenue - combined.plan_revenue : null;
    combined.variance_pct = combined.plan_revenue > 0 ? combined.variance / combined.plan_revenue : null;
    combined.status = forecastStatus(combined.variance_pct);
    return {
      as_of: results.map(r => r.as_of).sort()[0] || asOf,
      brands: results,
      combined,
      methodology: {
        purpose: 'Daily actuals plus calendar-aware forward projection for current month and full year.',
        factors: ['day-of-week weights', 'sale calendar and strength tier', 'monthly seasonality', 'MER targets', 'manufactured drop windows', 'regional pacing'],
        redlines: ['no flat rolling average', 'drop windows remain discrete', 'BFCM is model anchored', 'full-year below P25 triggers review'],
      },
    };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /forecast-engine]', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function clampNoblAirStartDate(start) {
  const r = await pgQuery(
    `SELECT MIN(date)::text AS first_complete_date
     FROM nobl_air_daily
     WHERE air_orders > 0
       AND ttp_rate IS NOT NULL
       AND activation_rate IS NOT NULL`,
    []
  );
  const firstComplete = r.rows[0]?.first_complete_date;
  return firstComplete && start < firstComplete ? firstComplete : start;
}

// GET /overview
router.get('/overview', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const regionList = parseAnalyticsRegions(req.query.region || req.query.regions);
  const regionKey = regionList.length ? regionList.join(',') : 'ALL';
  const regionScoped = regionList.length > 0;
  try {
    const version = await getDataVersion();
    const { body } = await withResponseCache('overview', `ov:${start}:${end}:${regionKey}`, version, async () => {
    const [noblRes, floRes, subsRes] = await Promise.all([
      pgQuery(
        regionScoped ? regionSummarySql('nobl_brand_tw_geo_daily') : `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                total_revenue, total_spend, mer,
                total_orders, new_customer_orders, returning_customer_orders,
                COALESCE(order_revenue, total_revenue) AS order_revenue,
                shopify_revenue, amazon_revenue, total_sales,
                COALESCE(refund_amount, 0) AS refund_amount
         FROM nobl_brand_tw_summary_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
         ORDER BY date`,
        regionScoped ? [start, end, regionList] : [start, end]
      ),
      pgQuery(
        regionScoped ? regionSummarySql('flo_brand_tw_geo_daily') : `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                total_revenue, total_spend, mer,
                total_orders, new_customer_orders, returning_customer_orders,
                COALESCE(order_revenue, total_revenue) AS order_revenue,
                shopify_revenue, amazon_revenue, total_sales,
                COALESCE(refund_amount, 0) AS refund_amount
         FROM flo_brand_tw_summary_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
         ORDER BY date`,
        regionScoped ? [start, end, regionList] : [start, end]
      ),
      pgQuery(NOBL_SUBS_DAILY_SQL, [start, end]),
    ]);

    // Build date-keyed maps
    const toDateStr = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
    const noblMap = {};
    for (const r of noblRes.rows) noblMap[toDateStr(r.date)] = r;
    const floMap = {};
    for (const r of floRes.rows) floMap[toDateStr(r.date)] = r;
    const subsMap = {};
    for (const r of subsRes.rows) subsMap[toDateStr(r.date)] = r;

    // Merge all dates
    const allDates = new Set([...Object.keys(noblMap), ...Object.keys(floMap), ...Object.keys(subsMap)]);
    const sortedDates = Array.from(allDates).sort();

    const rows = sortedDates.map(d => {
      const n = noblMap[d] || {};
      const f = floMap[d] || {};
      const s = subsMap[d] || {};
      // order_revenue = actual Shopify+Amazon orders before refunds (canonical)
      // Falls back to total_revenue (TW attributed) if not yet synced
      const nRev   = parseFloat(n.order_revenue || n.total_revenue || 0);
      const nSpend = parseFloat(n.total_spend   || 0);
      const fRev   = parseFloat(f.order_revenue || f.total_revenue || 0);
      const fSpend = parseFloat(f.total_spend   || 0);
      return {
        date: d,
        nobl_revenue:        nRev,
        nobl_order_revenue:  parseFloat(n.order_revenue  || 0),
        nobl_shopify_revenue:parseFloat(n.shopify_revenue || 0),
        nobl_amazon_revenue: parseFloat(n.amazon_revenue  || 0),
        nobl_total_sales:    parseFloat(n.total_sales     || 0),
        nobl_refund_amount:  parseFloat(n.refund_amount   || 0),
        nobl_spend:          nSpend,
        nobl_mer:            nSpend > 0 ? parseFloat((nRev / nSpend).toFixed(4)) : null,
        nobl_orders:         n.total_orders == null ? null : parseInt(n.total_orders || 0),
        nobl_nc_orders:      n.new_customer_orders == null ? null : parseInt(n.new_customer_orders || 0),
        flo_revenue:         fRev,
        flo_order_revenue:   parseFloat(f.order_revenue   || 0),
        flo_shopify_revenue: parseFloat(f.shopify_revenue || 0),
        flo_amazon_revenue:  parseFloat(f.amazon_revenue  || 0),
        flo_total_sales:     parseFloat(f.total_sales     || 0),
        flo_refund_amount:   parseFloat(f.refund_amount   || 0),
        flo_spend:           fSpend,
        flo_mer:             fSpend > 0 ? parseFloat((fRev / fSpend).toFixed(4)) : null,
        flo_orders:          f.total_orders == null ? null : parseInt(f.total_orders || 0),
        flo_nc_orders:       f.new_customer_orders == null ? null : parseInt(f.new_customer_orders || 0),
        nobl_sub_revenue: parseFloat(s.sub_revenue_actual || 0),
        total_revenue:   nRev + fRev,
        total_spend:     nSpend + fSpend,
      };
    });

    const totals = rows.reduce((acc, r) => ({
      total_revenue:        (acc.total_revenue        || 0) + r.total_revenue,
      total_spend:          (acc.total_spend          || 0) + r.total_spend,
      nobl_revenue:         (acc.nobl_revenue         || 0) + r.nobl_revenue,
      nobl_order_revenue:   (acc.nobl_order_revenue   || 0) + r.nobl_order_revenue,
      nobl_shopify_revenue: (acc.nobl_shopify_revenue || 0) + r.nobl_shopify_revenue,
      nobl_amazon_revenue:  (acc.nobl_amazon_revenue  || 0) + r.nobl_amazon_revenue,
      nobl_total_sales:     (acc.nobl_total_sales     || 0) + r.nobl_total_sales,
      nobl_spend:           (acc.nobl_spend           || 0) + r.nobl_spend,
      nobl_orders:          (acc.nobl_orders          || 0) + r.nobl_orders,
      nobl_nc_orders:       (acc.nobl_nc_orders       || 0) + r.nobl_nc_orders,
      flo_revenue:          (acc.flo_revenue          || 0) + r.flo_revenue,
      flo_order_revenue:    (acc.flo_order_revenue    || 0) + r.flo_order_revenue,
      flo_shopify_revenue:  (acc.flo_shopify_revenue  || 0) + r.flo_shopify_revenue,
      flo_amazon_revenue:   (acc.flo_amazon_revenue   || 0) + r.flo_amazon_revenue,
      flo_total_sales:      (acc.flo_total_sales      || 0) + r.flo_total_sales,
      flo_spend:            (acc.flo_spend            || 0) + r.flo_spend,
      flo_orders:           (acc.flo_orders           || 0) + r.flo_orders,
      flo_nc_orders:        (acc.flo_nc_orders        || 0) + r.flo_nc_orders,
      nobl_sub_revenue: (acc.nobl_sub_revenue || 0) + r.nobl_sub_revenue,
    }), {});

    // Derived totals — MER uses order_revenue (actual) not TW attributed
    totals.blended_mer = totals.total_spend > 0
      ? parseFloat((totals.total_revenue / totals.total_spend).toFixed(4)) : 0;
    totals.nobl_mer = totals.nobl_spend > 0
      ? parseFloat((totals.nobl_revenue / totals.nobl_spend).toFixed(4)) : 0;
    totals.flo_mer = totals.flo_spend > 0
      ? parseFloat((totals.flo_revenue / totals.flo_spend).toFixed(4)) : 0;

    return { rows, totals, revenue_metrics: REVENUE_METRICS, region_scoped: regionScoped, regions: regionList };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /overview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/topline
router.get('/nobl/topline', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
    const version = await getDataVersion();
    const { body } = await withResponseCache('topline', `nt:${start}:${end}`, version, async () => {
    const [summaryRes, channelsRes, geoRes, subsRes] = await Promise.all([
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                brand, total_revenue, total_spend, mer,
                total_orders, new_customer_orders, returning_customer_orders,
                COALESCE(order_revenue, total_revenue) AS order_revenue,
                shopify_revenue, amazon_revenue, total_sales, refund_amount, refund_count
         FROM nobl_brand_tw_summary_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date`,
        [start, end]
      ),
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                brand, channel, spend_1d, revenue_1d, purchases_1d, roas_1d,
                spend_7d, new_cust_orders, cac, portable_cac, wooden_cac, metal_cac
         FROM nobl_brand_tw_channel_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, channel`,
        [start, end]
      ),
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                brand, region, revenue_actual, spend_actual, mer
         FROM nobl_brand_tw_geo_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, region`,
        [start, end]
      ),
      pgQuery(NOBL_SUBS_DAILY_SQL, [start, end]),
    ]);
    return {
      summary: enrichSummaryRows(fmtRows(summaryRes.rows)),
      channels: enrichChannelRows(fmtRows(channelsRes.rows)),
      geo: enrichGeoRows(fmtRows(geoRes.rows)),
      subs: fmtRows(subsRes.rows),
      revenue_metrics: REVENUE_METRICS,
    };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /nobl/topline]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /flo/topline
router.get('/flo/topline', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
    const version = await getDataVersion();
    const { body } = await withResponseCache('topline', `ft:${start}:${end}`, version, async () => {
    const [summaryRes, channelsRes, geoRes, productsRes] = await Promise.all([
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                brand, total_revenue, total_spend, mer,
                total_orders, new_customer_orders, returning_customer_orders,
                COALESCE(order_revenue, total_revenue) AS order_revenue,
                shopify_revenue, amazon_revenue, total_sales, refund_amount, refund_count
         FROM flo_brand_tw_summary_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date`,
        [start, end]
      ),
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                brand, channel, spend_1d, revenue_1d, purchases_1d, roas_1d,
                spend_7d, new_cust_orders, cac, portable_cac, wooden_cac, metal_cac
         FROM flo_brand_tw_channel_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, channel`,
        [start, end]
      ),
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                brand, region, revenue_actual, spend_actual, mer
         FROM flo_brand_tw_geo_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, region`,
        [start, end]
      ),
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                brand, product_line, spend, new_cust_orders, revenue,
                meta_spend, google_spend, tiktok_spend, snap_spend, pinterest_spend, bing_spend, applovin_spend
         FROM flo_brand_tw_product_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, product_line`,
        [start, end]
      ),
    ]);
    return {
      summary: enrichSummaryRows(fmtRows(summaryRes.rows)),
      channels: enrichChannelRows(fmtRows(channelsRes.rows)),
      geo: enrichGeoRows(fmtRows(geoRes.rows)),
      products: fmtRows(productsRes.rows),
      revenue_metrics: REVENUE_METRICS,
    };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /flo/topline]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /channels
router.get('/channels', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const brand = (req.query.brand || '').toUpperCase();
  const sortBy = String(req.query.sortBy || '').trim();
  const sortDir = (String(req.query.dir || 'asc').toLowerCase() === 'desc') ? 'desc' : 'asc';
  // Region scoping: channel grain is not tracked per region, so when a specific
  // region (or set of regions) is selected we serve accurate region-level daily
  // totals from the geo table, surfaced as one series per region.
  const regionRaw = String(req.query.region || req.query.regions || '').toUpperCase();
  const regionList = regionRaw.split(',').map(s => s.trim()).filter(Boolean).filter(r => r !== 'ALL');
  const regionScoped = regionList.length > 0;
  const GEO_TABLE = { NOBL: 'nobl_brand_tw_geo_daily', FLO: 'flo_brand_tw_geo_daily' };
  try {
    const version = await getDataVersion();
    const { body } = await withResponseCache('channels', `ch:${brand}:${start}:${end}:${regionRaw}:${sortBy}:${sortDir}`, version, async () => {
    if (regionScoped) {
      const loadGeoRows = async (brandKey) => {
        const r = await pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date, UPPER(region) AS region,
                revenue_actual, spend_actual
         FROM ${GEO_TABLE[brandKey]}
         WHERE UPPER(region) = ANY($3::text[])
           AND DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
         ORDER BY date, region`,
        [start, end, regionList],
        );
        return r.rows.map(row => ({ ...row, brand: brandKey }));
      };
      const sourceRows = (brand === 'NOBL' || brand === 'FLO')
        ? await loadGeoRows(brand)
        : (await Promise.all([loadGeoRows('NOBL'), loadGeoRows('FLO')])).flat();
      const regionRows = sourceRows.map((row) => {
        const spend = Number(row.spend_actual) || 0;
        const revenue = Number(row.revenue_actual) || 0;
        return {
          date: row.date,
          brand: row.brand,
          channel: row.region,
          spend_1d: spend,
          revenue_1d: revenue,
          purchases_1d: null,
          roas_1d: spend > 0 ? revenue / spend : null,
          spend_7d: null,
          new_cust_orders: null,
          cac: null,
        };
      });
      return {
        rows: regionRows,
        region_scoped: true,
        brand: brand || 'ALL',
        regions: regionList,
        channel_level_available: false,
      };
    }
    let rows = [];
    if (brand === 'NOBL') {
      const r = await pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                brand, channel, spend_1d, revenue_1d, purchases_1d, roas_1d,
                spend_7d, new_cust_orders, cac
         FROM nobl_brand_tw_channel_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, channel`,
        [start, end]
      );
      rows = enrichChannelRows(fmtRows(r.rows));
    } else if (brand === 'FLO') {
      const r = await pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                brand, channel, spend_1d, revenue_1d, purchases_1d, roas_1d,
                spend_7d, new_cust_orders, cac
         FROM flo_brand_tw_channel_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, channel`,
        [start, end]
      );
      rows = enrichChannelRows(fmtRows(r.rows));
    } else {
      const [noblRes, floRes] = await Promise.all([
        pgQuery(
          `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                  brand, channel, spend_1d, revenue_1d, purchases_1d, roas_1d,
                  spend_7d, new_cust_orders, cac
           FROM nobl_brand_tw_channel_daily
           WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, channel`,
          [start, end]
        ),
        pgQuery(
          `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                  brand, channel, spend_1d, revenue_1d, purchases_1d, roas_1d,
                  spend_7d, new_cust_orders, cac
           FROM flo_brand_tw_channel_daily
           WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, channel`,
          [start, end]
        ),
      ]);
      rows = [
        ...enrichChannelRows(fmtRows(noblRes.rows)),
        ...enrichChannelRows(fmtRows(floRes.rows)),
      ];
      rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }
    // Optional server-side sort if requested
    if (sortBy) {
      rows.sort((a, b) => {
        const av = a[sortBy];
        const bv = b[sortBy];
        const cmp = (Number.isFinite(av) && Number.isFinite(bv))
          ? av - bv
          : String(av ?? '').localeCompare(String(bv ?? ''));
        return sortDir === 'desc' ? -cmp : cmp;
      });
    }
    return { rows };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /channels]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/subscriptions
router.get('/nobl/subscriptions', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
    const version = await getDataVersion();
    const { body } = await withResponseCache('subs', `ns:${start}:${end}`, version, async () => {
    const [dailyRes, summaryRes] = await Promise.all([
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                sub_gross AS shopify_sub_gross,
                sub_discounts AS shopify_sub_disc,
                sub_refunds AS shopify_sub_refunds,
                rebill_revenue,
                new_sub_revenue,
                (sub_net_sales + rebill_revenue) AS sub_revenue_actual
         FROM nobl_air_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date`,
        [start, end]
      ),
      pgQuery(
        `WITH subscribers AS (
           SELECT
             appstle_id,
             customer_id,
             status,
             contract_amount,
             created_at,
             COALESCE(
               last_billing_date,
               (CASE
                 WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'object'
                   THEN (raw_json->'lastSuccessfulOrder'->>'orderDate')::timestamptz
                 WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'string'
                   THEN ((raw_json->>'lastSuccessfulOrder')::jsonb->>'orderDate')::timestamptz
                 ELSE NULL
               END)
             ) AS paid_billing_date
           FROM nobl_air_subscribers
         ), subscriber_rebills AS (
           SELECT DISTINCT s.appstle_id
           FROM subscribers s
           JOIN shopify_orders_raw o ON o.brand = 'NOBL'
             AND o.is_rebill
             AND (
               s.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
               OR s.customer_id = o.customer_id
             )
           WHERE o.created_at > s.created_at
         )
         SELECT
           COUNT(*) AS total,
            COUNT(*) FILTER (WHERE LOWER(status) = 'active') AS active,
            COUNT(*) FILTER (WHERE LOWER(status) = 'cancelled') AS cancelled,
            COUNT(*) FILTER (WHERE LOWER(status) = 'paused') AS paused,
            COUNT(*) FILTER (WHERE LOWER(status) = 'trialing') AS trialing,
           COUNT(*) FILTER (WHERE paid_billing_date > created_at OR rb.appstle_id IS NOT NULL) AS converted,
           AVG(contract_amount) FILTER (WHERE contract_amount IS NOT NULL AND contract_amount > 0) AS avg_order_amount
         FROM subscribers s
         LEFT JOIN subscriber_rebills rb ON rb.appstle_id = s.appstle_id`,
        []
      ),
    ]);
    const s = summaryRes.rows[0] || {};
    return {
      daily: fmtRows(dailyRes.rows),
      summary: {
        total: parseInt(s.total || 0),
        active: parseInt(s.active || 0),
        cancelled: parseInt(s.cancelled || 0),
        paused: parseInt(s.paused || 0),
        trialing: parseInt(s.trialing || 0),
        converted: parseInt(s.converted || 0),
        avg_order_amount: parseFloat(s.avg_order_amount || 0),
      },
    };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /nobl/subscriptions]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /subscriptions?brand=NOBL|FLO
async function fetchFloSubs(start, end) {
  const [dailyRes, newSubRes, summaryRes] = await Promise.all([
    pgQuery(
      `SELECT TO_CHAR(date, 'YYYY-MM-DD') AS date,
              shopify_sub_gross, shopify_sub_disc, shopify_sub_refunds,
              rebill_revenue
       FROM flo_appstle_revenue_daily
       WHERE date BETWEEN $1::date AND $2::date
       ORDER BY date`,
      [start, end]
    ),
    pgQuery(
      `SELECT TO_CHAR((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
              COUNT(*) AS new_sub_count,
              COALESCE(SUM(contract_amount), 0) AS new_sub_revenue
       FROM flo_appstle_subscribers
       WHERE (created_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
       GROUP BY 1`,
      [start, end]
    ),
    pgQuery(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE LOWER(status) = 'active') AS active,
         COUNT(*) FILTER (WHERE LOWER(status) = 'cancelled') AS cancelled,
         COUNT(*) FILTER (WHERE LOWER(status) = 'paused') AS paused,
         COUNT(*) FILTER (WHERE is_converted) AS converted,
         AVG(contract_amount) FILTER (WHERE contract_amount IS NOT NULL AND contract_amount > 0) AS avg_order_amount
       FROM flo_appstle_subscribers`,
      []
    ),
  ]);
  const nsByDate = {};
  for (const r of newSubRes.rows) {
    nsByDate[r.date] = { count: parseInt(r.new_sub_count || 0), revenue: parseFloat(r.new_sub_revenue || 0) };
  }
  const byDate = {};
  for (const r of dailyRes.rows) {
    byDate[r.date] = { ...r, rebill_revenue: parseFloat(r.rebill_revenue || 0) };
  }
  for (const d of Object.keys(nsByDate)) {
    if (!byDate[d]) byDate[d] = { date: d, shopify_sub_gross: 0, shopify_sub_disc: 0, shopify_sub_refunds: 0, rebill_revenue: 0 };
  }
  const daily = Object.values(byDate).map(r => {
    const ns = nsByDate[r.date] || { count: 0, revenue: 0 };
    return {
      ...r,
      new_sub_revenue: ns.revenue,
      new_sub_count: ns.count,
      sub_revenue_actual: (Number(r.rebill_revenue) || 0) + ns.revenue,
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const s = summaryRes.rows[0] || {};
  return {
    brand: 'FLO',
    daily: fmtRows(daily),
    summary: {
      total: parseInt(s.total || 0),
      active: parseInt(s.active || 0),
      cancelled: parseInt(s.cancelled || 0),
      paused: parseInt(s.paused || 0),
      converted: parseInt(s.converted || 0),
      avg_order_amount: parseFloat(s.avg_order_amount || 0),
    },
  };
}

async function fetchNoblSubs(start, end) {
  const [dailyRes, newSubRes, summaryRes] = await Promise.all([
    pgQuery(
      `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
              sub_gross AS shopify_sub_gross,
              sub_discounts AS shopify_sub_disc,
              sub_refunds AS shopify_sub_refunds,
              rebill_revenue
       FROM nobl_air_daily
       WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date`,
      [start, end]
    ),
    pgQuery(
      `SELECT TO_CHAR((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
              COUNT(*) AS new_sub_count,
              COALESCE(SUM(contract_amount), 0) AS new_sub_revenue
       FROM nobl_air_subscribers
       WHERE (created_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
       GROUP BY 1`,
      [start, end]
    ),
    pgQuery(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE LOWER(status) = 'active') AS active,
         COUNT(*) FILTER (WHERE LOWER(status) = 'cancelled') AS cancelled,
         COUNT(*) FILTER (WHERE LOWER(status) = 'paused') AS paused,
         COUNT(*) FILTER (WHERE is_converted) AS converted,
         AVG(contract_amount) FILTER (WHERE contract_amount IS NOT NULL AND contract_amount > 0) AS avg_order_amount
       FROM nobl_air_subscribers`,
      []
    ),
  ]);
  const nsByDate = {};
  for (const r of newSubRes.rows) {
    nsByDate[r.date] = { count: parseInt(r.new_sub_count || 0), revenue: parseFloat(r.new_sub_revenue || 0) };
  }
  const byDate = {};
  for (const r of dailyRes.rows) {
    byDate[r.date] = { ...r, rebill_revenue: parseFloat(r.rebill_revenue || 0) };
  }
  for (const d of Object.keys(nsByDate)) {
    if (!byDate[d]) byDate[d] = { date: d, shopify_sub_gross: 0, shopify_sub_disc: 0, shopify_sub_refunds: 0, rebill_revenue: 0 };
  }
  const daily = Object.values(byDate).map(r => {
    const ns = nsByDate[r.date] || { count: 0, revenue: 0 };
    return {
      ...r,
      new_sub_revenue: ns.revenue,
      new_sub_count: ns.count,
      sub_revenue_actual: (Number(r.rebill_revenue) || 0) + ns.revenue,
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const s = summaryRes.rows[0] || {};
  return {
    brand: 'NOBL',
    daily: fmtRows(daily),
    summary: {
      total: parseInt(s.total || 0),
      active: parseInt(s.active || 0),
      cancelled: parseInt(s.cancelled || 0),
      paused: parseInt(s.paused || 0),
      converted: parseInt(s.converted || 0),
      avg_order_amount: parseFloat(s.avg_order_amount || 0),
    },
  };
}

function mergeBrandSubs(results) {
  const numFields = ['shopify_sub_gross','shopify_sub_disc','shopify_sub_refunds','rebill_revenue','new_sub_revenue','new_sub_count','sub_revenue_actual'];
  const byDate = {};
  for (const res of results) {
    for (const row of res.daily) {
      if (!byDate[row.date]) {
        byDate[row.date] = { date: row.date };
        for (const f of numFields) byDate[row.date][f] = 0;
      }
      for (const f of numFields) byDate[row.date][f] += Number(row[f]) || 0;
    }
  }
  const daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

  const sumKeys = ['total','active','cancelled','paused','converted'];
  const summary = {};
  for (const k of sumKeys) {
    summary[k] = results.reduce((s, r) => s + (r.summary[k] || 0), 0);
  }
  // Weighted avg contract value by subscriber count
  const totalSubs = results.reduce((s, r) => s + (r.summary.total || 0), 0);
  summary.avg_order_amount = totalSubs > 0
    ? results.reduce((s, r) => s + (r.summary.avg_order_amount || 0) * (r.summary.total || 0), 0) / totalSubs
    : 0;

  return {
    brand: results.map(r => r.brand).join(','),
    brands: results.map(r => r.brand),
    daily,
    summary,
  };
}

router.get('/subscriptions', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const brandParam = String(req.query.brand || 'NOBL').toUpperCase();
  const brands = brandParam === 'ALL'
    ? ['NOBL', 'FLO']
    : brandParam.split(',').map(s => s.trim()).filter(b => b === 'NOBL' || b === 'FLO');
  if (brands.length === 0) brands.push('NOBL');

  try {
    const version = await getDataVersion();
    const { body } = await withResponseCache('subs', `subs:${brands.join(',')}:${start}:${end}`, version, async () => {
      if (brands.length === 1) {
        return brands[0] === 'FLO' ? await fetchFloSubs(start, end) : await fetchNoblSubs(start, end);
      }
      const fetchers = brands.map(b => b === 'FLO' ? fetchFloSubs(start, end) : fetchNoblSubs(start, end));
      const results = await Promise.all(fetchers);
      return mergeBrandSubs(results);
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /subscriptions]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Legacy single-brand inline implementation removed (now in fetchNoblSubs / fetchFloSubs above) ──

// GET /nobl/data-version — bump when nightly ETL updates Air / Meta tables (cache invalidation)
router.get('/nobl/data-version', async (req, res) => {
  try {
    const meta = await getNoblAirDataVersion(true);
    res.json({
      version: meta.version,
      air_daily_max: meta.air_daily_max,
      meta_air_max: meta.meta_air_max,
      aggregate_end: meta.aggregate_end,
      last_etl_at: meta.last_etl_at,
    });
  } catch (e) {
    console.error('[Analytics /nobl/data-version]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /data-bounds — earliest & latest dates that actually have data
router.get('/data-bounds', async (req, res) => {
  try {
    const version = await getDataVersion();
    const { body } = await withResponseCache('bounds', 'data-bounds', version, async () => {
      const r = await pgQuery(`
        SELECT
          LEAST(
            (SELECT MIN(DATE(date AT TIME ZONE 'UTC')) FROM nobl_brand_tw_summary_daily),
            (SELECT MIN(DATE(date AT TIME ZONE 'UTC')) FROM flo_brand_tw_summary_daily)
          )::text AS earliest,
          GREATEST(
            (SELECT MAX(DATE(date AT TIME ZONE 'UTC')) FROM nobl_brand_tw_summary_daily),
            (SELECT MAX(DATE(date AT TIME ZONE 'UTC')) FROM flo_brand_tw_summary_daily)
          )::text AS latest
      `);
      return r.rows[0] || {};
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /data-bounds]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /kpi-pulse — leadership KPI matrix (daily / weekly / quarterly) from existing DB tables.
// Returns ONLY metrics derivable from the database; the frontend blanks everything else.
// Ratios are recomputed from summed base values per period (not averaged), so weekly /
// quarterly rollups are correct, and buckets advance automatically as new daily data lands.
router.get('/kpi-pulse', async (req, res) => {
  try {
    const version = await getDataVersion();
    const requestedMonth = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : null;
    const { body } = await withResponseCache('kpi-pulse', `kpi-pulse:${requestedMonth || 'latest'}`, version, async () => {
      const year = new Date().getUTCFullYear();
      const start = `${year}-01-01`;
      const end = `${year}-12-31`;
      const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const niceMD = (iso) => { const [, m, d] = iso.split('-'); return `${MONTHS[parseInt(m,10)-1]} ${parseInt(d,10)}`; };
      const weekEndISO = (iso) => { const [y,m,d] = iso.split('-').map(Number); const dt = new Date(Date.UTC(y,m-1,d)); dt.setUTCDate(dt.getUTCDate() + ((7 - dt.getUTCDay()) % 7)); return dt.toISOString().slice(0,10); };
      // KPI Pulse TOF/BOF uses campaign/adset naming. Ad names contain creative
      // codes (for example 008BoF) that overclassify promo creatives as BOF.
      const bofCampaignAdsetRegex = `retarget|remarket|(^|[^a-z])bof[0-9]?([^a-z]|$)|bottom|warm|existing|past[ -]?purchaser|winback`;

      const emptyRows = () => ({ rows: [] });
      const [noblSum, floSum, noblGeo, floGeo, air, airRegion, ops, cs, disputes, meta, twAds, twFunnel, metaStrat, metaTestRoas, klav, twEmailSms, twSessions, twRefunds, airSubs, floIapSubs, floIapRev, returning, shopifyStats, shopifyRegionStats, products, floAppstle, floAppstleTtp, noblBundle, noblBundleCm1, floProductSales] = await pgQueryBatch([
        { sql: `SELECT TO_CHAR(date AT TIME ZONE 'UTC','YYYY-MM-DD') d, COALESCE(order_revenue,total_revenue) rev, COALESCE(order_revenue,total_revenue) gmd, total_spend spend, total_orders orders, amazon_revenue amazon, total_sales tsales, refund_amount refund FROM nobl_brand_tw_summary_daily WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date`, params: [start, end] },
        { sql: `SELECT TO_CHAR(date AT TIME ZONE 'UTC','YYYY-MM-DD') d, COALESCE(order_revenue,total_revenue) rev, COALESCE(order_revenue,total_revenue) gmd, total_spend spend, total_orders orders, amazon_revenue amazon, total_sales tsales, refund_amount refund FROM flo_brand_tw_summary_daily WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date`, params: [start, end] },
        { sql: `SELECT TO_CHAR(date AT TIME ZONE 'UTC','YYYY-MM-DD') d, region, revenue_actual rev, spend_actual spend FROM nobl_brand_tw_geo_daily WHERE region != 'TOTAL' AND DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date`, params: [start, end] },
        { sql: `SELECT TO_CHAR(date AT TIME ZONE 'UTC','YYYY-MM-DD') d, region, revenue_actual rev, spend_actual spend FROM flo_brand_tw_geo_daily WHERE region != 'TOTAL' AND DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date`, params: [start, end] },
        { sql: `SELECT TO_CHAR(date AT TIME ZONE 'UTC','YYYY-MM-DD') d, total_orders to_, air_orders ao, converted_count conv, mature_count mat, combined_net_revenue arev FROM nobl_air_daily WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date`, params: [start, end] },
        { sql: `SELECT TO_CHAR(date,'YYYY-MM-DD') d, region_key, total_orders, air_orders, mature_count, converted_count FROM nobl_air_region_daily WHERE date BETWEEN $1::date AND $2::date AND region_key IN ('INTL','AUS','CA','UK')`, params: [start, end], fallback: emptyRows },
        // Ops (per brand × date): for "Avg Shipping Cost / Order" + "Orders Unfulfilled".
        // We store the AVG per day; for weekly/quarterly we re-average ACROSS days
        // (cost) and take MAX (the snapshot count) so the rollup is sensible.
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d, orders_count oc, avg_shipping_cost_per_order asc_, orders_unfulfilled ouf, orders_unfulfilled_over_24h ouf24,
                  COALESCE(us_orders_unfulfilled, 0) us_ouf, COALESCE(ca_orders_unfulfilled, 0) ca_ouf, COALESCE(au_orders_unfulfilled, 0) au_ouf, COALESCE(uk_orders_unfulfilled, 0) uk_ouf,
                  COALESCE(us_orders_unfulfilled_over_24h, 0) us_ouf24, COALESCE(uk_orders_unfulfilled_over_24h, 0) uk_ouf24,
                  avg_fulfillment_hours afh, avg_ship_to_door_hours asdh, ca_avg_ttf_days ca_ttf, au_avg_ttf_days au_ttf, uk_avg_ttf_days uk_ttf
                FROM ops_metrics_daily WHERE date BETWEEN $1::date AND $2::date`, params: [start, end], fallback: emptyRows },
        // CS tickets per brand × date. Extended columns are optional — the
        // column-list `COALESCE`s handle DBs where the ETL hasn't been redeployed yet.
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d, total_tickets tt, shopify_matched sm, us_tickets us, ca_tickets ca, au_tickets au, uk_tickets uk, effective_closed_tickets closed,
                  COALESCE(first_response_count, 0) fr_count, COALESCE(first_response_seconds_sum, 0) fr_sum,
                  COALESCE(first_resolution_count, 0) frr_count, COALESCE(first_resolution_seconds_sum, 0) frr_sum,
                  COALESCE(csat_count, 0) csat_count, COALESCE(csat_sum, 0) csat_sum,
                  COALESCE(recovery_revenue, 0) recovery_rev, COALESCE(wrong_order_count, 0) wrong_order, top_themes
                FROM cs_tickets_daily WHERE date BETWEEN $1::date AND $2::date`, params: [start, end], fallback: emptyRows },
        // Shopify Payments disputes/chargebacks per brand × date for CB Rate KPIs.
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d,
                  SUM(chargeback_count) cb,
                  SUM(us_chargeback_count) us_cb,
                  SUM(ca_chargeback_count) ca_cb,
                  SUM(au_chargeback_count) au_cb,
                  SUM(uk_chargeback_count) uk_cb
                FROM shopify_disputes_daily
                WHERE date BETWEEN $1::date AND $2::date
                GROUP BY brand, date`, params: [start, end], fallback: emptyRows },
        // Meta direct — requested source for Whitelisting Spend % of Meta Spend.
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d,
                  SUM(purchases) p,
                  SUM(link_clicks) lc,
                  SUM(clicks) c,
                  SUM(spend) s,
                  SUM(spend) FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) ~ 'whitelist|white list|whitelisting|(^|[^a-z0-9])wl([^a-z0-9]|$)') whitelist_spend,
                  SUM(spend) FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) ~ '(^|[^a-z0-9])test([^a-z0-9]|$)|testing') test_spend,
                  SUM(spend) FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name)) ~ $3) bof_spend
                FROM meta_ads_daily WHERE date BETWEEN $1::date AND $2::date GROUP BY brand, date`, params: [start, end, bofCampaignAdsetRegex], fallback: emptyRows },
        // Triple Whale ads_table — requested source for Meta CVR %, TOF/BOF split, and test-spend context.
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d,
                  SUM(purchases) p,
                  SUM(link_clicks) lc,
                  SUM(clicks) c,
                  SUM(spend) s,
                  SUM(spend) FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) ~ '(^|[^a-z0-9])test([^a-z0-9]|$)|testing') test_spend,
                  SUM(spend) FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) ~ 'retarget|remarket|\bbof\b|bottom|warm|existing|past purchaser|winback') bof_spend
                FROM tw_ads_daily
                WHERE date BETWEEN $1::date AND $2::date
                  AND LOWER(platform) IN ('facebook-ads','facebook_ads','meta','facebook','instagram')
                GROUP BY brand, date`, params: [start, end], fallback: emptyRows },
        // Corrected TW Meta funnel split. Use campaign/adset only; ad names carry
        // creative codes that do not match the Sheet's TOF/BOF split convention.
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d,
                  SUM(spend) s,
                  SUM(spend) FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name)) ~ $3) bof_spend
                FROM tw_ads_daily
                WHERE date BETWEEN $1::date AND $2::date
                  AND LOWER(platform) IN ('facebook-ads','facebook_ads','meta','facebook','instagram')
                GROUP BY brand, date`, params: [start, end, bofCampaignAdsetRegex], fallback: emptyRows },
        // Meta Ads — strategist Share of Spend + FLO product CAC. Driven by the
        // ad-name code convention from the Nysonian Meta GAS script:
        //   002TC = Taylor, 002FA = Franz, 002LK = Luke, 002CA = Chris.
        // FLO product bucket comes from normalized substring in campaign|adset|ad name:
        //   "portable" → portable, "studio"|"sutido" → studio, "home" → home.
        // Per the GAS script: no TOF/MOF/BOF filtering — all strategist-coded spend
        // counts as the strategist's funnel for the Share-of-Spend metric.
        { sql: `
          SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d,
            -- per-strategist spend (NOBL uses all four; FLO mostly Chris)
            SUM(spend) FILTER (WHERE UPPER(ad_name) LIKE '%002TC%') AS sp_taylor,
            SUM(spend) FILTER (WHERE UPPER(ad_name) LIKE '%002FA%') AS sp_franz,
            SUM(spend) FILTER (WHERE UPPER(ad_name) LIKE '%002LK%') AS sp_luke,
            SUM(spend) FILTER (WHERE UPPER(ad_name) LIKE '%002CA%') AS sp_chris,
            -- FLO Chris by product bucket (only meaningful for brand='FLO')
            SUM(spend)     FILTER (WHERE UPPER(ad_name) LIKE '%002CA%' AND (
              LOWER(REGEXP_REPLACE(coalesce(campaign_name,'')||' '||coalesce(adset_name,'')||' '||coalesce(ad_name,''), '[^a-z0-9]', '', 'g')) LIKE '%portable%'
            )) AS sp_portable,
            SUM(purchases) FILTER (WHERE UPPER(ad_name) LIKE '%002CA%' AND (
              LOWER(REGEXP_REPLACE(coalesce(campaign_name,'')||' '||coalesce(adset_name,'')||' '||coalesce(ad_name,''), '[^a-z0-9]', '', 'g')) LIKE '%portable%'
            )) AS pu_portable,
            SUM(spend)     FILTER (WHERE UPPER(ad_name) LIKE '%002CA%' AND (
              LOWER(REGEXP_REPLACE(coalesce(campaign_name,'')||' '||coalesce(adset_name,'')||' '||coalesce(ad_name,''), '[^a-z0-9]', '', 'g')) LIKE '%studio%' OR
              LOWER(REGEXP_REPLACE(coalesce(campaign_name,'')||' '||coalesce(adset_name,'')||' '||coalesce(ad_name,''), '[^a-z0-9]', '', 'g')) LIKE '%sutido%'
            )) AS sp_studio,
            SUM(purchases) FILTER (WHERE UPPER(ad_name) LIKE '%002CA%' AND (
              LOWER(REGEXP_REPLACE(coalesce(campaign_name,'')||' '||coalesce(adset_name,'')||' '||coalesce(ad_name,''), '[^a-z0-9]', '', 'g')) LIKE '%studio%' OR
              LOWER(REGEXP_REPLACE(coalesce(campaign_name,'')||' '||coalesce(adset_name,'')||' '||coalesce(ad_name,''), '[^a-z0-9]', '', 'g')) LIKE '%sutido%'
            )) AS pu_studio,
            SUM(spend)     FILTER (WHERE UPPER(ad_name) LIKE '%002CA%' AND (
              LOWER(REGEXP_REPLACE(coalesce(campaign_name,'')||' '||coalesce(adset_name,'')||' '||coalesce(ad_name,''), '[^a-z0-9]', '', 'g')) LIKE '%home%'
            )) AS sp_home,
            SUM(purchases) FILTER (WHERE UPPER(ad_name) LIKE '%002CA%' AND (
              LOWER(REGEXP_REPLACE(coalesce(campaign_name,'')||' '||coalesce(adset_name,'')||' '||coalesce(ad_name,''), '[^a-z0-9]', '', 'g')) LIKE '%home%'
            )) AS pu_home
          FROM meta_ads_daily
          WHERE date BETWEEN $1::date AND $2::date
          GROUP BY brand, date`, params: [start, end], fallback: emptyRows },
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d,
                  SUM(revenue) FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) LIKE '%test-video-all%' AND UPPER(ad_name) LIKE '%002TC%') AS rev_taylor,
                  SUM(spend)   FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) LIKE '%test-video-all%' AND UPPER(ad_name) LIKE '%002TC%') AS sp_taylor,
                  SUM(revenue) FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) LIKE '%test-video-all%' AND UPPER(ad_name) LIKE '%002FA%') AS rev_franz,
                  SUM(spend)   FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) LIKE '%test-video-all%' AND UPPER(ad_name) LIKE '%002FA%') AS sp_franz,
                  SUM(revenue) FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) LIKE '%test-video-all%' AND UPPER(ad_name) LIKE '%002LK%') AS rev_luke,
                  SUM(spend)   FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) LIKE '%test-video-all%' AND UPPER(ad_name) LIKE '%002LK%') AS sp_luke,
                  SUM(revenue) FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) LIKE '%test-video-all%' AND UPPER(ad_name) LIKE '%002CA%') AS rev_chris,
                  SUM(spend)   FILTER (WHERE LOWER(CONCAT_WS(' ', campaign_name, adset_name, ad_name)) LIKE '%test-video-all%' AND UPPER(ad_name) LIKE '%002CA%') AS sp_chris
                FROM meta_ads_daily
                WHERE date BETWEEN $1::date AND $2::date
                GROUP BY brand, date`, params: [start, end], fallback: emptyRows },
        // Legacy Klaviyo API table (kept for diagnostics; TW email_sms is the requested KPI source).
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d, revenue r FROM klaviyo_daily WHERE date BETWEEN $1::date AND $2::date`, params: [start, end], fallback: emptyRows },
        // Triple Whale email_sms_table — requested source for retention/email/SMS revenue split.
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d,
                  SUM(revenue) revenue,
                  SUM(revenue) FILTER (WHERE LOWER(channel) = 'sms') sms_revenue,
                  SUM(revenue) FILTER (WHERE LOWER(channel) <> 'sms') email_revenue,
                  SUM(revenue) FILTER (WHERE LOWER(message_type) LIKE '%flow%') flow_revenue,
                  SUM(revenue) FILTER (WHERE LOWER(message_type) NOT LIKE '%flow%') campaign_revenue,
                  SUM(unsubscribes) unsubscribes,
                  SUM(delivered) delivered
                FROM tw_email_sms_daily
                WHERE date BETWEEN $1::date AND $2::date
                GROUP BY brand, date`, params: [start, end], fallback: emptyRows },
        // Triple Pixel sessions_table persisted by tw_sessions. DAU/MAU means
        // unique triple_id; sessions prefer visit_session_id, falling back to legacy session_id/row count.
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d,
                  SUM(dau) dau,
                  MAX(NULLIF(mau,0)) mau,
                  SUM(COALESCE(NULLIF(visit_sessions,0), NULLIF(legacy_sessions,0), total_sessions, 0)) sessions,
                  AVG(dau_mau_pct) FILTER (WHERE dau_mau_pct IS NOT NULL) dau_mau_pct
                FROM tw_sessions_daily
                WHERE date BETWEEN $1::date AND $2::date
                GROUP BY brand, date`, params: [start, end], fallback: emptyRows },
        { sql: `SELECT brand, TO_CHAR(date,'YYYY-MM-DD') d,
                  SUM(refund_amount) refund_amount,
                  SUM(COALESCE(us_refund_amount,0)) us_refund_amount,
                  SUM(COALESCE(ca_refund_amount,0)) ca_refund_amount,
                  SUM(COALESCE(au_refund_amount,0)) au_refund_amount,
                  SUM(COALESCE(uk_refund_amount,0)) uk_refund_amount
                FROM tw_refunds_daily WHERE date BETWEEN $1::date AND $2::date GROUP BY brand, date`, params: [start, end], fallback: emptyRows },
        // NOBL Air subscriber state for "Net Subscriber Adds": new = created in window,
        // cancelled = cancelled_on in window. Net = new - cancelled.
        { sql: `SELECT TO_CHAR(created_at::date,'YYYY-MM-DD') d, 'new'::text kind FROM nobl_air_subscribers WHERE created_at::date BETWEEN $1::date AND $2::date UNION ALL SELECT TO_CHAR(cancelled_on::date,'YYYY-MM-DD') d, 'canc'::text kind FROM nobl_air_subscribers WHERE cancelled_on IS NOT NULL AND cancelled_on::date BETWEEN $1::date AND $2::date`, params: [start, end], fallback: emptyRows },
        // FLO App churn (iap_subscription_daily) — Monthly Churn = cancelled / active
        // (apple + google summed). Active is a snapshot; we use the period-end value.
        { sql: `SELECT TO_CHAR(date,'YYYY-MM-DD') d, SUM(active_subs) act, SUM(new_subs) ns, SUM(cancelled_subs) cs FROM iap_subscription_daily WHERE brand='FLO' AND date BETWEEN $1::date AND $2::date GROUP BY date`, params: [start, end], fallback: emptyRows },
        { sql: `SELECT TO_CHAR(date,'YYYY-MM-DD') d, SUM(revenue_usd) rev FROM iap_daily WHERE brand='FLO' AND product_id='ALL' AND date BETWEEN $1::date AND $2::date GROUP BY date`, params: [start, end], fallback: emptyRows },
        // FLO Returning Customer Revenue % — for each FLO order, mark "returning" iff
        // the same customer_email had ANY earlier FLO order. Aggregated daily so the
        // metric can be summed for weekly/quarterly buckets.
        { sql: `WITH ranked AS (
          SELECT brand, customer_email, date_key, total_price,
                 ROW_NUMBER() OVER (PARTITION BY brand, lower(customer_email) ORDER BY created_at) AS rn
          FROM shopify_orders_raw
          WHERE brand IN ('NOBL','FLO') AND customer_email IS NOT NULL AND customer_email <> ''
        )
        SELECT brand, TO_CHAR(date_key,'YYYY-MM-DD') d,
               SUM(total_price) total_rev,
               SUM(CASE WHEN rn > 1 THEN total_price ELSE 0 END) returning_rev
        FROM ranked
        WHERE date_key BETWEEN $1::date AND $2::date
        GROUP BY brand, date_key`, params: [start, end], fallback: emptyRows },
        { sql: `SELECT brand, TO_CHAR(date_key,'YYYY-MM-DD') d, COUNT(*)::int orders, SUM(total_price) revenue, SUM(total_discounts) discounts FROM shopify_orders_raw WHERE date_key BETWEEN $1::date AND $2::date GROUP BY brand, date_key`, params: [start, end], fallback: emptyRows },
        { sql: `SELECT brand, TO_CHAR(date_key,'YYYY-MM-DD') d,
                  COUNT(*) FILTER (WHERE UPPER(COALESCE(shipping_country,'')) IN ('US','USA','UNITED STATES','UNITED STATES OF AMERICA'))::int us_orders,
                  COUNT(*) FILTER (WHERE UPPER(COALESCE(shipping_country,'')) IN ('CA','CANADA'))::int ca_orders,
                  COUNT(*) FILTER (WHERE UPPER(COALESCE(shipping_country,'')) IN ('AU','AUS','AUSTRALIA'))::int au_orders,
                  COUNT(*) FILTER (WHERE UPPER(COALESCE(shipping_country,'')) IN ('GB','UK','UNITED KINGDOM'))::int uk_orders,
                  COUNT(*) FILTER (WHERE UPPER(COALESCE(shipping_country,'')) IN ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','CH','NO'))::int eu_orders
                FROM shopify_orders_raw
                WHERE date_key BETWEEN $1::date AND $2::date
                GROUP BY brand, date_key`, params: [start, end], fallback: emptyRows },
        { sql: `SELECT TO_CHAR(date,'YYYY-MM-DD') d, brand, LOWER(product_line) product_line, SUM(spend) spend, SUM(new_cust_orders) orders FROM tw_product_daily WHERE date BETWEEN $1::date AND $2::date GROUP BY date, brand, product_line`, params: [start, end], fallback: emptyRows },
        { sql: `SELECT TO_CHAR(created_at::date,'YYYY-MM-DD') d,
                  COUNT(*) app_units,
                  0 mature,
                  0 converted
                FROM flo_appstle_subscribers
                WHERE created_at::date BETWEEN $1::date AND $2::date
                GROUP BY created_at::date`, params: [start, end], fallback: emptyRows },
        { sql: `SELECT TO_CHAR((created_at::date + INTERVAL '14 days')::date,'YYYY-MM-DD') d,
                  COUNT(*) FILTER (WHERE is_mature) mature,
                  COUNT(*) FILTER (WHERE is_mature AND is_converted) converted
                FROM flo_appstle_subscribers
                WHERE (created_at::date + INTERVAL '14 days')::date BETWEEN $1::date AND $2::date
                GROUP BY (created_at::date + INTERVAL '14 days')::date`, params: [start, end], fallback: emptyRows },
        { sql: `SELECT TO_CHAR(date,'YYYY-MM-DD') d,
                  SUM(net_revenue) total_product_rev,
                  SUM(net_revenue) FILTER (WHERE sku_prefix IN ('ALLB1','ALLB2','ALLB3','EPB1','EPB3')) bundle_rev
                FROM shopify_product_daily
                WHERE brand='NOBL' AND date BETWEEN $1::date AND $2::date
                GROUP BY date`, params: [start, end], fallback: emptyRows },
        // NOBL Bundle CM1 % — pre-computed per-day from TW orders_table (see syncTWBundleCm1).
        { sql: `SELECT TO_CHAR(date,'YYYY-MM-DD') d,
                  bundle_revenue, bundle_cogs, cm1_pct
                FROM tw_bundle_cm1_daily
                WHERE brand='NOBL' AND date BETWEEN $1::date AND $2::date`, params: [start, end], fallback: emptyRows },
        { sql: `SELECT TO_CHAR(date,'YYYY-MM-DD') d, sku_prefix, product_title, SUM(net_revenue) net_revenue
                FROM shopify_product_daily
                WHERE brand='FLO' AND date BETWEEN $1::date AND $2::date
                GROUP BY date, sku_prefix, product_title`, params: [start, end], fallback: emptyRows },
      ]);

      const nMap = {}, fMap = {}, ngeo = {}, fgeo = {}, aMap = {}, airRegionByDay = {};
      const opsN = {}, opsF = {}, csN = {}, csF = {}, cbN = {}, cbF = {}, metaN = {}, metaF = {}, twAdsN = {}, twAdsF = {}, testRoasN = {}, testRoasF = {}, klavN = {}, klavF = {}, twEmailN = {}, twEmailF = {}, twSessN = {}, twSessF = {}, twRefundN = {}, twRefundF = {};
      const airSubsByDay = {}; // d → {new, canc}
      const floIapSubsByDay = {}; // d → {act, ns, cs}
      const floIapRevByDay = {}; // d → app revenue
      const returnByDay = {}; // d → brand → {total_rev, returning_rev}
      const shopifyStatsByDay = {}; // d → brand → {orders,revenue,discounts}
      const shopifyRegionOrdersByDay = {}; // d → brand → {US,CA,AU,UK,EU}
      const productByDay = {}; // d → brand → product_line → {spend, orders}
      const floAppByDay = {}; // d → {app_units,mature,converted}; app_units by signup date, TTP by maturity date
      const noblBundleByDay = {}; // d → {bundle_rev,total_product_rev}
      const floHardwareByDay = {}; // d → {appSubRev, portableRev, homeStudioRev}
      for (const r of noblSum.rows) nMap[r.d] = { rev: num(r.rev), gmd: num(r.gmd), spend: num(r.spend), orders: num(r.orders), amazon: num(r.amazon), tsales: num(r.tsales), refund: num(r.refund) };
      for (const r of floSum.rows)  fMap[r.d] = { rev: num(r.rev), gmd: num(r.gmd), spend: num(r.spend), orders: num(r.orders), amazon: num(r.amazon), tsales: num(r.tsales), refund: num(r.refund) };
      for (const r of noblGeo.rows) { (ngeo[r.d] = ngeo[r.d] || {})[r.region] = { rev: num(r.rev), spend: num(r.spend) }; }
      for (const r of floGeo.rows)  { (fgeo[r.d] = fgeo[r.d] || {})[r.region] = { rev: num(r.rev), spend: num(r.spend) }; }
      for (const r of air.rows)     aMap[r.d] = { to: num(r.to_), ao: num(r.ao), conv: num(r.conv), mat: num(r.mat), arev: num(r.arev) };
      for (const r of airRegion.rows) {
        const row = (airRegionByDay[r.d] = airRegionByDay[r.d] || {});
        row[r.region_key] = { to: num(r.total_orders), ao: num(r.air_orders), conv: num(r.converted_count), mat: num(r.mature_count) };
      }
      for (const r of ops.rows) {
        const dest = r.brand === 'NOBL' ? opsN : (r.brand === 'FLO' ? opsF : null);
        if (dest) dest[r.d] = {
          oc: num(r.oc), asc: r.asc_ == null ? null : num(r.asc_), ouf: num(r.ouf), ouf24: num(r.ouf24), us_ouf: num(r.us_ouf), ca_ouf: num(r.ca_ouf), au_ouf: num(r.au_ouf), uk_ouf: num(r.uk_ouf), us_ouf24: num(r.us_ouf24), uk_ouf24: num(r.uk_ouf24),
          afh: r.afh == null ? null : num(r.afh), asdh: r.asdh == null ? null : num(r.asdh),
          ca_ttf: r.ca_ttf == null ? null : num(r.ca_ttf), au_ttf: r.au_ttf == null ? null : num(r.au_ttf), uk_ttf: r.uk_ttf == null ? null : num(r.uk_ttf),
        };
      }
      for (const r of cs.rows) {
        const dest = r.brand === 'NOBL' ? csN : (r.brand === 'FLO' ? csF : null);
        if (dest) dest[r.d] = {
          tt: num(r.tt), sm: num(r.sm), us: num(r.us), ca: num(r.ca), au: num(r.au), uk: num(r.uk), closed: num(r.closed),
          frCount: num(r.fr_count), frSum: num(r.fr_sum),
          frrCount: num(r.frr_count), frrSum: num(r.frr_sum),
          csatCount: num(r.csat_count), csatSum: num(r.csat_sum),
          recoveryRev: num(r.recovery_rev), wrongOrder: num(r.wrong_order),
          themes: r.top_themes || null,
        };
      }
      for (const r of disputes.rows) {
        const dest = r.brand === 'NOBL' ? cbN : (r.brand === 'FLO' ? cbF : null);
        if (dest) dest[r.d] = { cb: num(r.cb), us: num(r.us_cb), ca: num(r.ca_cb), au: num(r.au_cb), uk: num(r.uk_cb) };
      }
      for (const r of meta.rows) {
        const dest = r.brand === 'NOBL' ? metaN : (r.brand === 'FLO' ? metaF : null);
        if (dest) dest[r.d] = { p: num(r.p), lc: num(r.lc), c: num(r.c), s: num(r.s), whitelist: num(r.whitelist_spend), test: num(r.test_spend), bof: num(r.bof_spend) };
      }
      for (const r of twAds.rows) {
        const dest = r.brand === 'NOBL' ? twAdsN : (r.brand === 'FLO' ? twAdsF : null);
        if (dest) dest[r.d] = { p: num(r.p), lc: num(r.lc), c: num(r.c), s: num(r.s), test: num(r.test_spend), bof: num(r.bof_spend) };
      }
      for (const r of twFunnel.rows) {
        const dest = r.brand === 'NOBL' ? twAdsN : (r.brand === 'FLO' ? twAdsF : null);
        if (dest) {
          dest[r.d] = dest[r.d] || { p: 0, lc: 0, c: 0, s: 0, test: 0, bof: 0 };
          dest[r.d].s = num(r.s);
          dest[r.d].bof = num(r.bof_spend);
        }
      }
      for (const r of metaTestRoas.rows) {
        const dest = r.brand === 'NOBL' ? testRoasN : (r.brand === 'FLO' ? testRoasF : null);
        if (dest) dest[r.d] = {
          taylor: { rev: num(r.rev_taylor), spend: num(r.sp_taylor) },
          franz: { rev: num(r.rev_franz), spend: num(r.sp_franz) },
          luke: { rev: num(r.rev_luke), spend: num(r.sp_luke) },
          chris: { rev: num(r.rev_chris), spend: num(r.sp_chris) },
        };
      }
      // Per-day strategist spend (NOBL) and FLO Chris-by-product spend/purchases.
      const stratN = {}, stratF = {};
      for (const r of metaStrat.rows) {
        const row = {
          sp_taylor: num(r.sp_taylor), sp_franz: num(r.sp_franz),
          sp_luke:   num(r.sp_luke),   sp_chris: num(r.sp_chris),
          sp_portable: num(r.sp_portable), pu_portable: num(r.pu_portable),
          sp_studio:   num(r.sp_studio),   pu_studio:   num(r.pu_studio),
          sp_home:     num(r.sp_home),     pu_home:     num(r.pu_home),
        };
        if (r.brand === 'NOBL') stratN[r.d] = row;
        else if (r.brand === 'FLO') stratF[r.d] = row;
      }
      for (const r of klav.rows) {
        const dest = r.brand === 'NOBL' ? klavN : (r.brand === 'FLO' ? klavF : null);
        if (dest) dest[r.d] = { r: num(r.r) };
      }
      for (const r of twEmailSms.rows) {
        const dest = r.brand === 'NOBL' ? twEmailN : (r.brand === 'FLO' ? twEmailF : null);
        if (dest) dest[r.d] = { revenue: num(r.revenue), sms: num(r.sms_revenue), email: num(r.email_revenue), flow: num(r.flow_revenue), campaign: num(r.campaign_revenue), unsubscribes: num(r.unsubscribes), delivered: num(r.delivered) };
      }
      for (const r of twSessions.rows) {
        const dest = r.brand === 'NOBL' ? twSessN : (r.brand === 'FLO' ? twSessF : null);
        if (dest) dest[r.d] = { dau: num(r.dau), mau: num(r.mau), sessions: num(r.sessions), dau_mau: r.dau_mau_pct == null ? null : num(r.dau_mau_pct) };
      }
      for (const r of twRefunds.rows) {
        const dest = r.brand === 'NOBL' ? twRefundN : (r.brand === 'FLO' ? twRefundF : null);
        if (dest) dest[r.d] = { refund: num(r.refund_amount), us: num(r.us_refund_amount), ca: num(r.ca_refund_amount), au: num(r.au_refund_amount), uk: num(r.uk_refund_amount) };
      }
      for (const r of airSubs.rows) {
        const bucket = (airSubsByDay[r.d] = airSubsByDay[r.d] || { new: 0, canc: 0 });
        if (r.kind === 'new') bucket.new += 1; else bucket.canc += 1;
      }
      for (const r of floIapSubs.rows) floIapSubsByDay[r.d] = { act: num(r.act), ns: num(r.ns), cs: num(r.cs) };
      for (const r of floIapRev.rows) floIapRevByDay[r.d] = num(r.rev);
      for (const r of returning.rows) {
        const day = (returnByDay[r.d] = returnByDay[r.d] || {});
        day[r.brand] = { total_rev: num(r.total_rev), returning_rev: num(r.returning_rev) };
      }
      for (const r of shopifyStats.rows) {
        const day = (shopifyStatsByDay[r.d] = shopifyStatsByDay[r.d] || {});
        day[r.brand] = { orders: num(r.orders), revenue: num(r.revenue), discounts: num(r.discounts) };
      }
      for (const r of shopifyRegionStats.rows) {
        const day = (shopifyRegionOrdersByDay[r.d] = shopifyRegionOrdersByDay[r.d] || {});
        day[r.brand] = { US: num(r.us_orders), CA: num(r.ca_orders), AU: num(r.au_orders), UK: num(r.uk_orders), EU: num(r.eu_orders) };
      }
      for (const r of products.rows) {
        const brandMap = (productByDay[r.d] = productByDay[r.d] || {});
        const lineMap = (brandMap[r.brand] = brandMap[r.brand] || {});
        lineMap[r.product_line] = { spend: num(r.spend), orders: num(r.orders) };
      }
      for (const r of floAppstle.rows) floAppByDay[r.d] = { app_units: num(r.app_units), mature: num(r.mature), converted: num(r.converted) };
      for (const r of floAppstleTtp.rows) {
        const bucket = (floAppByDay[r.d] = floAppByDay[r.d] || { app_units: 0, mature: 0, converted: 0 });
        bucket.mature += num(r.mature);
        bucket.converted += num(r.converted);
      }
      for (const r of noblBundle.rows) noblBundleByDay[r.d] = { bundle_rev: num(r.bundle_rev), total_product_rev: num(r.total_product_rev) };
      const noblBundleCm1ByDay = {};
      for (const r of noblBundleCm1.rows) noblBundleCm1ByDay[r.d] = { rev: num(r.bundle_revenue), cogs: num(r.bundle_cogs), cm1: r.cm1_pct == null ? null : num(r.cm1_pct) };
      const floProductBucket = (sku, title) => {
        const s = `${sku || ''} ${title || ''}`.toLowerCase();
        if (/app|subscription|unlimited flo access/.test(s)) return 'app';
        if (/portable|flor1|refpi/.test(s)) return 'portable';
        if (/home reformer|homerb|studio reformer|woodenrb|metal/.test(s)) return 'homeStudio';
        return null;
      };
      for (const r of floProductSales.rows) {
        const bucket = floProductBucket(r.sku_prefix, r.product_title);
        if (!bucket) continue;
        const row = (floHardwareByDay[r.d] = floHardwareByDay[r.d] || { appSubRev: 0, portableRev: 0, homeStudioRev: 0 });
        if (bucket === 'app') row.appSubRev += num(r.net_revenue);
        else if (bucket === 'portable') row.portableRev += num(r.net_revenue);
        else if (bucket === 'homeStudio') row.homeStudioRev += num(r.net_revenue);
      }

      // Cap at yesterday in the reporting timezone so current-day partial rows
      // (especially TW live summary rows) do not drive the visible matrix date.
      // KPI_PULSE_CUTOFF_DATE can be set for a manual audit/backfill override.
      const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const cutoff = process.env.KPI_PULSE_CUTOFF_DATE || (() => { const [y, m, d] = todayET.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); })();
      const allDates = Array.from(new Set([
        ...Object.keys(nMap), ...Object.keys(fMap), ...Object.keys(ngeo), ...Object.keys(fgeo), ...Object.keys(aMap), ...Object.keys(airRegionByDay),
        ...Object.keys(opsN), ...Object.keys(opsF), ...Object.keys(csN), ...Object.keys(csF), ...Object.keys(cbN), ...Object.keys(cbF),
        ...Object.keys(metaN), ...Object.keys(metaF), ...Object.keys(twAdsN), ...Object.keys(twAdsF), ...Object.keys(testRoasN), ...Object.keys(testRoasF),
        ...Object.keys(twSessN), ...Object.keys(twSessF),
        ...Object.keys(floIapSubsByDay), ...Object.keys(floIapRevByDay),
        ...Object.keys(returnByDay), ...Object.keys(shopifyStatsByDay), ...Object.keys(shopifyRegionOrdersByDay), ...Object.keys(twRefundN), ...Object.keys(twRefundF), ...Object.keys(productByDay),
        ...Object.keys(noblBundleByDay), ...Object.keys(floHardwareByDay),
      ])).filter(d => d <= cutoff).sort();
      const latest = allDates[allDates.length - 1] || cutoff;
      const div = (x, y) => (y > 0 ? x / y : null);

      // Helpers for the rollups: re-average a per-day cost across days that have it,
      // take MAX of a snapshot count (so weekly/quarterly are "peak", not summed),
      // weight by orders when relevant.
      function avgOf(values) { const f = values.filter((v) => v != null); return f.length ? f.reduce((s, v) => s + v, 0) / f.length : null; }
      function maxOf(values) { const f = values.filter((v) => v != null); return f.length ? Math.max(...f) : null; }
      function lastNonNull(values) { for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] != null) return values[i]; return null; }
      const emptyGeo = () => ({ US:{rev:0,spend:0}, CA:{rev:0,spend:0}, AU:{rev:0,spend:0}, EU:{rev:0,spend:0}, UK:{rev:0,spend:0} });
      const geoKey = (region) => ({ AUS: 'AU', AUSTRALIA: 'AU', USA: 'US', UNITED_STATES: 'US', UNITEDKINGDOM: 'UK', GB: 'UK' }[String(region || '').toUpperCase().replace(/[^A-Z]/g, '')] || String(region || '').toUpperCase());
      function addGeo(dest, dayGeo) {
        if (!dayGeo) return;
        for (const [region, row] of Object.entries(dayGeo)) {
          const key = geoKey(region);
          if (!dest[key]) continue;
          dest[key].rev += row.rev;
          dest[key].spend += row.spend;
        }
      }

      function metricsFor(dates) {
        const a = { n:{rev:0,gmd:0,spend:0,orders:0,amazon:0,tsales:0,refund:0}, f:{rev:0,gmd:0,spend:0,orders:0,amazon:0,tsales:0,refund:0}, nGeo: emptyGeo(), fGeo: emptyGeo(), air:{to:0,ao:0,conv:0,mat:0,arev:0} };
        let hasN = false, hasF = false;
        // Ops aggregates
        const opsNcost = [], opsFcost = [], opsNuf = [], opsFuf = [], opsNuf24 = [], opsFuf24 = [], opsNusUf = [], opsFusUf = [], opsNcaUf = [], opsFcaUf = [], opsNauUf = [], opsFauUf = [], opsNukUf = [], opsFukUf = [], opsNusUf24 = [], opsFusUf24 = [], opsNukUf24 = [], opsFukUf24 = [];
        const opsNfulfillDays = [], opsFfulfillDays = [], opsNshipDays = [], opsFshipDays = [], opsNcaTtf = [], opsFcaTtf = [], opsNauTtf = [], opsFauTtf = [], opsNukTtf = [], opsFukTtf = [];
        // CS aggregates
        let csNtotal = 0, csFtotal = 0, csNseen = false, csFseen = false;
        let csNus = 0, csNca = 0, csNau = 0, csNuk = 0, csNclosed = 0;
        let csFus = 0, csFca = 0, csFau = 0, csFuk = 0, csFclosed = 0;
        // Extended CS aggregates — FRT, Csat, recovery, wrong-order, themes.
        let csNfrCount = 0, csNfrSum = 0, csNfrrCount = 0, csNfrrSum = 0;
        let csNcsatCount = 0, csNcsatSum = 0, csNrecoveryRev = 0, csNwrongOrder = 0;
        let csFfrCount = 0, csFfrSum = 0, csFfrrCount = 0, csFfrrSum = 0;
        let csFcsatCount = 0, csFcsatSum = 0, csFrecoveryRev = 0, csFwrongOrder = 0;
        const csNthemes = [], csFthemes = [];
        let cbNtotal = 0, cbFtotal = 0, cbNseen = false, cbFseen = false;
        let cbNus = 0, cbNca = 0, cbNau = 0, cbNuk = 0;
        let cbFus = 0, cbFca = 0, cbFau = 0, cbFuk = 0;
        // Meta aggregates
        const m = { n:{p:0,lc:0,c:0,s:0,whitelist:0,test:0,bof:0}, f:{p:0,lc:0,c:0,s:0,whitelist:0,test:0,bof:0} };
        let hasMetaN = false, hasMetaF = false;
        // Triple Whale Meta ads aggregates (CVR / TOF vs BOF source of truth).
        const tw = { n:{p:0,lc:0,c:0,s:0,test:0,bof:0}, f:{p:0,lc:0,c:0,s:0,test:0,bof:0} };
        let hasTwAdsN = false, hasTwAdsF = false;
        // Strategist aggregates (NOBL): per-code spend totals over the window.
        const stratNobl = { taylor: 0, franz: 0, luke: 0, chris: 0 };
        const testRoasNobl = { taylor: { rev: 0, spend: 0 }, franz: { rev: 0, spend: 0 }, luke: { rev: 0, spend: 0 }, chris: { rev: 0, spend: 0 } };
        // FLO: Chris spend (for Share of Spend), and product-level spend/purchases.
        const stratFlo  = { chris: 0, portableSpend: 0, portablePurch: 0, studioSpend: 0, studioPurch: 0, homeSpend: 0, homePurch: 0 };
        // Account spend totals (denominators for Share of Spend) come from the
        // `meta` aggregate above (m.n.s and m.f.s) — that's already summed across
        // all ads, so account-total == ad-level-sum, same as the GAS script's
        // /insights level=account.
        // NOTE: Klaviyo `revenue` in klaviyo_daily is total brand revenue (a snapshot
        // pulled per day), NOT flow/campaign-attributed revenue, so it can't drive
        // a "Retention Rev %" KPI. Kept here so the data is collected but not
        // exposed as a KPI; needs a flow-attributed-revenue Klaviyo ETL upgrade.
        let klavNrev = 0, klavFrev = 0, klavNseen = false, klavFseen = false; // eslint-disable-line no-unused-vars
        let twEmailNrev = 0, twSmsNrev = 0, twEmailOnlyNrev = 0, twFlowNrev = 0, twCampaignNrev = 0, twUnsubN = 0, twDeliveredN = 0, twEmailNseen = false;
        let twEmailFrev = 0, twSmsFrev = 0, twEmailOnlyFrev = 0, twFlowFrev = 0, twCampaignFrev = 0, twUnsubF = 0, twDeliveredF = 0, twEmailFseen = false;
        const sessNratios = [], sessFratios = [], sessNmaus = [], sessFmaus = [];
        let sessNdau = 0, sessFdau = 0, sessNsessions = 0, sessFsessions = 0, sessNseen = false, sessFseen = false;
        let twRefundNseen = false, twRefundFseen = false, twRefundNdenom = 0, twRefundFdenom = 0;
        const twRefundNreg = { US: 0, CA: 0, AU: 0, UK: 0 }, twRefundFreg = { US: 0, CA: 0, AU: 0, UK: 0 };
        // Air subs in window
        let airNew = 0, airCanc = 0;
        // FLO IAP subs (snapshot=last act, sum new/cs)
        const floIapActs = []; let floIapNs = 0, floIapCs = 0, floIapRevenue = 0;
        let floAppUnits = 0, floAppMature = 0, floAppConverted = 0;
        // Returning-customer revenue
        let noblRetTotal = 0, noblRetReturning = 0, floRetTotal = 0, floRetReturning = 0;
        const airReg = {
          INTL: { to: 0, ao: 0, conv: 0, mat: 0 },
          AUS: { to: 0, ao: 0, conv: 0, mat: 0 },
          CA: { to: 0, ao: 0, conv: 0, mat: 0 },
          UK: { to: 0, ao: 0, conv: 0, mat: 0 },
        };
        let noblBundleRev = 0, noblProductRev = 0;
        // Bundle CM1 %: aggregate revenue + COGS across the period then compute ratio.
        let bundleCm1Rev = 0, bundleCm1Cogs = 0, bundleCm1Seen = false;
        let floAppSubRev = 0, floPortableRev = 0, floHomeStudioRev = 0;
        const shop = { n: { orders: 0, revenue: 0, discounts: 0 }, f: { orders: 0, revenue: 0, discounts: 0 } };
        const shopRegion = { n: { US: 0, CA: 0, AU: 0, UK: 0, EU: 0 }, f: { US: 0, CA: 0, AU: 0, UK: 0, EU: 0 } };
        const cbShopRegion = { n: { US: 0, CA: 0, AU: 0, UK: 0, EU: 0 }, f: { US: 0, CA: 0, AU: 0, UK: 0, EU: 0 } };

        for (const d of dates) {
          const n = nMap[d]; if (n) { hasN = true; a.n.rev+=n.rev; a.n.gmd+=n.gmd; a.n.spend+=n.spend; a.n.orders+=n.orders; a.n.amazon+=n.amazon; a.n.tsales+=n.tsales; }
          const f = fMap[d]; if (f) { hasF = true; a.f.rev+=f.rev; a.f.gmd+=f.gmd; a.f.spend+=f.spend; a.f.orders+=f.orders; a.f.amazon+=f.amazon; a.f.tsales+=f.tsales; }
          const sd = shopifyStatsByDay[d];
          if (sd?.NOBL) { shop.n.orders += sd.NOBL.orders; shop.n.revenue += sd.NOBL.revenue; shop.n.discounts += sd.NOBL.discounts; }
          if (sd?.FLO)  { shop.f.orders += sd.FLO.orders;  shop.f.revenue += sd.FLO.revenue;  shop.f.discounts += sd.FLO.discounts; }
          const srd = shopifyRegionOrdersByDay[d];
          if (srd?.NOBL) { for (const k of Object.keys(cbShopRegion.n)) cbShopRegion.n[k] += srd.NOBL[k] || 0; }
          if (srd?.FLO)  { for (const k of Object.keys(cbShopRegion.f)) cbShopRegion.f[k] += srd.FLO[k] || 0; }
          addGeo(a.nGeo, ngeo[d]);
          addGeo(a.fGeo, fgeo[d]);
          const ai = aMap[d]; if (ai){a.air.to+=ai.to;a.air.ao+=ai.ao;a.air.conv+=ai.conv;a.air.mat+=ai.mat;a.air.arev+=ai.arev;}

          const on = opsN[d]; if (on) { opsNcost.push(on.asc); opsNuf.push(on.ouf); opsNuf24.push(on.ouf24); opsNusUf.push(on.us_ouf); opsNcaUf.push(on.ca_ouf); opsNauUf.push(on.au_ouf); opsNukUf.push(on.uk_ouf); opsNusUf24.push(on.us_ouf24); opsNukUf24.push(on.uk_ouf24); opsNfulfillDays.push(on.afh == null ? null : on.afh / 24); opsNshipDays.push(on.asdh == null ? null : on.asdh / 24); opsNcaTtf.push(on.ca_ttf); opsNauTtf.push(on.au_ttf); opsNukTtf.push(on.uk_ttf); }
          const of_ = opsF[d]; if (of_) { opsFcost.push(of_.asc); opsFuf.push(of_.ouf); opsFuf24.push(of_.ouf24); opsFusUf.push(of_.us_ouf); opsFcaUf.push(of_.ca_ouf); opsFauUf.push(of_.au_ouf); opsFukUf.push(of_.uk_ouf); opsFusUf24.push(of_.us_ouf24); opsFukUf24.push(of_.uk_ouf24); opsFfulfillDays.push(of_.afh == null ? null : of_.afh / 24); opsFshipDays.push(of_.asdh == null ? null : of_.asdh / 24); opsFcaTtf.push(of_.ca_ttf); opsFauTtf.push(of_.au_ttf); opsFukTtf.push(of_.uk_ttf); }

          const cn = csN[d]; if (cn) {
            csNtotal += cn.tt; csNus += cn.us; csNca += cn.ca; csNau += cn.au; csNuk += cn.uk; csNclosed += cn.closed; csNseen = true;
            csNfrCount += cn.frCount; csNfrSum += cn.frSum;
            csNfrrCount += cn.frrCount; csNfrrSum += cn.frrSum;
            csNcsatCount += cn.csatCount; csNcsatSum += cn.csatSum;
            csNrecoveryRev += cn.recoveryRev; csNwrongOrder += cn.wrongOrder;
            if (cn.themes) csNthemes.push(cn.themes);
            if (srd?.NOBL) { for (const k of Object.keys(shopRegion.n)) shopRegion.n[k] += srd.NOBL[k] || 0; }
          }
          const cf_ = csF[d]; if (cf_) {
            csFtotal += cf_.tt; csFus += cf_.us; csFca += cf_.ca; csFau += cf_.au; csFuk += cf_.uk; csFclosed += cf_.closed; csFseen = true;
            csFfrCount += cf_.frCount; csFfrSum += cf_.frSum;
            csFfrrCount += cf_.frrCount; csFfrrSum += cf_.frrSum;
            csFcsatCount += cf_.csatCount; csFcsatSum += cf_.csatSum;
            csFrecoveryRev += cf_.recoveryRev; csFwrongOrder += cf_.wrongOrder;
            if (cf_.themes) csFthemes.push(cf_.themes);
            if (srd?.FLO) { for (const k of Object.keys(shopRegion.f)) shopRegion.f[k] += srd.FLO[k] || 0; }
          }
          const cbn = cbN[d]; if (cbn) { cbNtotal += cbn.cb; cbNus += cbn.us; cbNca += cbn.ca; cbNau += cbn.au; cbNuk += cbn.uk; cbNseen = true; }
          const cbf = cbF[d]; if (cbf) { cbFtotal += cbf.cb; cbFus += cbf.us; cbFca += cbf.ca; cbFau += cbf.au; cbFuk += cbf.uk; cbFseen = true; }

          const mn = metaN[d]; if (mn) { hasMetaN = true; m.n.p += mn.p; m.n.lc += mn.lc; m.n.c += mn.c; m.n.s += mn.s; m.n.whitelist += mn.whitelist; m.n.test += mn.test; m.n.bof += mn.bof; }
          const mf = metaF[d]; if (mf) { hasMetaF = true; m.f.p += mf.p; m.f.lc += mf.lc; m.f.c += mf.c; m.f.s += mf.s; m.f.whitelist += mf.whitelist; m.f.test += mf.test; m.f.bof += mf.bof; }

          const tn = twAdsN[d]; if (tn) { hasTwAdsN = true; tw.n.p += tn.p; tw.n.lc += tn.lc; tw.n.c += tn.c; tw.n.s += tn.s; tw.n.test += tn.test; tw.n.bof += tn.bof; }
          const tf = twAdsF[d]; if (tf) { hasTwAdsF = true; tw.f.p += tf.p; tw.f.lc += tf.lc; tw.f.c += tf.c; tw.f.s += tf.s; tw.f.test += tf.test; tw.f.bof += tf.bof; }

          const sn = stratN[d]; if (sn) {
            stratNobl.taylor += sn.sp_taylor;
            stratNobl.franz  += sn.sp_franz;
            stratNobl.luke   += sn.sp_luke;
            stratNobl.chris  += sn.sp_chris;
          }
          const rn = testRoasN[d]; if (rn) {
            for (const k of Object.keys(testRoasNobl)) {
              testRoasNobl[k].rev += rn[k]?.rev || 0;
              testRoasNobl[k].spend += rn[k]?.spend || 0;
            }
          }
          const sf = stratF[d]; if (sf) {
            stratFlo.chris         += sf.sp_chris;
            stratFlo.portableSpend += sf.sp_portable;
            stratFlo.portablePurch += sf.pu_portable;
            stratFlo.studioSpend   += sf.sp_studio;
            stratFlo.studioPurch   += sf.pu_studio;
            stratFlo.homeSpend     += sf.sp_home;
            stratFlo.homePurch     += sf.pu_home;
          }

          const kn = klavN[d]; if (kn) { klavNrev += kn.r; klavNseen = true; }
          const kf = klavF[d]; if (kf) { klavFrev += kf.r; klavFseen = true; }

          const ten = twEmailN[d]; if (ten) { twEmailNrev += ten.revenue; twSmsNrev += ten.sms; twEmailOnlyNrev += ten.email; twFlowNrev += ten.flow; twCampaignNrev += ten.campaign; twUnsubN += ten.unsubscribes; twDeliveredN += ten.delivered; twEmailNseen = true; }
          const tef = twEmailF[d]; if (tef) { twEmailFrev += tef.revenue; twSmsFrev += tef.sms; twEmailOnlyFrev += tef.email; twFlowFrev += tef.flow; twCampaignFrev += tef.campaign; twUnsubF += tef.unsubscribes; twDeliveredF += tef.delivered; twEmailFseen = true; }
          const tsn = twSessN[d]; if (tsn) { sessNdau += tsn.dau; sessNsessions += tsn.sessions; sessNmaus.push(tsn.mau || null); sessNratios.push(tsn.dau_mau); sessNseen = true; }
          const tsf = twSessF[d]; if (tsf) { sessFdau += tsf.dau; sessFsessions += tsf.sessions; sessFmaus.push(tsf.mau || null); sessFratios.push(tsf.dau_mau); sessFseen = true; }
          const trn = twRefundN[d]; if (trn) { a.n.refund += trn.refund; twRefundNdenom += nMap[d]?.rev || 0; twRefundNreg.US += trn.us; twRefundNreg.CA += trn.ca; twRefundNreg.AU += trn.au; twRefundNreg.UK += trn.uk; twRefundNseen = true; }
          const trf = twRefundF[d]; if (trf) { a.f.refund += trf.refund; twRefundFdenom += fMap[d]?.rev || 0; twRefundFreg.US += trf.us; twRefundFreg.CA += trf.ca; twRefundFreg.AU += trf.au; twRefundFreg.UK += trf.uk; twRefundFseen = true; }

          const as = airSubsByDay[d]; if (as) { airNew += as.new; airCanc += as.canc; }
          const fi = floIapSubsByDay[d]; if (fi) { floIapActs.push(fi.act); floIapNs += fi.ns; floIapCs += fi.cs; }
          floIapRevenue += floIapRevByDay[d] || 0;
          const fa = floAppByDay[d]; if (fa) { floAppUnits += fa.app_units; floAppMature += fa.mature; floAppConverted += fa.converted; }
          const rd = returnByDay[d];
          if (rd?.NOBL) { noblRetTotal += rd.NOBL.total_rev; noblRetReturning += rd.NOBL.returning_rev; }
          if (rd?.FLO) { floRetTotal += rd.FLO.total_rev; floRetReturning += rd.FLO.returning_rev; }
          const ar = airRegionByDay[d];
          if (ar) for (const k of Object.keys(airReg)) if (ar[k]) { airReg[k].to += ar[k].to; airReg[k].ao += ar[k].ao; airReg[k].conv += ar[k].conv; airReg[k].mat += ar[k].mat; }
          const nb = noblBundleByDay[d]; if (nb) { noblBundleRev += nb.bundle_rev; noblProductRev += nb.total_product_rev; }
          const bc = noblBundleCm1ByDay[d]; if (bc) { bundleCm1Rev += bc.rev; bundleCm1Cogs += bc.cogs; bundleCm1Seen = true; }
          const fh = floHardwareByDay[d]; if (fh) { floAppSubRev += fh.appSubRev; floPortableRev += fh.portableRev; floHomeStudioRev += fh.homeStudioRev; }
          const fp = productByDay[d]?.FLO;
          if (fp) {
            // Product fallback for FLO CAC when Chris-coded Meta ads are not product-tagged.
            // FLO product-line convention in tw_product_daily:
            //   portable = Portable Reformer, metal = Home Reformer, wooden = Studio Reformer.
            stratFlo.portableSpend += fp.portable?.spend || 0;
            stratFlo.portablePurch += fp.portable?.orders || 0;
            stratFlo.studioSpend += fp.wooden?.spend || 0;
            stratFlo.studioPurch += fp.wooden?.orders || 0;
            stratFlo.homeSpend += fp.metal?.spend || 0;
            stratFlo.homePurch += fp.metal?.orders || 0;
          }
        }
        const attach = div(a.air.ao, a.air.to), ttp = div(a.air.conv, a.air.mat);

        // Meta CVR — purchases / link_clicks (preferred) or /clicks (fallback).
        const metaCvr = (sum) => sum.lc > 0 ? sum.p / sum.lc : (sum.c > 0 ? sum.p / sum.c : null);
        const tofBofSplit = (sum) => {
          if (!sum?.s || sum.s <= 0) return null;
          const bof = Math.max(0, Math.min(sum.s, sum.bof || 0));
          const tof = Math.max(0, sum.s - bof);
          return `${((tof / sum.s) * 100).toFixed(2)}% / ${((bof / sum.s) * 100).toFixed(2)}%`;
        };
        const pctSplit = (a, b) => {
          const total = a + b;
          if (total <= 0) return null;
          return `${((a / total) * 100).toFixed(2)}% / ${((b / total) * 100).toFixed(2)}%`;
        };
        const regionActivation = (r) => {
          const attachR = div(r.ao, r.to);
          const ttpR = div(r.conv, r.mat);
          return attachR != null && ttpR != null ? attachR * ttpR : null;
        };

        // FLO IAP "active" is a snapshot → take last non-null day in window.
        const floIapAct = lastNonNull(floIapActs);
        // Churn = cancellations in period / active at end of period (raw, per-window).
        const floChurn = (floIapAct && floIapAct > 0) ? floIapCs / floIapAct : null;

        // App Lifetime Value (months) — standard SaaS inverse-churn proxy,
        // normalized to a monthly rate. Bounded to 60 months so daily windows
        // with zero cancellations don't render ∞. Override via kpi_pulse_overrides
        // if Apple/Google reports provide a stricter figure.
        const monthsInWindow = Math.max(1, dates.length) / 30.44;
        const monthlyChurnRate = (floIapAct > 0 && floIapCs > 0)
          ? (floIapCs / floIapAct) / monthsInWindow
          : null;
        const floAppLifetimeMonths = (monthlyChurnRate && monthlyChurnRate > 0)
          ? Math.min(60, 1 / monthlyChurnRate)
          : null;
        // Monthly ARPU (subscriber-months in denominator).
        const floAppArpuMonthly = (floIapAct > 0 && monthsInWindow > 0)
          ? floIapRevenue / (floIapAct * monthsInWindow)
          : null;
        const floAppLtv = (floAppArpuMonthly != null && floAppLifetimeMonths != null)
          ? floAppArpuMonthly * floAppLifetimeMonths
          : null;
        // CAC = FLO Meta spend / new paid subs in window. Proxy — assumes Meta
        // is the dominant paid acquisition channel for FLO app subs.
        const floAppCac = (floIapNs > 0 && m.f.s > 0) ? m.f.s / floIapNs : null;
        const floAppLtvCacRatio = (floAppLtv != null && floAppCac && floAppCac > 0)
          ? floAppLtv / floAppCac
          : null;
        const nSalesBase = a.n.rev;
        const fSalesBase = a.f.rev;
        const nOrderDenom = a.n.orders || shop.n.orders;
        const fOrderDenom = a.f.orders || shop.f.orders;
        const nGeoVals = a.nGeo;
        const fGeoVals = a.fGeo;
        const nMau = lastNonNull(sessNmaus);
        const fMau = lastNonNull(sessFmaus);
        const nDauMau = avgOf(sessNratios);
        const fDauMau = avgOf(sessFratios);
        const floAppAttach = div(floAppUnits, fOrderDenom);
        const floAppTtp = div(floAppConverted, floAppMature);

        return {
          NOBL: {
            mer: div(nSalesBase, a.n.spend), sales: hasN ? nSalesBase : null, aov: div(nSalesBase, a.n.orders),
            amazon_pct: div(a.n.amazon, nSalesBase),
            us_mer: div(nGeoVals.US.rev, nGeoVals.US.spend), ca_mer: div(nGeoVals.CA.rev, nGeoVals.CA.spend), au_mer: div(nGeoVals.AU.rev, nGeoVals.AU.spend), eu_mer: div(nGeoVals.EU.rev, nGeoVals.EU.spend), uk_mer: div(nGeoVals.UK.rev, nGeoVals.UK.spend),
            us_sales_pct: div(nGeoVals.US.rev, nSalesBase), ca_sales_pct: div(nGeoVals.CA.rev, nSalesBase), au_sales_pct: div(nGeoVals.AU.rev, nSalesBase), eu_sales_pct: div(nGeoVals.EU.rev, nSalesBase), uk_sales_pct: div(nGeoVals.UK.rev, nSalesBase),
            site_cvr: sessNseen ? div(nOrderDenom, sessNsessions) : null,
            discounts_pct: div(shop.n.discounts, nSalesBase),
            returning_new_customer_split: pctSplit(noblRetReturning, Math.max(0, noblRetTotal - noblRetReturning)),
            air_rev_pct: div(a.air.arev, nSalesBase), attach, ttp, activation: (attach != null && ttp != null) ? attach * ttp : null,
            intl_activation: regionActivation(airReg.INTL),
            au_activation: regionActivation(airReg.AUS),
            ca_activation: regionActivation(airReg.CA),
            uk_activation: regionActivation(airReg.UK),
            // App engagement Sheet KPIs are app analytics metrics, not web/TW
            // Pixel sessions. Do not fill them from tw_sessions_daily; live app
            // API overlay or explicit verified overrides can supply them.
            dau_mau_stickiness: null,
            sessions_per_mau: null,
            // MAU count — last non-null value across the period from tw_sessions_daily.
            nobl_mau_count: nMau,
            // Phase 2/3 additions
            avg_shipping_cost: avgOf(opsNcost),
            avg_fulfillment_days: avgOf(opsNfulfillDays),
            avg_ship_to_door_days: avgOf(opsNshipDays),
            ca_ttf_days: avgOf(opsNcaTtf),
            au_ttf_days: avgOf(opsNauTtf),
            uk_ttf_days: avgOf(opsNukTtf),
            orders_unfulfilled: maxOf(opsNuf),
            us_orders_unfulfilled: maxOf(opsNusUf),
            ca_orders_unfulfilled: maxOf(opsNcaUf),
            au_orders_unfulfilled: maxOf(opsNauUf),
            uk_orders_unfulfilled: maxOf(opsNukUf),
            orders_unfulfilled_24h: maxOf(opsNuf24),
            us_orders_unfulfilled_24h: maxOf(opsNusUf24),
            uk_orders_unfulfilled_24h: maxOf(opsNukUf24),
            cs_tickets_pct: (csNseen && nOrderDenom > 0) ? csNtotal / nOrderDenom : null,
            cs_tickets_count: csNseen ? csNtotal : null,
            us_cs_tickets_count: csNseen ? csNus : null,
            us_cs_tickets_pct: (csNseen && shopRegion.n.US > 0) ? csNus / shopRegion.n.US : null,
            ca_cs_tickets_count: csNseen ? csNca : null,
            ca_cs_tickets_pct: (csNseen && shopRegion.n.CA > 0) ? csNca / shopRegion.n.CA : null,
            au_cs_tickets_count: csNseen ? csNau : null,
            au_cs_tickets_pct: (csNseen && shopRegion.n.AU > 0) ? csNau / shopRegion.n.AU : null,
            uk_cs_tickets_count: csNseen ? csNuk : null,
            uk_cs_tickets_pct: (csNseen && shopRegion.n.UK > 0) ? csNuk / shopRegion.n.UK : null,
            cs_closed_count: csNseen ? csNclosed : null,
            cs_closed_pct: (csNseen && nOrderDenom > 0) ? csNclosed / nOrderDenom : null,
            // Extended CS metrics — FRT (hours), Csat (avg 1–5), Recovery Rev ($),
            // Wrong Order Rate (% of tickets), and top ticket themes (string).
            // hourly_brand_response_resolution_stats stores durations in ms
            // despite the "SecondsSum" field name; divide by 3.6M for hours.
            first_response_hours: (csNseen && csNfrCount > 0) ? (csNfrSum / csNfrCount) / 3_600_000 : null,
            first_resolution_hours: (csNseen && csNfrrCount > 0) ? (csNfrrSum / csNfrrCount) / 3_600_000 : null,
            csat_avg: (csNseen && csNcsatCount > 0) ? csNcsatSum / csNcsatCount : null,
            recovery_revenue: csNseen ? csNrecoveryRev : null,
            wrong_order_rate: (csNseen && csNtotal > 0) ? csNwrongOrder / csNtotal : null,
            wrong_order_count: csNseen ? csNwrongOrder : null,
            top_ticket_themes: csNthemes[csNthemes.length - 1] || null,
            cb_rate: (cbNseen && nOrderDenom > 0) ? cbNtotal / nOrderDenom : null,
            us_cb_rate: (cbNseen && cbShopRegion.n.US > 0) ? cbNus / cbShopRegion.n.US : null,
            ca_cb_rate: (cbNseen && cbShopRegion.n.CA > 0) ? cbNca / cbShopRegion.n.CA : null,
            au_cb_rate: (cbNseen && cbShopRegion.n.AU > 0) ? cbNau / cbShopRegion.n.AU : null,
            uk_cb_rate: (cbNseen && cbShopRegion.n.UK > 0) ? cbNuk / cbShopRegion.n.UK : null,
            meta_cvr: hasTwAdsN ? metaCvr(tw.n) : null,
            whitelisting_spend_pct: hasMetaN ? div(m.n.whitelist, m.n.s) : null,
            test_spend_pct: hasTwAdsN ? div(tw.n.test, tw.n.s) : null,
            tof_spend_pct: hasTwAdsN ? div(Math.max(0, tw.n.s - tw.n.bof), tw.n.s) : null,
            tof_bof_spend_split: hasTwAdsN ? tofBofSplit(tw.n) : null,
            refund_rate: twRefundNseen ? div(a.n.refund, twRefundNdenom) : null,
            us_refund_rate: twRefundNseen ? div(twRefundNreg.US, nGeoVals.US.rev) : null,
            ca_refund_rate: twRefundNseen ? div(twRefundNreg.CA, nGeoVals.CA.rev) : null,
            au_refund_rate: twRefundNseen ? div(twRefundNreg.AU, nGeoVals.AU.rev) : null,
            uk_refund_rate: twRefundNseen ? div(twRefundNreg.UK, nGeoVals.UK.rev) : null,
            // Retention revenue (TW email_sms_daily = Klaviyo flow + campaign) as
            // share of Gross Sales − Discounts. If leadership tracks a stricter
            // flow-only definition, override via kpi_pulse_overrides.
            retention_rev_pct: twEmailNseen ? div(twEmailNrev, nSalesBase) : null,
            sms_sales_pct:    twEmailNseen ? div(twSmsNrev,   nSalesBase) : null,
            email_sales_pct:  twEmailNseen ? div(twEmailOnlyNrev, nSalesBase) : null,
            email_flow_campaign_split: twEmailNseen ? pctSplit(twFlowNrev, twCampaignNrev) : null,
            unsubscribe_rate: (twEmailNseen && twDeliveredN > 0) ? twUnsubN / twDeliveredN : null,
            new_customer_cac: div(a.n.spend, a.n.orders),
            bundle_rev_pct: div(noblBundleRev, nSalesBase || noblProductRev),
            bundle_cm1_pct: (bundleCm1Seen && bundleCm1Rev > 0) ? (bundleCm1Rev - bundleCm1Cogs) / bundleCm1Rev : null,
            net_sub_adds: airNew - airCanc,
            returning_cust_rev_pct: noblRetTotal > 0 ? noblRetReturning / noblRetTotal : null,
            // Strategist Share of Spend — ad-level spend tagged with the
            // strategist's code, over total NOBL account spend in window.
            sos_taylor: hasMetaN ? div(stratNobl.taylor, m.n.s) : null,
            sos_franz:  hasMetaN ? div(stratNobl.franz,  m.n.s) : null,
            sos_luke:   hasMetaN ? div(stratNobl.luke,   m.n.s) : null,
            sos_chris:  hasMetaN ? div(stratNobl.chris,  m.n.s) : null,
            test_video_roas_taylor: div(testRoasNobl.taylor.rev, testRoasNobl.taylor.spend),
            test_video_roas_franz:  div(testRoasNobl.franz.rev,  testRoasNobl.franz.spend),
            test_video_roas_luke:   div(testRoasNobl.luke.rev,   testRoasNobl.luke.spend),
            test_video_roas_chris:  div(testRoasNobl.chris.rev,  testRoasNobl.chris.spend),
          },
          FLO: {
            mer: div(fSalesBase, a.f.spend), sales: hasF ? fSalesBase : null, aov: div(fSalesBase, a.f.orders),
            us_mer: div(fGeoVals.US.rev, fGeoVals.US.spend), ca_mer: div(fGeoVals.CA.rev, fGeoVals.CA.spend), au_mer: div(fGeoVals.AU.rev, fGeoVals.AU.spend), eu_mer: div(fGeoVals.EU.rev, fGeoVals.EU.spend), uk_mer: div(fGeoVals.UK.rev, fGeoVals.UK.spend),
            us_sales_pct: div(fGeoVals.US.rev, fSalesBase), ca_sales_pct: div(fGeoVals.CA.rev, fSalesBase), au_sales_pct: div(fGeoVals.AU.rev, fSalesBase), eu_sales_pct: div(fGeoVals.EU.rev, fSalesBase), uk_sales_pct: div(fGeoVals.UK.rev, fSalesBase),
            site_cvr: sessFseen ? div(fOrderDenom, sessFsessions) : null,
            discounts_pct: div(shop.f.discounts, fSalesBase),
            returning_new_customer_split: pctSplit(floRetReturning, Math.max(0, floRetTotal - floRetReturning)),
            // App engagement Sheet KPIs are app analytics metrics, not web/TW
            // Pixel sessions. Do not fill them from tw_sessions_daily; live app
            // API overlay or explicit verified overrides can supply them.
            dau_mau_stickiness: null,
            sessions_per_dau: null,
            avg_shipping_cost: avgOf(opsFcost),
            avg_fulfillment_days: avgOf(opsFfulfillDays),
            avg_ship_to_door_days: avgOf(opsFshipDays),
            ca_ttf_days: avgOf(opsFcaTtf),
            au_ttf_days: avgOf(opsFauTtf),
            uk_ttf_days: avgOf(opsFukTtf),
            orders_unfulfilled: maxOf(opsFuf),
            us_orders_unfulfilled: maxOf(opsFusUf),
            ca_orders_unfulfilled: maxOf(opsFcaUf),
            au_orders_unfulfilled: maxOf(opsFauUf),
            uk_orders_unfulfilled: maxOf(opsFukUf),
            orders_unfulfilled_24h: maxOf(opsFuf24),
            us_orders_unfulfilled_24h: maxOf(opsFusUf24),
            uk_orders_unfulfilled_24h: maxOf(opsFukUf24),
            cs_tickets_pct: (csFseen && fOrderDenom > 0) ? csFtotal / fOrderDenom : null,
            cs_tickets_count: csFseen ? csFtotal : null,
            us_cs_tickets_count: csFseen ? csFus : null,
            us_cs_tickets_pct: (csFseen && shopRegion.f.US > 0) ? csFus / shopRegion.f.US : null,
            ca_cs_tickets_count: csFseen ? csFca : null,
            ca_cs_tickets_pct: (csFseen && shopRegion.f.CA > 0) ? csFca / shopRegion.f.CA : null,
            au_cs_tickets_count: csFseen ? csFau : null,
            au_cs_tickets_pct: (csFseen && shopRegion.f.AU > 0) ? csFau / shopRegion.f.AU : null,
            uk_cs_tickets_count: csFseen ? csFuk : null,
            uk_cs_tickets_pct: (csFseen && shopRegion.f.UK > 0) ? csFuk / shopRegion.f.UK : null,
            cs_closed_count: csFseen ? csFclosed : null,
            cs_closed_pct: (csFseen && fOrderDenom > 0) ? csFclosed / fOrderDenom : null,
            first_response_hours: (csFseen && csFfrCount > 0) ? (csFfrSum / csFfrCount) / 3_600_000 : null,
            first_resolution_hours: (csFseen && csFfrrCount > 0) ? (csFfrrSum / csFfrrCount) / 3_600_000 : null,
            csat_avg: (csFseen && csFcsatCount > 0) ? csFcsatSum / csFcsatCount : null,
            recovery_revenue: csFseen ? csFrecoveryRev : null,
            wrong_order_rate: (csFseen && csFtotal > 0) ? csFwrongOrder / csFtotal : null,
            wrong_order_count: csFseen ? csFwrongOrder : null,
            top_ticket_themes: csFthemes[csFthemes.length - 1] || null,
            cb_rate: (cbFseen && fOrderDenom > 0) ? cbFtotal / fOrderDenom : null,
            us_cb_rate: (cbFseen && cbShopRegion.f.US > 0) ? cbFus / cbShopRegion.f.US : null,
            ca_cb_rate: (cbFseen && cbShopRegion.f.CA > 0) ? cbFca / cbShopRegion.f.CA : null,
            au_cb_rate: (cbFseen && cbShopRegion.f.AU > 0) ? cbFau / cbShopRegion.f.AU : null,
            uk_cb_rate: (cbFseen && cbShopRegion.f.UK > 0) ? cbFuk / cbShopRegion.f.UK : null,
            meta_cvr: hasTwAdsF ? metaCvr(tw.f) : null,
            whitelisting_spend_pct: hasMetaF ? div(m.f.whitelist, m.f.s) : null,
            test_spend_pct: hasTwAdsF ? div(tw.f.test, tw.f.s) : null,
            tof_spend_pct: hasTwAdsF ? div(Math.max(0, tw.f.s - tw.f.bof), tw.f.s) : null,
            tof_bof_spend_split: hasTwAdsF ? tofBofSplit(tw.f) : null,
            refund_rate: twRefundFseen ? div(a.f.refund, twRefundFdenom) : null,
            us_refund_rate: twRefundFseen ? div(twRefundFreg.US, fGeoVals.US.rev) : null,
            ca_refund_rate: twRefundFseen ? div(twRefundFreg.CA, fGeoVals.CA.rev) : null,
            au_refund_rate: twRefundFseen ? div(twRefundFreg.AU, fGeoVals.AU.rev) : null,
            uk_refund_rate: twRefundFseen ? div(twRefundFreg.UK, fGeoVals.UK.rev) : null,
            // Retention revenue (TW email_sms_daily = Klaviyo flow + campaign) as
            // share of Gross Sales − Discounts. Override via kpi_pulse_overrides
            // if a stricter flow-only figure is preferred.
            retention_rev_pct: twEmailFseen ? div(twEmailFrev, fSalesBase) : null,
            sms_sales_pct:    twEmailFseen ? div(twSmsFrev,   fSalesBase) : null,
            email_sales_pct:  twEmailFseen ? div(twEmailOnlyFrev, fSalesBase) : null,
            email_flow_campaign_split: twEmailFseen ? pctSplit(twFlowFrev, twCampaignFrev) : null,
            unsubscribe_rate: (twEmailFseen && twDeliveredF > 0) ? twUnsubF / twDeliveredF : null,
            app_rev_pct: div(floIapRevenue, fSalesBase),
            app_attach_pct: floAppAttach,
            app_ttp: floAppTtp,
            app_activation: (floAppAttach != null && floAppTtp != null) ? floAppAttach * floAppTtp : null,
            app_net_sub_adds: floIapNs - floIapCs,
            monthly_churn: floChurn,
            app_lifetime_months: floAppLifetimeMonths,
            app_ltv: floAppLtv,
            app_cac: floAppCac,
            app_ltv_cac: floAppLtvCacRatio,
            flo_sub_hardware_split: pctSplit(floAppSubRev, floPortableRev + floHomeStudioRev),
            hardware_mix_sales: pctSplit(floPortableRev, floHomeStudioRev),
            // FLO Hardware Revenue (actual, $) — sum of Portable + Home + Studio.
            // "vs Plan" reads variance against the catalog target in the row.
            flo_hardware_rev: floPortableRev + floHomeStudioRev,
            returning_cust_rev_pct: floRetTotal > 0 ? floRetReturning / floRetTotal : null,
            // FLO Chris Share of Spend — Chris-tagged spend / FLO total spend.
            sos_chris: hasMetaF ? div(stratFlo.chris, m.f.s) : null,
            // FLO product CAC = ad spend / purchase count (Chris-coded ads).
            portable_cac:    div(stratFlo.portableSpend, stratFlo.portablePurch),
            studio_cac:      div(stratFlo.studioSpend,   stratFlo.studioPurch),
            home_cac:        div(stratFlo.homeSpend,     stratFlo.homePurch),
            home_studio_cac: div(stratFlo.homeSpend + stratFlo.studioSpend, stratFlo.homePurch + stratFlo.studioPurch),
          },
        };
      }

      const KN = [
        'mer','sales','aov','amazon_pct','us_mer','ca_mer','au_mer','eu_mer','uk_mer','us_sales_pct','ca_sales_pct','au_sales_pct','eu_sales_pct','uk_sales_pct','site_cvr','discounts_pct','returning_new_customer_split',
        'air_rev_pct','attach','ttp','activation','intl_activation','au_activation','ca_activation','uk_activation','pagespeed_pdp_aio','dau_mau_stickiness','sessions_per_mau','nobl_mau_count','air_paid_churn_rate','air_paid_churn_count','airplus_popup_shown','airplus_popup_dismissed','airplus_popup_cta_tapped','airplus_popup_purchases',
        'avg_shipping_cost','avg_fulfillment_days','avg_ship_to_door_days','ca_ttf_days','au_ttf_days','uk_ttf_days','orders_unfulfilled','us_orders_unfulfilled','ca_orders_unfulfilled','au_orders_unfulfilled','uk_orders_unfulfilled','orders_unfulfilled_24h','us_orders_unfulfilled_24h','uk_orders_unfulfilled_24h',
        'cs_tickets_pct','cs_tickets_count','us_cs_tickets_count','us_cs_tickets_pct','ca_cs_tickets_count','ca_cs_tickets_pct','au_cs_tickets_count','au_cs_tickets_pct','uk_cs_tickets_count','uk_cs_tickets_pct','cs_closed_count','cs_closed_pct','first_response_hours','first_resolution_hours','csat_avg','recovery_revenue','wrong_order_rate','wrong_order_count','top_ticket_themes','cb_rate','us_cb_rate','ca_cb_rate','au_cb_rate','uk_cb_rate',
        'meta_cvr','whitelisting_spend_pct','test_spend_pct','tof_spend_pct','tof_bof_spend_split','refund_rate','us_refund_rate','ca_refund_rate','au_refund_rate','uk_refund_rate','retention_rev_pct','sms_sales_pct','email_sales_pct','email_flow_campaign_split','unsubscribe_rate','new_customer_cac','bundle_rev_pct','bundle_cm1_pct','net_sub_adds','returning_cust_rev_pct',
        'sos_taylor','sos_franz','sos_luke','sos_chris','test_video_roas_taylor','test_video_roas_franz','test_video_roas_luke','test_video_roas_chris',
      ];
      const KF = [
        'mer','sales','aov','us_mer','ca_mer','au_mer','eu_mer','uk_mer','us_sales_pct','ca_sales_pct','au_sales_pct','eu_sales_pct','uk_sales_pct','site_cvr','discounts_pct','returning_new_customer_split','pagespeed_pdp_aio','dau_mau_stickiness','sessions_per_dau',
        'avg_shipping_cost','avg_fulfillment_days','avg_ship_to_door_days','ca_ttf_days','au_ttf_days','uk_ttf_days','orders_unfulfilled','us_orders_unfulfilled','ca_orders_unfulfilled','au_orders_unfulfilled','uk_orders_unfulfilled','orders_unfulfilled_24h','us_orders_unfulfilled_24h','uk_orders_unfulfilled_24h',
        'cs_tickets_pct','cs_tickets_count','us_cs_tickets_count','us_cs_tickets_pct','ca_cs_tickets_count','ca_cs_tickets_pct','au_cs_tickets_count','au_cs_tickets_pct','uk_cs_tickets_count','uk_cs_tickets_pct','cs_closed_count','cs_closed_pct','first_response_hours','first_resolution_hours','csat_avg','recovery_revenue','wrong_order_rate','wrong_order_count','top_ticket_themes','cb_rate','us_cb_rate','ca_cb_rate','au_cb_rate','uk_cb_rate',
        'meta_cvr','whitelisting_spend_pct','test_spend_pct','tof_spend_pct','tof_bof_spend_split','refund_rate','us_refund_rate','ca_refund_rate','au_refund_rate','uk_refund_rate','retention_rev_pct','sms_sales_pct','email_sales_pct','email_flow_campaign_split','unsubscribe_rate','app_rev_pct','app_attach_pct','app_ttp','app_activation','app_net_sub_adds','monthly_churn','app_lifetime_months','app_ltv','app_cac','app_ltv_cac','flo_sub_hardware_split','hardware_mix_sales','flo_hardware_rev','returning_cust_rev_pct',
        'sos_chris','portable_cac','studio_cac','home_cac','home_studio_cac',
      ];
      function buildCadence(defs) {
        const series = { NOBL: {}, FLO: {} };
        KN.forEach(k => series.NOBL[k] = []);
        KF.forEach(k => series.FLO[k] = []);
        for (const p of defs) {
          const m = metricsFor(p.dates);
          KN.forEach(k => series.NOBL[k].push(m.NOBL[k]));
          KF.forEach(k => series.FLO[k].push(m.FLO[k]));
        }
        return { periods: defs.map(p => ({ key: p.key, label: p.label, sub: p.sub })), series };
      }

      function applyLiveMetrics(cadenceData, liveMetrics) {
        if (!liveMetrics || !cadenceData?.periods?.length) return cadenceData;
        // Live APIs are current snapshots, not historical series. Only stamp
        // them onto the latest visible period (daily/latest week/current QTD),
        // never onto older periods.
        for (const brand of ['NOBL', 'FLO']) {
          for (const key of ['pagespeed_pdp_aio', 'dau_mau_stickiness', 'sessions_per_mau', 'sessions_per_dau']) {
            const v = liveMetrics?.[brand]?.[key];
            if (v == null || !Number.isFinite(Number(v)) || !cadenceData.series?.[brand]?.[key]) continue;
            cadenceData.series[brand][key] = cadenceData.periods.map((_, idx) => (idx === 0 ? Number(v) : null));
          }
        }
        return cadenceData;
      }

      const availableMonths = Array.from(new Set(allDates.map(d => d.slice(0, 7)))).sort().reverse();
      const selectedMonth = (requestedMonth && availableMonths.includes(requestedMonth)) ? requestedMonth : latest.slice(0, 7);

      // Daily — selected month, latest first (no MTD column).
      const dailyMonth = selectedMonth;
      const dailyDefs = allDates.filter(d => d.slice(0, 7) === dailyMonth).reverse()
        .map(d => ({ key: d, label: niceMD(d), sub: 'Day', dates: [d] }));

      // Weekly — week-ends (Sunday) in the selected month, latest first.
      const weekMap = {};
      for (const d of allDates) (weekMap[weekEndISO(d)] = weekMap[weekEndISO(d)] || []).push(d);
      const weeklyDefs = Object.keys(weekMap).filter(we => we.slice(0, 7) === selectedMonth).sort().reverse()
        .map(we => ({ key: we, label: `W/E ${niceMD(we)}`, sub: 'Week end', dates: weekMap[we] }));

      // Quarterly — calendar quarters with data, latest first
      const qMap = {};
      for (const d of allDates) { const [y, m] = d.split('-').map(Number); const q = `${y}-Q${Math.floor((m-1)/3)+1}`; (qMap[q] = qMap[q] || []).push(d); }
      const quarterlyDefs = Object.keys(qMap).sort().slice(-4).reverse()
        .map(q => { const [y, qq] = q.split('-Q'); return { key: q, label: `Q${qq} ${y}`, sub: 'Quarter', dates: qMap[q] }; });

      const overrides = await (async () => {
        try {
          await ensureKpiPulseOverrideTable();
          const r = await pgQuery(`SELECT override_key, payload FROM kpi_pulse_overrides`);
          return Object.fromEntries(r.rows.map(row => [row.override_key, row.payload || {}]));
        } catch {
          return {};
        }
      })();

      return {
        asOf: latest,
        selectedMonth,
        availableMonths,
        cadences: {
          daily: buildCadence(dailyDefs),
          weekly: buildCadence(weeklyDefs),
          quarterly: buildCadence(quarterlyDefs),
        },
        overrides,
      };
    }, { staleWhileRevalidate: true });
    const cloneCadence = (cadenceData) => ({
      periods: cadenceData?.periods || [],
      series: {
        NOBL: Object.fromEntries(Object.entries(cadenceData?.series?.NOBL || {}).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])),
        FLO: Object.fromEntries(Object.entries(cadenceData?.series?.FLO || {}).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])),
      },
    });
    let out = body;
    if (body?.selectedMonth === String(body?.asOf || '').slice(0, 7)) {
      const liveMetrics = await getKpiPulseLiveMetricsFast();
      if (liveMetrics) {
        out = {
          ...body,
          cadences: {
            daily: applyKpiPulseLiveMetrics(cloneCadence(body.cadences?.daily), liveMetrics),
            weekly: applyKpiPulseLiveMetrics(cloneCadence(body.cadences?.weekly), liveMetrics),
            quarterly: applyKpiPulseLiveMetrics(cloneCadence(body.cadences?.quarterly), liveMetrics),
          },
        };
      }
    }
    res.json(out);
  } catch (e) {
    console.error('[Analytics /kpi-pulse]', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function ensureKpiPulseOverrideTable() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS kpi_pulse_overrides (
      override_key TEXT PRIMARY KEY,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

router.put('/kpi-pulse/overrides', async (req, res) => {
  try {
    const { key, payload } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing override key' });
    await ensureKpiPulseOverrideTable();
    await pgQuery(`
      INSERT INTO kpi_pulse_overrides (override_key, payload, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (override_key) DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()
    `, [key, JSON.stringify(payload || {})]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Analytics /kpi-pulse/overrides]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/air-performance
router.get('/nobl/air-performance', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const rollingDays = Math.max(7, Math.min(parseInt(req.query.rollingDays || '14', 10), 60));
  const forecastDays = Math.max(7, Math.min(parseInt(req.query.forecastDays || '14', 10), 60));
  const regionRaw = String(req.query.region || 'ALL').trim();
  const region = regionRaw.toUpperCase();
  const regionOrder = ['US', 'CA', 'AUS', 'DUBAI', 'HK', 'INTL'];
  const regionCountries = {
    US: ['US'],
    CA: ['CA'],
    AUS: ['AU'],
    DUBAI: ['AE'],
    HK: ['HK'],
    INTL: [],
  };

  const includeForecast = ['1', 'true', 'yes'].includes(String(req.query.includeForecast || '').toLowerCase());

  try {
    const { version } = await getNoblAirDataVersion();
    const cacheKey = `perf:${start}:${end}:${region}:${rollingDays}:${forecastDays}:${includeForecast ? 1 : 0}`;
    const { body, hit } = await withResponseCache('nobl-air', cacheKey, version, async () => {
    const [effectiveEnd, effectiveStart] = await Promise.all([
      capNoblAirEndDate(end),
      clampNoblAirStartDate(start),
    ]);
    // Support multi-region like "US,CA". "ALL" means no region filter.
    let countryCodes = null;
    let regionKey = null;
    if (region && region !== 'ALL') {
      const parts = region.split(',').map(s => s.trim()).filter(Boolean);
      const codes = [];
      for (const p of parts) {
        const cs = regionCountries[p];
        if (cs !== undefined) codes.push(...cs);
      }
      const validParts = regionOrder.filter(p => parts.includes(p));
      // If nothing matched, treat as ALL (no filter) rather than returning empty data.
      countryCodes = validParts.length ? Array.from(new Set(codes)) : null;
      if (validParts.length) {
        const keyParts = regionOrder.filter(p => parts.includes(p));
        regionKey = keyParts.join('_');
      }
    }
    const activeSubsPromise = !regionKey
      ? pgQuery(`
          SELECT
            COALESCE(SUM(contract_amount), 0)::numeric(14,2) AS active_arr,
            COUNT(*)::int AS active_count
          FROM nobl_air_subscribers
          WHERE LOWER(TRIM(status)) = 'active'
        `)
      : Promise.resolve({ rows: [{}] });

    const [daily, ttpCohort, activeSubsRes] = await Promise.all([
      regionKey
        ? loadNoblAirRegionalCachedDaily(effectiveStart, effectiveEnd, regionKey)
        : pgQuery(
          `SELECT
             TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
             total_orders, air_orders, attach_rate, ttp_rate, activation_rate,
             mature_count, converted_count, cancelled_30d_count, cancel_rate_30d,
             zero_air_orders, paid_air_orders, rebill_orders, same_day_cancels,
             tag_gross, tag_discounts, tag_net_sales,
             sub_gross, sub_discounts, sub_net_sales,
             rebill_revenue, new_sub_revenue,
             combined_gross, combined_net_sales,
             tag_refunds, sub_refunds, combined_net_revenue,
             new_49, new_79, new_89, new_99, new_109, new_119, new_129, new_139, new_149, new_159,
             rebill_49, rebill_79, rebill_89, rebill_99, rebill_109, rebill_119, rebill_129, rebill_139, rebill_149, rebill_159
           FROM nobl_air_daily
           WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
           ORDER BY date ASC`,
          [effectiveStart, effectiveEnd]
        ).then(r => fmtRows(r.rows)),
      regionKey
        ? loadNoblAirRegionalCachedTtp(effectiveStart, effectiveEnd, regionKey)
        : loadNoblAirTtpCohort(effectiveStart, effectiveEnd, countryCodes),
      activeSubsPromise,
    ]);
    const activeSubsRow = activeSubsRes.rows[0] || {};
    let forecastModel = null;
    if (includeForecast && !regionKey) {
      const forecastTtpCohort = await loadNoblAirTtpAsOfEnd(effectiveEnd, null);
      forecastModel = await loadNoblAirRevenueForecast('2026-03-01', effectiveEnd, [], forecastTtpCohort);
    }
    const rowsDesc = [...daily].reverse();

    const totals = daily.reduce((acc, r) => ({
      total_orders: (acc.total_orders || 0) + (r.total_orders || 0),
      air_orders: (acc.air_orders || 0) + (r.air_orders || 0),
      zero_air_orders: (acc.zero_air_orders || 0) + (r.zero_air_orders || 0),
      paid_air_orders: (acc.paid_air_orders || 0) + (r.paid_air_orders || 0),
      rebill_orders: (acc.rebill_orders || 0) + (r.rebill_orders || 0),
      same_day_cancels: (acc.same_day_cancels || 0) + (r.same_day_cancels || 0),
      tag_net_sales: (acc.tag_net_sales || 0) + (r.tag_net_sales || 0),
      sub_net_sales: (acc.sub_net_sales || 0) + (r.sub_net_sales || 0),
      rebill_revenue: (acc.rebill_revenue || 0) + (r.rebill_revenue || 0),
      new_sub_revenue: (acc.new_sub_revenue || 0) + (r.new_sub_revenue || 0),
      combined_net_revenue: (acc.combined_net_revenue || 0) + (r.combined_net_revenue || 0),
    }), {});

    totals.attach_rate = totals.total_orders > 0
      ? parseFloat((totals.air_orders / totals.total_orders).toFixed(4))
      : null;
    totals.ttp_rate = ttpCohort.ttp_rate;
    totals.activation_rate = (totals.attach_rate != null && totals.ttp_rate != null)
      ? parseFloat((totals.attach_rate * totals.ttp_rate).toFixed(4))
      : null;

    const trailing = daily.slice(-rollingDays);
    const avg = (field) => {
      if (!trailing.length) return 0;
      return trailing.reduce((s, r) => s + (parseFloat(r[field]) || 0), 0) / trailing.length;
    };
    const avgRounded = (field, decimals = 2) => parseFloat(avg(field).toFixed(decimals));

    const forecast = [];
    if (daily.length > 0) {
      const lastDate = new Date(daily[daily.length - 1].date);
      for (let i = 1; i <= forecastDays; i += 1) {
        const d = new Date(lastDate);
        d.setDate(d.getDate() + i);
        const ds = d.toISOString().slice(0, 10);
        forecast.push({
          date: ds,
          total_orders: avgRounded('total_orders', 0),
          air_orders: avgRounded('air_orders', 0),
          attach_rate: avgRounded('attach_rate', 4),
          ttp_rate: avgRounded('ttp_rate', 4),
          activation_rate: avgRounded('activation_rate', 4),
          zero_air_orders: avgRounded('zero_air_orders', 0),
          paid_air_orders: avgRounded('paid_air_orders', 0),
          rebill_orders: avgRounded('rebill_orders', 0),
          same_day_cancels: avgRounded('same_day_cancels', 0),
          tag_gross: avgRounded('tag_gross'),
          tag_discounts: avgRounded('tag_discounts'),
          tag_net_sales: avgRounded('tag_net_sales'),
          sub_gross: avgRounded('sub_gross'),
          sub_discounts: avgRounded('sub_discounts'),
          sub_net_sales: avgRounded('sub_net_sales'),
          rebill_revenue: avgRounded('rebill_revenue'),
          new_sub_revenue: avgRounded('new_sub_revenue'),
          combined_gross: avgRounded('combined_gross'),
          combined_net_sales: avgRounded('combined_net_sales'),
          tag_refunds: avgRounded('tag_refunds'),
          sub_refunds: avgRounded('sub_refunds'),
          combined_net_revenue: avgRounded('combined_net_revenue'),
          new_49: avgRounded('new_49', 0),
          new_79: avgRounded('new_79', 0),
          new_89: avgRounded('new_89', 0),
          new_99: avgRounded('new_99', 0),
          new_109: avgRounded('new_109', 0),
          new_119: avgRounded('new_119', 0),
          new_129: avgRounded('new_129', 0),
          new_139: avgRounded('new_139', 0),
          new_149: avgRounded('new_149', 0),
          new_159: avgRounded('new_159', 0),
          rebill_49: avgRounded('rebill_49', 0),
          rebill_79: avgRounded('rebill_79', 0),
          rebill_89: avgRounded('rebill_89', 0),
          rebill_99: avgRounded('rebill_99', 0),
          rebill_109: avgRounded('rebill_109', 0),
          rebill_119: avgRounded('rebill_119', 0),
          rebill_129: avgRounded('rebill_129', 0),
          rebill_139: avgRounded('rebill_139', 0),
          rebill_149: avgRounded('rebill_149', 0),
          rebill_159: avgRounded('rebill_159', 0),
          is_forecast: true,
          forecast_basis_days: rollingDays,
        });
      }
    }

    return {
      rows: rowsDesc,
      totals,
      forecast,
      revenue_forecast: forecastModel,
      rolling_days: rollingDays,
      forecast_days: forecastDays,
      ttp_cohort: ttpCohort,
      active_count: !regionKey ? Number(activeSubsRow.active_count || 0) : null,
      active_arr: !regionKey ? Number(activeSubsRow.active_arr || 0) : null,
      region: region || 'ALL',
      data_start: effectiveStart,
      data_end: effectiveEnd,
      requested_start: start,
      requested_end: end,
    };
    });
    res.setHeader('X-Data-Version', version);
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(body);
  } catch (e) {
    console.error('[Analytics /nobl/air-performance]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const AIR_BASE_REGION_KEYS = ['US', 'CA', 'AUS', 'DUBAI', 'HK', 'INTL'];

// GET /nobl/air-performance-bundle — global + base region dailies in one round trip (client filters by region)
router.get('/nobl/air-performance-bundle', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
    const { version } = await getNoblAirDataVersion();
    const cacheKey = `perf-bundle:${start}:${end}`;
    const { body, hit } = await withResponseCache('nobl-air', cacheKey, version, async () => {
      const [effectiveEnd, effectiveStart] = await Promise.all([
        capNoblAirEndDate(end),
        clampNoblAirStartDate(start),
      ]);

      const [globalDailyRes, ttpGlobal, activeSubsRes, ...regionDailyLists] = await Promise.all([
        pgQuery(
          `SELECT
             TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
             total_orders, air_orders, attach_rate, ttp_rate, activation_rate,
             mature_count, converted_count, cancelled_30d_count, cancel_rate_30d,
             zero_air_orders, paid_air_orders, rebill_orders, same_day_cancels,
             tag_gross, tag_discounts, tag_net_sales,
             sub_gross, sub_discounts, sub_net_sales,
             rebill_revenue, new_sub_revenue,
             combined_gross, combined_net_sales,
             tag_refunds, sub_refunds, combined_net_revenue,
             new_49, new_79, new_89, new_99, new_109, new_119, new_129, new_139, new_149, new_159,
             rebill_49, rebill_79, rebill_89, rebill_99, rebill_109, rebill_119, rebill_129, rebill_139, rebill_149, rebill_159
           FROM nobl_air_daily
           WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
           ORDER BY date ASC`,
          [effectiveStart, effectiveEnd]
        ),
        loadNoblAirTtpCohort(effectiveStart, effectiveEnd, null),
        pgQuery(`
          SELECT
            COALESCE(SUM(contract_amount), 0)::numeric(14,2) AS active_arr,
            COUNT(*)::int AS active_count
          FROM nobl_air_subscribers
          WHERE LOWER(TRIM(status)) = 'active'
        `),
        ...AIR_BASE_REGION_KEYS.map((k) =>
          loadNoblAirRegionalCachedDaily(effectiveStart, effectiveEnd, k)
        ),
      ]);

      const activeSubsRow = activeSubsRes.rows[0] || {};
      const regions = {};
      AIR_BASE_REGION_KEYS.forEach((k, i) => {
        regions[k] = { daily: regionDailyLists[i] };
      });

      return {
        global: {
          daily: fmtRows(globalDailyRes.rows),
          ttp_cohort: ttpGlobal,
        },
        regions,
        active_count: Number(activeSubsRow.active_count || 0),
        active_arr: Number(activeSubsRow.active_arr || 0),
        data_start: effectiveStart,
        data_end: effectiveEnd,
        requested_start: start,
        requested_end: end,
      };
    });
    res.setHeader('X-Data-Version', version);
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(body);
  } catch (e) {
    console.error('[Analytics /nobl/air-performance-bundle]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/air-forecast — revenue forecast tab (heavy; load on demand, not with performance KPIs)
router.get('/nobl/air-forecast', async (req, res) => {
  try {
    const asOfReq = req.query.asOf ? String(req.query.asOf).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const { version } = await getNoblAirDataVersion();
    const cacheKey = `forecast:${asOfReq}`;
    const { body, hit } = await withResponseCache('nobl-air', cacheKey, version, async () => {
      const effectiveEnd = await capNoblAirEndDate(asOfReq);
      const ttpCohort = await loadNoblAirTtpAsOfEnd(effectiveEnd, null);
      const forecastModel = await loadNoblAirRevenueForecast('2026-03-01', effectiveEnd, [], ttpCohort);
      return { revenue_forecast: forecastModel, as_of: effectiveEnd };
    });
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(body);
  } catch (e) {
    console.error('[Analytics /nobl/air-forecast]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/air-meta-adsets — live Meta ad set performance for the selected date range
router.get('/nobl/air-meta-adsets', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const rowLimit = Math.max(10, Math.min(parseInt(req.query.limit || '50', 10), 100));
  const token = process.env.META_ADS_READ_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  const sortBy = String(req.query.sortBy || '').trim();
  const sortDir = (String(req.query.dir || 'desc').toLowerCase() === 'asc') ? 'asc' : 'desc';

  if (!token || !accountId) {
    return res.status(400).json({ error: 'Missing META_AD_ACCOUNT_ID or META_ADS_READ_TOKEN' });
  }

  try {
    const params = new URLSearchParams({
      access_token: token,
      level: 'adset',
      fields: [
        'campaign_id', 'campaign_name', 'adset_id', 'adset_name',
        'spend', 'impressions', 'reach', 'clicks', 'inline_link_clicks',
        'ctr', 'cpc', 'cpm', 'actions', 'action_values', 'purchase_roas',
      ].join(','),
      time_range: JSON.stringify({ since: start, until: end }),
      sort: 'spend_descending',
      limit: '100',
    });

    let nextUrl = `https://graph.facebook.com/v20.0/${accountId}/insights?${params}`;
    const rawRows = [];

    for (let page = 0; nextUrl && page < 5 && rawRows.length < 500; page += 1) {
      const metaRes = await fetch(nextUrl, { signal: AbortSignal.timeout(45_000) });
      const json = await metaRes.json();
      if (!metaRes.ok) {
        throw new Error(json?.error?.message || `Meta API HTTP ${metaRes.status}`);
      }
      rawRows.push(...(Array.isArray(json.data) ? json.data : []));
      nextUrl = json?.paging?.next || null;
    }

    let allRows = rawRows
      .map(normalizeMetaAdSet)
      .filter(row => row.spend > 0 || row.purchases > 0 || row.impressions > 0)
      .sort((a, b) => b.spend - a.spend);
    if (sortBy) {
      allRows = allRows.sort((a, b) => {
        const av = a[sortBy];
        const bv = b[sortBy];
        const cmp = (Number.isFinite(av) && Number.isFinite(bv))
          ? av - bv
          : String(av ?? '').localeCompare(String(bv ?? ''));
        return sortDir === 'desc' ? -cmp : cmp;
      });
    }
    const rows = allRows.slice(0, rowLimit);

    const totals = allRows.reduce((acc, row) => ({
      spend: acc.spend + row.spend,
      impressions: acc.impressions + row.impressions,
      reach: acc.reach + row.reach,
      clicks: acc.clicks + row.clicks,
      inline_link_clicks: acc.inline_link_clicks + row.inline_link_clicks,
      purchases: acc.purchases + row.purchases,
      purchase_revenue: acc.purchase_revenue + row.purchase_revenue,
    }), { spend: 0, impressions: 0, reach: 0, clicks: 0, inline_link_clicks: 0, purchases: 0, purchase_revenue: 0 });

    totals.purchase_roas = totals.spend > 0 ? totals.purchase_revenue / totals.spend : 0;
    totals.cost_per_purchase = totals.purchases > 0 ? totals.spend / totals.purchases : null;
    totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
    totals.cpc = totals.clicks > 0 ? totals.spend / totals.clicks : null;
    totals.cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : null;

    res.json({ rows, totals, total_adsets: allRows.length, start, end });
  } catch (e) {
    console.error('[Analytics /nobl/air-meta-adsets]', e.message);
    res.status(500).json({ error: e.message });
  }
});

function parseTablePagination(req, defaultPageSize = 20) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.max(10, Math.min(parseInt(req.query.page_size || req.query.limit || String(defaultPageSize), 10), 200));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function buildPagination(page, pageSize, totalRows) {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize) || 1);
  return { page, page_size: pageSize, total_rows: totalRows, total_pages: totalPages };
}

function parseTableSearch(req) {
  const q = String(req.query.search || req.query.q || '').trim();
  return q.length ? `%${q}%` : null;
}

function parseSearchColumn(req) {
  const c = String(req.query.search_column || req.query.column || '').trim();
  return c && c !== '__all__' ? c : '__all__';
}

/** Map UI column label (or SQL col) → sort field; default when absent. */
function parseTableSort(req, labelToSql, { defaultCol = 'spend', defaultDir = 'desc' } = {}) {
  const rawDir = String(req.query.sort_dir || req.query.dir || '').toLowerCase();
  const sortDir = rawDir === 'asc' ? 'asc' : (rawDir === 'desc' ? 'desc' : defaultDir);
  const label = String(req.query.sort_by || req.query.sortBy || '').trim();
  const sqlCol = label ? (labelToSql[label] || label) : defaultCol;
  return { sqlCol, sortDir };
}

function buildGroupedOrderClause(sqlCol, sortDir, expressions, allowedCols, { defaultCol = 'spend' } = {}) {
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  const col = allowedCols.has(sqlCol) ? sqlCol : defaultCol;
  const expr = expressions[col] || `grouped.${col}`;
  const tieBreak = expressions.ad_name
    ? `${expressions.ad_name} ASC`
    : (expressions.campaign_name ? `${expressions.campaign_name} ASC` : 'grouped.ad_name ASC');
  return `${expr} ${dir} NULLS LAST, ${tieBreak}`;
}

/** UI column labels → SQL column on grouped Meta ads rows */
const META_ADS_LABEL_TO_SQL = {
  Brand: 'brand',
  Campaign: 'campaign_name',
  'Campaign ID': 'campaign_id',
  'Ad set': 'adset_name',
  'Ad set ID': 'adset_id',
  Ad: 'ad_name',
  'Ad ID': 'ad_id',
  'Ad spend': 'spend',
  Sales: 'revenue',
  Purchases: 'purchases',
  'Ad views': 'impressions',
  Clicks: 'clicks',
  'Link clicks': 'link_clicks',
  'Add to cart': 'add_to_cart',
  'Started checkout': 'initiate_checkout',
  'Sales per ad $': 'roas',
  'Cost per purchase': 'cac',
  'Click rate': 'ctr',
  'Cost per click': 'cpc',
  'Cost per 1,000 views': 'cpm',
};

const META_ADS_METRIC_COLS = [
  'spend', 'revenue', 'purchases', 'impressions', 'clicks', 'link_clicks',
  'add_to_cart', 'initiate_checkout', 'roas', 'cac', 'ctr', 'cpc', 'cpm',
];

/** UI column labels → SQL column on grouped NOBL Air attribution rows */
const AIR_ATTR_LABEL_TO_SQL = {
  Ad: 'ad_name',
  'Ad ID': 'ad_id',
  'Ad set': 'adset_name',
  Campaign: 'campaign_name',
  'Ad spend': 'spend',
  '1-day attributed sales': 'day_1_revenue',
  'Avg order size': 'aov',
  'All orders linked to ads': 'total_attributed_orders',
  'Orders with Air': 'air_orders',
  'Air orders linked to this ad': 'attributed_air_orders',
  'Attach rate': 'attach_rate',
  'Trial-ended Air orders': 'ttp_mature_air_orders',
  'Trial-ended → paid Air orders': 'ttp_paid_air_orders',
  'TTP rate (as of end date)': 'ttp_rate',
  'Activation rate (as of end date)': 'activation_rate',
  'Air sales linked to this ad': 'attributed_air_revenue',
};

const AIR_ATTR_METRIC_COLS = [
  'spend', 'day_1_revenue', 'aov', 'total_attributed_orders', 'air_orders',
  'attributed_air_orders', 'attributed_air_revenue', 'ttp_mature_air_orders',
  'ttp_paid_air_orders', 'attach_rate', 'ttp_rate', 'activation_rate',
];

const AIR_ATTR_SORT_EXPRESSIONS = {
  campaign_id: 'grouped.campaign_id',
  campaign_name: 'LOWER(COALESCE(grouped.campaign_name, \'\'))',
  adset_id: 'grouped.adset_id',
  adset_name: 'LOWER(COALESCE(grouped.adset_name, \'\'))',
  ad_id: 'grouped.ad_id',
  ad_name: 'LOWER(COALESCE(grouped.ad_name, \'\'))',
  spend: 'grouped.spend',
  day_1_revenue: 'grouped.day_1_revenue',
  aov: 'grouped.aov',
  total_attributed_orders: 'grouped.total_attributed_orders',
  air_orders: 'grouped.air_orders',
  attributed_air_orders: 'grouped.attributed_air_orders',
  attributed_air_revenue: 'grouped.attributed_air_revenue',
  ttp_mature_air_orders: 'grouped.ttp_mature_air_orders',
  ttp_paid_air_orders: 'grouped.ttp_paid_air_orders',
  attach_rate: `CASE WHEN grouped.total_attributed_orders > 0
    THEN grouped.attributed_air_orders / grouped.total_attributed_orders ELSE NULL END`,
  ttp_rate: `CASE WHEN grouped.ttp_mature_air_orders > 0
    THEN grouped.ttp_paid_air_orders / grouped.ttp_mature_air_orders ELSE NULL END`,
  activation_rate: `CASE WHEN grouped.total_attributed_orders > 0 AND grouped.ttp_mature_air_orders > 0
    THEN (grouped.attributed_air_orders / grouped.total_attributed_orders)
      * (grouped.ttp_paid_air_orders / grouped.ttp_mature_air_orders) ELSE NULL END`,
};

const AIR_ATTR_ALLOWED_SORT = new Set(Object.keys(AIR_ATTR_SORT_EXPRESSIONS));

const META_ADS_SORT_EXPRESSIONS = {
  brand: 'LOWER(COALESCE(grouped.brand, \'\'))',
  campaign_id: 'grouped.campaign_id',
  campaign_name: 'LOWER(COALESCE(grouped.campaign_name, \'\'))',
  adset_id: 'grouped.adset_id',
  adset_name: 'LOWER(COALESCE(grouped.adset_name, \'\'))',
  ad_id: 'grouped.ad_id',
  ad_name: 'LOWER(COALESCE(grouped.ad_name, \'\'))',
  spend: 'grouped.spend',
  revenue: 'grouped.revenue',
  purchases: 'grouped.purchases',
  impressions: 'grouped.impressions',
  clicks: 'grouped.clicks',
  link_clicks: 'grouped.link_clicks',
  add_to_cart: 'grouped.add_to_cart',
  initiate_checkout: 'grouped.initiate_checkout',
  roas: 'grouped.roas',
  cac: 'grouped.cac',
  ctr: 'grouped.ctr',
  cpc: 'grouped.cpc',
  cpm: 'grouped.cpm',
};

const META_ADS_ALLOWED_SORT = new Set(Object.keys(META_ADS_SORT_EXPRESSIONS));

/** Merge TW ad spend with cached Air attribution so high-spend ads are never dropped. */
function airAttrMergedGroupedSubquery(groupCols, groupFields) {
  const idFields = groupFields.filter((f) => f.endsWith('_id'));
  const nameFields = groupFields.filter((f) => f.endsWith('_name'));
  const adsGroupBy = groupFields.map((f) => `ads_src.${f}`).join(', ');
  const joinCond = idFields
    .map((f) => `COALESCE(ads.${f}, '') = COALESCE(air.${f}, '')`)
    .join('\n        AND ');
  const idSelect = idFields.map((f) => `COALESCE(ads.${f}, air.${f}, '') AS ${f}`).join(',\n        ');
  const nameSelect = nameFields.map((f) => `COALESCE(ads.${f}, air.${f}) AS ${f}`).join(',\n        ');
  return `
      SELECT
        ${idSelect}${nameSelect ? `,\n        ${nameSelect}` : ''},
        COALESCE(ads.spend, 0)::numeric(14,2) AS spend,
        COALESCE(ads.day_1_revenue, 0)::numeric(14,2) AS day_1_revenue,
        CASE WHEN COALESCE(ads.total_attributed_orders, 0) > 0
          THEN ROUND(COALESCE(ads.day_1_revenue, 0) / ads.total_attributed_orders, 2)
          ELSE NULL END AS aov,
        COALESCE(ads.total_attributed_orders, 0)::numeric(14,2) AS total_attributed_orders,
        COALESCE(air.air_orders, 0)::int AS air_orders,
        COALESCE(air.attributed_air_orders, 0)::numeric(14,2) AS attributed_air_orders,
        COALESCE(air.attributed_air_revenue, 0)::numeric(14,2) AS attributed_air_revenue,
        COALESCE(air.ttp_mature_air_orders, 0)::numeric(14,2) AS ttp_mature_air_orders,
        COALESCE(air.ttp_paid_air_orders, 0)::numeric(14,2) AS ttp_paid_air_orders,
        COALESCE(air.ttp_mature_subscribers, 0)::int AS ttp_mature_subscribers,
        COALESCE(air.ttp_paid_subscribers, 0)::int AS ttp_paid_subscribers
      FROM (
        SELECT ${groupCols},
          SUM(ads_src.spend)::numeric(14,2) AS spend,
          SUM(ads_src.revenue)::numeric(14,2) AS day_1_revenue,
          SUM(ads_src.purchases)::numeric(14,2) AS total_attributed_orders
        FROM ${metaAdsDailySourceSql('$1::date AND $2::date')} ads_src
        WHERE ads_src.brand = 'NOBL'
        GROUP BY ${adsGroupBy}
      ) ads
      FULL OUTER JOIN (
        SELECT ${groupCols},
          SUM(air_orders)::int AS air_orders,
          SUM(attributed_air_orders)::numeric(14,2) AS attributed_air_orders,
          SUM(attributed_air_revenue)::numeric(14,2) AS attributed_air_revenue,
          SUM(ttp_mature_air_orders)::numeric(14,2) AS ttp_mature_air_orders,
          SUM(ttp_paid_air_orders)::numeric(14,2) AS ttp_paid_air_orders,
          SUM(ttp_mature_subscribers)::int AS ttp_mature_subscribers,
          SUM(ttp_paid_subscribers)::int AS ttp_paid_subscribers
        FROM nobl_air_meta_ad_daily
        WHERE brand = 'NOBL'
          AND date BETWEEN $1::date AND $2::date
        GROUP BY ${groupCols}
      ) air ON ${joinCond}`;
}

function buildGroupedTableSearchFilter(pattern, paramIndex, {
  groupCols = '',
  searchColumn = '__all__',
  labelToSql = {},
  metricCols = [],
  includeBrand = true,
} = {}) {
  if (!pattern) return { clause: '', params: [] };
  const groupedColSet = new Set(
    String(groupCols || '').split(',').map((c) => c.trim()).filter(Boolean),
  );
  const p = `$${paramIndex}`;
  const parts = [];
  const addDim = (sqlCol) => {
    if (!sqlCol) return;
    if (sqlCol === 'brand' && !includeBrand) return;
    if (sqlCol !== 'brand' && !groupedColSet.has(sqlCol)) return;
    parts.push(`COALESCE(grouped.${sqlCol}::text, '') ILIKE ${p}`);
  };
  const addMetric = (sqlCol) => {
    if (metricCols.includes(sqlCol)) {
      parts.push(`COALESCE(grouped.${sqlCol}::text, '') ILIKE ${p}`);
    }
  };

  if (searchColumn && searchColumn !== '__all__') {
    const sqlCol = labelToSql[searchColumn];
    if (!sqlCol) return { clause: '', params: [] };
    if (groupedColSet.has(sqlCol) || (sqlCol === 'brand' && includeBrand)) addDim(sqlCol);
    else addMetric(sqlCol);
  } else {
    for (const c of groupedColSet) addDim(c);
    if (includeBrand && groupedColSet.has('brand')) addDim('brand');
    for (const m of metricCols) addMetric(m);
  }

  if (!parts.length) return { clause: '', params: [] };
  return { clause: ` WHERE (${parts.join(' OR ')})`, params: [pattern] };
}

// GET /meta/ads — saved TW ad performance, grouped by campaign/adset/ad
router.get('/meta/ads', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const brand = (req.query.brand || 'NOBL').toUpperCase();
  const level = ['campaign', 'adset', 'ad'].includes(req.query.level) ? req.query.level : 'adset';
  const { page, pageSize, offset } = parseTablePagination(req);
  const { sqlCol: sortSqlCol, sortDir } = parseTableSort(req, META_ADS_LABEL_TO_SQL, { defaultCol: 'spend', defaultDir: 'desc' });
  const searchPattern = parseTableSearch(req);
  const searchColumn = parseSearchColumn(req);
  const metaOrderBy = buildGroupedOrderClause(
    sortSqlCol, sortDir, META_ADS_SORT_EXPRESSIONS, META_ADS_ALLOWED_SORT, { defaultCol: 'spend' },
  );

  const groupFields = {
    campaign: ['brand', 'campaign_id', 'campaign_name'],
    adset: ['brand', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name'],
    ad: ['brand', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'],
  }[level];

  const metaWhere = `($1 = 'ALL' OR brand = $1) AND date BETWEEN $2::date AND $3::date`;
  const metaFrom = metaAdsDailySourceSql('$2::date AND $3::date');
  const groupHaving = 'SUM(spend) > 0 OR SUM(purchases) > 0';
  const metricsSelect = `
        SUM(spend)::numeric(14,2) AS spend,
        SUM(revenue)::numeric(14,2) AS revenue,
        SUM(purchases)::int AS purchases,
        SUM(impressions)::bigint AS impressions,
        SUM(clicks)::bigint AS clicks,
        SUM(link_clicks)::bigint AS link_clicks,
        SUM(add_to_cart)::bigint AS add_to_cart,
        SUM(initiate_checkout)::bigint AS initiate_checkout,
        CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) ELSE NULL END AS roas,
        CASE WHEN SUM(purchases) > 0 THEN SUM(spend) / SUM(purchases) ELSE NULL END AS cac,
        CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::numeric / SUM(impressions) ELSE NULL END AS ctr,
        CASE WHEN SUM(clicks) > 0 THEN SUM(spend) / SUM(clicks) ELSE NULL END AS cpc,
        CASE WHEN SUM(impressions) > 0 THEN SUM(spend) * 1000 / SUM(impressions) ELSE NULL END AS cpm`;

  try {
    const version = await getDataVersion();
    const { body } = await withResponseCache('meta', `ma:${brand}:${level}:${start}:${end}:${page}:${pageSize}:${sortSqlCol}:${sortDir}:${searchPattern || ''}:${searchColumn || ''}`, version, async () => {
    const totalsRes = await pgQuery(`
      SELECT
        SUM(spend)::numeric(14,2) AS spend,
        SUM(revenue)::numeric(14,2) AS revenue,
        SUM(purchases)::int AS purchases,
        SUM(impressions)::bigint AS impressions,
        SUM(clicks)::bigint AS clicks,
        SUM(link_clicks)::bigint AS link_clicks
      FROM ${metaFrom} src
      WHERE ${metaWhere}
    `, [brand, start, end]);
    const totalsRow = totalsRes.rows[0] || {};

    const searchFilter = buildGroupedTableSearchFilter(searchPattern, 4, {
      groupCols: groupFields.join(', '),
      searchColumn,
      labelToSql: META_ADS_LABEL_TO_SQL,
      metricCols: META_ADS_METRIC_COLS,
      includeBrand: true,
    });
    const countRes = await pgQuery(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT ${groupFields.join(', ')}, ${metricsSelect}
        FROM ${metaFrom} src
        WHERE ${metaWhere}
        GROUP BY ${groupFields.join(', ')}
        HAVING ${groupHaving}
      ) grouped
      ${searchFilter.clause}
    `, [brand, start, end, ...searchFilter.params]);
    const totalRows = Number(countRes.rows[0]?.n || 0);

    const pageSearch = buildGroupedTableSearchFilter(searchPattern, 6, {
      groupCols: groupFields.join(', '),
      searchColumn,
      labelToSql: META_ADS_LABEL_TO_SQL,
      metricCols: META_ADS_METRIC_COLS,
      includeBrand: true,
    });
    const [r, chartRes] = await Promise.all([
      pgQuery(`
      SELECT grouped.*
      FROM (
        SELECT ${groupFields.join(', ')}, ${metricsSelect}
        FROM ${metaFrom} src
        WHERE ${metaWhere}
        GROUP BY ${groupFields.join(', ')}
        HAVING ${groupHaving}
      ) grouped
      ${pageSearch.clause}
      ORDER BY ${metaOrderBy}
      LIMIT $4 OFFSET $5
    `, [brand, start, end, pageSize, offset, ...pageSearch.params]),
      pgQuery(`
      SELECT grouped.*
      FROM (
        SELECT ${groupFields.join(', ')}, ${metricsSelect}
        FROM ${metaFrom} src
        WHERE ${metaWhere}
        GROUP BY ${groupFields.join(', ')}
        HAVING ${groupHaving}
      ) grouped
      ORDER BY ${metaOrderBy}
      LIMIT 12
    `, [brand, start, end]),
    ]);

    const totals = {
      spend: Number(totalsRow.spend || 0),
      revenue: Number(totalsRow.revenue || 0),
      purchases: Number(totalsRow.purchases || 0),
      impressions: Number(totalsRow.impressions || 0),
      clicks: Number(totalsRow.clicks || 0),
      link_clicks: Number(totalsRow.link_clicks || 0),
    };

    totals.roas = totals.spend > 0 ? totals.revenue / totals.spend : null;
    totals.cac = totals.purchases > 0 ? totals.spend / totals.purchases : null;
    totals.ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : null;
    totals.cpc = totals.clicks > 0 ? totals.spend / totals.clicks : null;
    totals.cpm = totals.impressions > 0 ? totals.spend * 1000 / totals.impressions : null;

    const rows = fmtRows(r.rows);
    return {
      rows,
      chart_rows: fmtRows(chartRes.rows),
      totals,
      pagination: buildPagination(page, pageSize, totalRows),
      search: searchPattern ? String(req.query.search || req.query.q || '').trim() : '',
      level,
      brand,
      start,
      end,
    };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /meta/ads]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const AIR_ATTR_GROUP_METRICS = `
      SUM(spend)::numeric(14,2) AS spend,
      SUM(day_1_revenue)::numeric(14,2) AS day_1_revenue,
      SUM(purchases)::numeric(14,2) AS total_attributed_orders,
      CASE WHEN SUM(purchases) > 0 THEN ROUND(SUM(day_1_revenue) / SUM(purchases), 2) ELSE NULL END AS aov,
      SUM(air_orders)::int AS air_orders,
      SUM(attributed_air_orders)::numeric(14,2) AS attributed_air_orders,
      SUM(attributed_air_revenue)::numeric(14,2) AS attributed_air_revenue,
      SUM(ttp_mature_air_orders)::numeric(14,2) AS ttp_mature_air_orders,
      SUM(ttp_paid_air_orders)::numeric(14,2) AS ttp_paid_air_orders,
      SUM(ttp_mature_subscribers)::int AS ttp_mature_subscribers,
      SUM(ttp_paid_subscribers)::int AS ttp_paid_subscribers`;

const AIR_ATTR_CACHE_HAVING = 'SUM(spend) > 0 OR SUM(air_orders) > 0 OR SUM(attributed_air_orders) > 0';
const AIR_ATTR_ADS_ONLY_HAVING = 'SUM(spend) > 0 OR SUM(purchases) > 0';

const AIR_ATTR_ADS_ONLY_METRICS = `
      SUM(spend)::numeric(14,2) AS spend,
      SUM(revenue)::numeric(14,2) AS day_1_revenue,
      SUM(purchases)::numeric(14,2) AS total_attributed_orders,
      CASE WHEN SUM(purchases) > 0 THEN ROUND(SUM(revenue) / SUM(purchases), 2) ELSE NULL END AS aov,
      0::int AS air_orders,
      0::numeric(14,2) AS attributed_air_orders,
      0::numeric(14,2) AS attributed_air_revenue,
      0::numeric(14,2) AS ttp_mature_air_orders,
      0::numeric(14,2) AS ttp_paid_air_orders,
      0::int AS ttp_mature_subscribers,
      0::int AS ttp_paid_subscribers`;

function mapAirAttributionRates(rows) {
  return rows.map((row) => {
    const totalOrders = Number(row.total_attributed_orders || 0);
    const attrAir = Number(row.attributed_air_orders || 0);
    const matureAir = Number(row.ttp_mature_air_orders || 0);
    const paidAir = Number(row.ttp_paid_air_orders || 0);
    const attach = totalOrders > 0 ? Number((attrAir / totalOrders).toFixed(4)) : null;
    const ttp = matureAir > 0 ? Number((paidAir / matureAir).toFixed(4)) : null;
    return {
      ...row,
      attach_rate: row.attach_rate ?? attach,
      ttp_rate: row.ttp_rate ?? ttp,
      activation_rate: row.activation_rate ?? (attach != null && ttp != null ? Number((attach * ttp).toFixed(4)) : null),
    };
  });
}

function buildAirAttributionTotals(row = {}) {
  const totals = {
    spend: Number(row.spend || 0),
    day_1_revenue: Number(row.day_1_revenue || 0),
    total_attributed_orders: Number(row.total_attributed_orders || 0),
    air_orders: Number(row.air_orders || 0),
    attributed_air_orders: Number(row.attributed_air_orders || 0),
    attributed_air_revenue: Number(row.attributed_air_revenue || 0),
    ttp_mature_air_orders: Number(row.ttp_mature_air_orders || 0),
    ttp_paid_air_orders: Number(row.ttp_paid_air_orders || 0),
    ttp_mature_subscribers: Number(row.ttp_mature_subscribers || 0),
    ttp_paid_subscribers: Number(row.ttp_paid_subscribers || 0),
  };
  totals.aov = totals.total_attributed_orders > 0
    ? Number((totals.day_1_revenue / totals.total_attributed_orders).toFixed(2))
    : null;
  totals.attach_rate = totals.total_attributed_orders > 0
    ? Number((totals.attributed_air_orders / totals.total_attributed_orders).toFixed(4))
    : null;
  totals.ttp_rate = totals.ttp_mature_air_orders > 0
    ? Number((totals.ttp_paid_air_orders / totals.ttp_mature_air_orders).toFixed(4))
    : null;
  totals.activation_rate = totals.attach_rate != null && totals.ttp_rate != null
    ? Number((totals.attach_rate * totals.ttp_rate).toFixed(4))
    : null;
  return totals;
}

function airAttrGroupedHavingClause() {
  return `(grouped.spend > 0 OR grouped.air_orders > 0 OR grouped.attributed_air_orders > 0)`;
}

async function queryMetaAirAttributionGrouped(
  start, end, groupCols, groupFields, limit, offset,
  searchPattern = null, searchColumn = '__all__', sqlCol = 'spend', sortDir = 'desc',
) {
  const params = [start, end];
  const search = buildGroupedTableSearchFilter(searchPattern, params.length + 1, {
    groupCols,
    searchColumn,
    labelToSql: AIR_ATTR_LABEL_TO_SQL,
    metricCols: AIR_ATTR_METRIC_COLS,
    includeBrand: false,
  });
  params.push(...search.params);
  const orderBy = buildGroupedOrderClause(
    sqlCol, sortDir, AIR_ATTR_SORT_EXPRESSIONS, AIR_ATTR_ALLOWED_SORT, { defaultCol: 'spend' },
  );
  let limitSql = '';
  if (limit != null) {
    params.push(limit);
    limitSql = ` LIMIT $${params.length}`;
    if (offset != null) {
      params.push(offset);
      limitSql += ` OFFSET $${params.length}`;
    }
  }
  return pgQuery(`
    SELECT grouped.*
    FROM (
      ${airAttrMergedGroupedSubquery(groupCols, groupFields)}
    ) grouped
    WHERE ${airAttrGroupedHavingClause()}
    ${search.clause}
    ORDER BY ${orderBy}
    ${limitSql}
  `, params);
}

async function queryMetaAirAttributionGroupedCount(
  start, end, groupCols, groupFields, searchPattern = null, searchColumn = '__all__',
) {
  const params = [start, end];
  const search = buildGroupedTableSearchFilter(searchPattern, params.length + 1, {
    groupCols,
    searchColumn,
    labelToSql: AIR_ATTR_LABEL_TO_SQL,
    metricCols: AIR_ATTR_METRIC_COLS,
    includeBrand: false,
  });
  params.push(...search.params);
  const res = await pgQuery(`
    SELECT COUNT(*)::int AS n FROM (
      ${airAttrMergedGroupedSubquery(groupCols, groupFields)}
    ) grouped
    WHERE ${airAttrGroupedHavingClause()}
    ${search.clause}
  `, params);
  return Number(res.rows[0]?.n || 0);
}

async function queryMetaAirAttributionTotalsDaily(start, end) {
  const res = await pgQuery(`
    SELECT
      SUM(spend)::numeric(14,2) AS spend,
      SUM(day_1_revenue)::numeric(14,2) AS day_1_revenue,
      SUM(purchases)::numeric(14,2) AS total_attributed_orders,
      SUM(air_orders)::int AS air_orders,
      SUM(attributed_air_orders)::numeric(14,2) AS attributed_air_orders,
      SUM(attributed_air_revenue)::numeric(14,2) AS attributed_air_revenue,
      SUM(ttp_mature_air_orders)::numeric(14,2) AS ttp_mature_air_orders,
      SUM(ttp_paid_air_orders)::numeric(14,2) AS ttp_paid_air_orders,
      SUM(ttp_mature_subscribers)::int AS ttp_mature_subscribers,
      SUM(ttp_paid_subscribers)::int AS ttp_paid_subscribers
    FROM nobl_air_meta_ad_daily
    WHERE brand = 'NOBL'
      AND date BETWEEN $1::date AND $2::date
  `, [start, end]);
  return buildAirAttributionTotals(res.rows[0] || {});
}

async function queryMetaAirAttributionAdsOnly(
  start, end, groupCols, limit, offset,
  searchPattern = null, searchColumn = '__all__', sqlCol = 'spend', sortDir = 'desc',
) {
  const params = [start, end];
  const search = buildGroupedTableSearchFilter(searchPattern, params.length + 1, {
    groupCols,
    searchColumn,
    labelToSql: AIR_ATTR_LABEL_TO_SQL,
    metricCols: AIR_ATTR_METRIC_COLS,
    includeBrand: false,
  });
  params.push(...search.params);
  const orderBy = buildGroupedOrderClause(
    sqlCol, sortDir, AIR_ATTR_SORT_EXPRESSIONS, AIR_ATTR_ALLOWED_SORT, { defaultCol: 'spend' },
  );
  let limitSql = '';
  if (limit != null) {
    params.push(limit);
    limitSql = ` LIMIT $${params.length}`;
    if (offset != null) {
      params.push(offset);
      limitSql += ` OFFSET $${params.length}`;
    }
  }
  return pgQuery(`
    SELECT grouped.*
    FROM (
      SELECT
        ${groupCols},
        ${AIR_ATTR_ADS_ONLY_METRICS}
      FROM ${metaAdsDailySourceSql('$1::date AND $2::date')} src
      WHERE brand = 'NOBL'
      GROUP BY ${groupCols}
      HAVING ${AIR_ATTR_ADS_ONLY_HAVING}
    ) grouped
    ${search.clause}
    ORDER BY ${orderBy}
    ${limitSql}
  `, params);
}

async function queryMetaAirAttributionAdsOnlyCount(start, end, groupCols, searchPattern = null, searchColumn = '__all__') {
  const params = [start, end];
  const search = buildGroupedTableSearchFilter(searchPattern, params.length + 1, {
    groupCols,
    searchColumn,
    labelToSql: AIR_ATTR_LABEL_TO_SQL,
    metricCols: AIR_ATTR_METRIC_COLS,
    includeBrand: false,
  });
  params.push(...search.params);
  const res = await pgQuery(`
    SELECT COUNT(*)::int AS n FROM (
      SELECT ${groupCols}, ${AIR_ATTR_ADS_ONLY_METRICS}
      FROM ${metaAdsDailySourceSql('$1::date AND $2::date')} src
      WHERE brand = 'NOBL'
      GROUP BY ${groupCols}
      HAVING ${AIR_ATTR_ADS_ONLY_HAVING}
    ) grouped
    ${search.clause}
  `, params);
  return Number(res.rows[0]?.n || 0);
}

async function queryMetaAirAttributionAdsOnlyTotals(start, end) {
  const res = await pgQuery(`
    SELECT
      SUM(spend)::numeric(14,2) AS spend,
      SUM(revenue)::numeric(14,2) AS day_1_revenue,
      SUM(purchases)::numeric(14,2) AS total_attributed_orders,
      0::int AS air_orders,
      0::numeric(14,2) AS attributed_air_orders,
      0::numeric(14,2) AS attributed_air_revenue,
      0::numeric(14,2) AS ttp_mature_air_orders,
      0::numeric(14,2) AS ttp_paid_air_orders,
      0::int AS ttp_mature_subscribers,
      0::int AS ttp_paid_subscribers
    FROM ${metaAdsDailySourceSql('$1::date AND $2::date')} src
    WHERE brand = 'NOBL'
  `, [start, end]);
  return buildAirAttributionTotals(res.rows[0] || {});
}

function filterLiveAirAttrRows(rows, searchPattern, searchColumn = '__all__') {
  if (!searchPattern) return rows;
  const needle = searchPattern.replace(/%/g, '').toLowerCase();
  const matchVal = (v) => String(v ?? '').toLowerCase().includes(needle);
  if (searchColumn && searchColumn !== '__all__') {
    const sqlCol = AIR_ATTR_LABEL_TO_SQL[searchColumn];
    if (!sqlCol) return rows;
    return rows.filter((r) => matchVal(r[sqlCol]));
  }
  const fields = [
    'campaign_name', 'adset_name', 'ad_name', 'campaign_id', 'adset_id', 'ad_id',
    ...AIR_ATTR_METRIC_COLS,
  ];
  return rows.filter((r) => fields.some((f) => matchVal(r[f])));
}

function sortLiveAirAttrRows(rows, sqlCol, sortDir = 'desc') {
  const col = AIR_ATTR_ALLOWED_SORT.has(sqlCol) ? sqlCol : 'spend';
  const dir = sortDir === 'asc' ? 1 : -1;
  const textCols = new Set(['campaign_name', 'adset_name', 'ad_name', 'campaign_id', 'adset_id', 'ad_id']);
  return [...rows].sort((a, b) => {
    let av = a[col];
    let bv = b[col];
    if (col === 'attach_rate' || col === 'ttp_rate' || col === 'activation_rate') {
      const mapped = mapAirAttributionRates([a, b]);
      av = mapped[0][col];
      bv = mapped[1][col];
    }
    if (av == null && bv == null) return String(a.ad_name || '').localeCompare(String(b.ad_name || ''));
    if (av == null) return 1;
    if (bv == null) return -1;
    if (textCols.has(col)) {
      const cmp = String(av).localeCompare(String(bv));
      return cmp * dir || String(a.ad_name || '').localeCompare(String(b.ad_name || ''));
    }
    const na = Number(av);
    const nb = Number(bv);
    const cmp = Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(av).localeCompare(String(bv));
    return cmp * dir || String(a.ad_name || '').localeCompare(String(b.ad_name || ''));
  });
}

async function fetchAirAttributionPage(
  dataSource, start, end, groupCols, groupFields, pageSize, offset,
  searchPattern = null, searchColumn = '__all__', sqlCol = 'spend', sortDir = 'desc',
) {
  if (dataSource === 'cache') {
    const r = await queryMetaAirAttributionGrouped(
      start, end, groupCols, groupFields, pageSize, offset, searchPattern, searchColumn, sqlCol, sortDir,
    );
    return fmtRows(mapAirAttributionRates(r.rows));
  }
  if (dataSource === 'meta_ads_only') {
    const r = await queryMetaAirAttributionAdsOnly(
      start, end, groupCols, pageSize, offset, searchPattern, searchColumn, sqlCol, sortDir,
    );
    return fmtRows(mapAirAttributionRates(r.rows));
  }
  return [];
}

// GET /nobl/air-attribution — exact NOBL Air purchases from TW order-level attribution
router.get('/nobl/air-attribution', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const level = ['campaign', 'adset', 'ad'].includes(req.query.level) ? req.query.level : 'ad';
  const { page, pageSize, offset } = parseTablePagination(req);
  const searchPattern = parseTableSearch(req);
  const searchColumn = parseSearchColumn(req);
  const { sqlCol: sortSqlCol, sortDir } = parseTableSort(req, AIR_ATTR_LABEL_TO_SQL, { defaultCol: 'spend', defaultDir: 'desc' });
  const allowLive = ['1', 'true', 'yes'].includes(String(req.query.live || '').toLowerCase());

  const groupFields = {
    campaign: ['campaign_id', 'campaign_name'],
    adset: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name'],
    ad: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'],
  }[level];
  const groupCols = groupFields.join(', ');

  try {
    const { version } = await getNoblAirDataVersion();
    const cacheKey = `attr-meta:${start}:${end}:${level}`;
    const { body: meta, hit } = await withResponseCache('nobl-air', cacheKey, version, async () => {
    let source = 'cache';
    let cacheHint = null;
    let dataSource = 'cache';
    let totalRows = await queryMetaAirAttributionGroupedCount(start, end, groupCols, groupFields);

    if (totalRows === 0) {
      const src = await pgQuery(`
        SELECT
          (SELECT COUNT(*)::int FROM tw_air_order_attribution
           WHERE brand = 'NOBL' AND channel = 'facebook-ads'
             AND date BETWEEN $1::date AND $2::date) AS fb_attr,
          (SELECT COUNT(*)::int FROM nobl_air_meta_ad_daily
           WHERE brand = 'NOBL' AND date BETWEEN $1::date AND $2::date) AS range_cached
      `, [start, end]);
      const fbAttr = Number(src.rows[0]?.fb_attr || 0);
      const rangeCached = Number(src.rows[0]?.range_cached || 0);
      const warmKey = `${start}:${end}`;

      if (fbAttr > 0 && rangeCached === 0 && !metaAirWarmInFlight.has(warmKey)) {
        metaAirWarmInFlight.add(warmKey);
        try {
          console.log(`[Analytics /nobl/air-attribution] warming cache ${start}..${end} (${fbAttr} fb attr rows)`);
          await refreshNoblAirMetaAdDaily(start, end);
          totalRows = await queryMetaAirAttributionGroupedCount(start, end, groupCols, groupFields);
          source = totalRows > 0 ? 'cache_warmed' : 'empty_after_warm';
        } finally {
          metaAirWarmInFlight.delete(warmKey);
        }
      }

      if (totalRows === 0) {
        const adsCount = await queryMetaAirAttributionAdsOnlyCount(start, end, groupCols);
        if (adsCount > 0) {
          dataSource = 'meta_ads_only';
          source = 'meta_ads_only';
          totalRows = adsCount;
          cacheHint = 'Meta spend loaded from ad reports. Air order attribution is still syncing — Air columns show 0 until tw_air_attribution cache is built.';
        } else {
          dataSource = 'empty';
          source = 'empty';
          cacheHint = fbAttr === 0
            ? 'No Facebook-attributed Air orders in this date range. Run tw_air_attribution sync from Triple Whale.'
            : 'Cache build returned no rows for this range. Try widening dates or re-run nobl_air_meta_ad_daily sync.';
        }
      }
    }

    if (dataSource === 'empty' && allowLive) {
      dataSource = 'live';
      source = 'live';
      cacheHint = null;
    }

    let totals = buildAirAttributionTotals({});
    let chartRows = [];
    let liveRowsCached = null;

    if (dataSource === 'cache') {
      totals = await queryMetaAirAttributionTotalsDaily(start, end);
      totalRows = await queryMetaAirAttributionGroupedCount(start, end, groupCols, groupFields);
      const top = await queryMetaAirAttributionGrouped(
        start, end, groupCols, groupFields, 12, 0, null, '__all__', 'spend', 'desc',
      );
      chartRows = fmtRows(mapAirAttributionRates(top.rows));
    } else if (dataSource === 'meta_ads_only') {
      totals = await queryMetaAirAttributionAdsOnlyTotals(start, end);
      const top = await queryMetaAirAttributionAdsOnly(
        start, end, groupCols, 12, 0, null, '__all__', 'spend', 'desc',
      );
      chartRows = fmtRows(mapAirAttributionRates(top.rows));
    } else if (dataSource === 'live') {
      const totalJoin = groupFields
        .map(field => `COALESCE(air.${field}, '') = COALESCE(total.${field}, '')`)
        .join(' AND ');
      const live = await pgQuery(`
      WITH attr AS (
        SELECT *
        FROM tw_air_order_attribution
        WHERE brand = 'NOBL'
          AND channel = 'facebook-ads'
          AND model = 'Triple Attribution'
          AND attribution_window = '1_day'
          AND COALESCE(ad_id, '') <> ''
          AND date BETWEEN $1::date AND $2::date
      ), cohort_attr AS (
        SELECT
          a.*,
          s.appstle_id,
          s.customer_id,
          COALESCE(
            s.last_billing_date,
            (CASE
              WHEN jsonb_typeof(s.raw_json->'lastSuccessfulOrder') = 'object'
                THEN (s.raw_json->'lastSuccessfulOrder'->>'orderDate')::timestamptz
              WHEN jsonb_typeof(s.raw_json->'lastSuccessfulOrder') = 'string'
                THEN ((s.raw_json->>'lastSuccessfulOrder')::jsonb->>'orderDate')::timestamptz
              ELSE NULL
            END)
          ) AS paid_billing_date,
          s.created_at AS subscriber_created_at
        FROM tw_air_order_attribution a
        JOIN LATERAL (
          SELECT appstle_id, customer_id, created_at, last_billing_date, raw_json
          FROM nobl_air_subscribers
          WHERE order_name = a.order_name
          UNION
          SELECT appstle_id, customer_id, created_at, last_billing_date, raw_json
          FROM nobl_air_subscribers
          WHERE graph_order_id = CONCAT('gid://shopify/Order/', a.order_id)
          UNION
          SELECT appstle_id, customer_id, created_at, last_billing_date, raw_json
          FROM nobl_air_subscribers
          WHERE graph_order_id = a.order_id
        ) s ON true
        WHERE a.brand = 'NOBL'
          AND a.channel = 'facebook-ads'
          AND a.model = 'Triple Attribution'
          AND a.attribution_window = '1_day'
          AND COALESCE(a.ad_id, '') <> ''
          AND (s.created_at AT TIME ZONE 'UTC')::date + 14 BETWEEN $1::date AND $2::date
      ), air AS (
        SELECT
          ${groupCols},
          COUNT(DISTINCT a.order_id)::int AS air_orders,
          SUM(a.linear_weight)::numeric(14,2) AS attributed_air_orders,
          SUM(a.order_revenue * a.linear_weight)::numeric(14,2) AS attributed_air_revenue
        FROM attr a
        GROUP BY ${groupCols}
      ), cohort AS (
        SELECT
          ${groupCols},
          SUM(linear_weight)::numeric(14,2) AS ttp_mature_air_orders,
          SUM(linear_weight) FILTER (WHERE paid_billing_date > subscriber_created_at OR EXISTS (
            SELECT 1
            FROM shopify_orders_raw o
            WHERE o.brand = 'NOBL'
              AND o.is_rebill
              AND (
                ca.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
                OR ca.customer_id = o.customer_id
              )
              AND o.created_at > ca.subscriber_created_at
          ))::numeric(14,2) AS ttp_paid_air_orders,
          COUNT(DISTINCT appstle_id)::int AS ttp_mature_subscribers,
          COUNT(DISTINCT appstle_id) FILTER (WHERE paid_billing_date > subscriber_created_at OR EXISTS (
            SELECT 1
            FROM shopify_orders_raw o
            WHERE o.brand = 'NOBL'
              AND o.is_rebill
              AND (
                ca.customer_id = REPLACE(o.customer_id, 'gid://shopify/Customer/', '')
                OR ca.customer_id = o.customer_id
              )
              AND o.created_at > ca.subscriber_created_at
          ))::int AS ttp_paid_subscribers
        FROM cohort_attr ca
        GROUP BY ${groupCols}
      ),
      total AS (
        SELECT
          ${groupCols},
          SUM(spend)::numeric(14,2) AS spend,
          SUM(revenue)::numeric(14,2) AS day_1_revenue,
          SUM(purchases)::numeric(14,2) AS total_attributed_orders,
          CASE
            WHEN SUM(purchases) > 0 THEN ROUND(SUM(revenue) / SUM(purchases), 2)
            ELSE NULL
          END AS aov
        FROM tw_ads_daily
        WHERE brand = 'NOBL'
          AND platform = 'META'
          AND date BETWEEN $1::date AND $2::date
        GROUP BY ${groupCols}
      )
      SELECT
        ${groupFields.map(field => `air.${field}`).join(', ')},
        COALESCE(total.spend, 0)::numeric(14,2) AS spend,
        COALESCE(total.day_1_revenue, 0)::numeric(14,2) AS day_1_revenue,
        total.aov,
        COALESCE(total.total_attributed_orders, 0)::numeric(14,2) AS total_attributed_orders,
        air.air_orders,
        air.attributed_air_orders,
        air.attributed_air_revenue,
        COALESCE(cohort.ttp_mature_air_orders, 0)::numeric(14,2) AS ttp_mature_air_orders,
        COALESCE(cohort.ttp_paid_air_orders, 0)::numeric(14,2) AS ttp_paid_air_orders,
        COALESCE(cohort.ttp_mature_subscribers, 0)::int AS ttp_mature_subscribers,
        COALESCE(cohort.ttp_paid_subscribers, 0)::int AS ttp_paid_subscribers,
        CASE
          WHEN COALESCE(total.total_attributed_orders, 0) > 0
            THEN ROUND(air.attributed_air_orders / total.total_attributed_orders, 4)
          ELSE NULL
        END AS attach_rate,
        CASE
          WHEN COALESCE(cohort.ttp_mature_air_orders, 0) > 0
            THEN ROUND(cohort.ttp_paid_air_orders / cohort.ttp_mature_air_orders, 4)
          ELSE NULL
        END AS ttp_rate,
        CASE
          WHEN COALESCE(total.total_attributed_orders, 0) > 0 AND COALESCE(cohort.ttp_mature_air_orders, 0) > 0
            THEN ROUND((air.attributed_air_orders / total.total_attributed_orders) * (cohort.ttp_paid_air_orders / cohort.ttp_mature_air_orders), 4)
          ELSE NULL
        END AS activation_rate
      FROM air
      LEFT JOIN total ON ${totalJoin}
      LEFT JOIN cohort ON ${groupFields.map(field => `COALESCE(air.${field}, '') = COALESCE(cohort.${field}, '')`).join(' AND ')}
      ORDER BY attributed_air_orders DESC, attributed_air_revenue DESC
    `, [start, end]);
      const liveRows = mapAirAttributionRates(live.rows);
      totalRows = liveRows.length;
      totals = buildAirAttributionTotals(liveRows.reduce((acc, row) => ({
        spend: acc.spend + Number(row.spend || 0),
        day_1_revenue: acc.day_1_revenue + Number(row.day_1_revenue || 0),
        total_attributed_orders: acc.total_attributed_orders + Number(row.total_attributed_orders || 0),
        air_orders: acc.air_orders + Number(row.air_orders || 0),
        attributed_air_orders: acc.attributed_air_orders + Number(row.attributed_air_orders || 0),
        attributed_air_revenue: acc.attributed_air_revenue + Number(row.attributed_air_revenue || 0),
        ttp_mature_air_orders: acc.ttp_mature_air_orders + Number(row.ttp_mature_air_orders || 0),
        ttp_paid_air_orders: acc.ttp_paid_air_orders + Number(row.ttp_paid_air_orders || 0),
        ttp_mature_subscribers: acc.ttp_mature_subscribers + Number(row.ttp_mature_subscribers || 0),
        ttp_paid_subscribers: acc.ttp_paid_subscribers + Number(row.ttp_paid_subscribers || 0),
      }), {
        spend: 0, day_1_revenue: 0, total_attributed_orders: 0, air_orders: 0,
        attributed_air_orders: 0, attributed_air_revenue: 0,
        ttp_mature_air_orders: 0, ttp_paid_air_orders: 0,
        ttp_mature_subscribers: 0, ttp_paid_subscribers: 0,
      }));
      chartRows = fmtRows(liveRows.slice(0, 12));
      liveRowsCached = fmtRows(liveRows);
    }

    return {
      data_source: dataSource,
      totals,
      total_rows: totalRows,
      chart_rows: chartRows,
      level,
      start,
      end,
      source,
      cache_hint: cacheHint,
      live_rows: liveRowsCached,
    };
    });

    let rows = [];
    let tableTotalRows = meta.total_rows || 0;
    if (meta.data_source === 'live' && meta.live_rows) {
      const liveRows = sortLiveAirAttrRows(
        filterLiveAirAttrRows(meta.live_rows, searchPattern, searchColumn),
        sortSqlCol,
        sortDir,
      );
      tableTotalRows = liveRows.length;
      rows = liveRows.slice(offset, offset + pageSize);
    } else if (meta.data_source !== 'empty') {
      if (searchPattern) {
        if (meta.data_source === 'cache') {
          tableTotalRows = await queryMetaAirAttributionGroupedCount(
            start, end, groupCols, groupFields, searchPattern, searchColumn,
          );
        } else if (meta.data_source === 'meta_ads_only') {
          tableTotalRows = await queryMetaAirAttributionAdsOnlyCount(start, end, groupCols, searchPattern, searchColumn);
        }
      }
      rows = await fetchAirAttributionPage(
        meta.data_source, start, end, groupCols, groupFields, pageSize, offset,
        searchPattern, searchColumn, sortSqlCol, sortDir,
      );
    }

    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    res.json({
      rows,
      chart_rows: meta.chart_rows || [],
      totals: meta.totals || {},
      pagination: buildPagination(page, pageSize, tableTotalRows),
      level,
      start,
      end,
      source: meta.source,
      cache_hint: meta.cache_hint,
    });
  } catch (e) {
    console.error('[Analytics /nobl/air-attribution]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/air-subscribers — subscriber-level analytics from nobl_air_subscribers
router.get('/nobl/air-subscribers', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
    const { version } = await getNoblAirDataVersion();
    const cacheKey = `subs:${start}:${end}`;
    const { body, hit } = await withResponseCache('nobl-air', cacheKey, version, async () => {
    // Status counts (across all contracts)
    const statusRes = await pgQuery(`
      SELECT status, COUNT(*)::int AS n
      FROM nobl_air_subscribers
      GROUP BY status ORDER BY n DESC`);

    const tierRes = await pgQuery(`
      SELECT
        ROUND(contract_amount)::int AS tier,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'active')::int AS active,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'paused')::int AS paused
      FROM nobl_air_subscribers
      WHERE ROUND(contract_amount) IN (49, 79, 89, 99, 109, 119, 129, 139, 149, 159)
      GROUP BY tier ORDER BY tier`);

    // Estimated MRR — sum of contract_amount for active subs (assumes monthly billing)
    const mrrRes = await pgQuery(`
      SELECT
        COALESCE(SUM(contract_amount), 0)::numeric(14,2) AS active_arr,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'active')::int AS active_count
      FROM nobl_air_subscribers
      WHERE LOWER(TRIM(status)) = 'active'`);

    return {
      status:       statusRes.rows,
      tiers:        tierRes.rows,
      active_arr:   Number(mrrRes.rows[0]?.active_arr || 0),
      active_count: mrrRes.rows[0]?.active_count || 0,
    };
    });
    res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
    res.json(body);
  } catch (e) {
    console.error('[Analytics /nobl/air-subscribers]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /flo/products
router.get('/flo/products', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
    const version = await getDataVersion();
    const { body } = await withResponseCache('flo-products', `fp:${start}:${end}`, version, async () => {
    const r = await pgQuery(
      `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
              brand, product_line, spend, new_cust_orders, revenue,
              meta_spend, google_spend, tiktok_spend, snap_spend, pinterest_spend, bing_spend, applovin_spend
       FROM flo_brand_tw_product_daily
       WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, product_line`,
      [start, end]
    );
    return { rows: fmtRows(r.rows) };
    });
    res.json(body);
  } catch (e) {
    console.error('[Analytics /flo/products]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /sync/status
router.get('/sync/status', async (req, res) => {
  try {
    const [recentRes, lastSuccessRes] = await Promise.all([
      pgQuery(
        `SELECT id, run_id, brand, task, start_date, end_date, status,
                rows_written, error_message, started_at, finished_at
         FROM etl_run_log ORDER BY started_at DESC LIMIT 20`,
        []
      ),
      pgQuery(
        `SELECT DISTINCT ON (brand, task) brand, task, status, finished_at, rows_written
         FROM etl_run_log WHERE status='success'
         ORDER BY brand, task, finished_at DESC`,
        []
      ),
    ]);
    res.json({
      recent: fmtRows(recentRes.rows),
      last_success: fmtRows(lastSuccessRes.rows),
    });
  } catch (e) {
    console.error('[Analytics /sync/status]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
