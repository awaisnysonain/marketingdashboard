/**
 * Triple Whale ETL — rewritten to use the working `/orcabase/api/sql` endpoint
 * with Brad's exact queries from the Apps Script. This replaces the Summary-API
 * approach (which gave inflated MTA numbers + missed EU + missed Amazon).
 *
 * Tables refreshed:
 *   tw_summary_daily     — order_revenue (Gross+Ship+Tax−Disc), gross_minus_discounts,
 *                          total_spend (= ads_table), order counts.
 *   tw_channel_daily     — spend from ads_table by channel; revenue/orders from
 *                          pixel_joined_tvf Triple Attribution + 1_day window,
 *                          except AMAZON (NOBL) which uses ads_table conversion_value
 *                          (Amazon Ads platform-attributed OPS).
 *   tw_geo_daily         — revenue from orders_table; spend from ads_table country
 *                          breakdown (US/CA/AUS/DUBAI/EU/OTHER/TOTAL).
 *   tw_product_daily     — FLO product-line breakdown (portable/wooden/metal).
 *
 * Timezone: America/New_York (matches Brad's reportTz; the date keys here are
 * the dates as Brad's report displays them).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgRun } = require('../db/postgres');
const { twSqlQuery, brandCreds } = require('./twSqlApi');
const {
  sqlGrossMinusDiscounts,
  sqlOrderRevenue,
  sqlOrdersPlatformFilter,
} = require('../config/revenueMetrics');

const REPORT_TZ = 'America/New_York';
const EU_EUR_TO_USD = 1.16;

// Channel mapping — TW channel id → display name we use in tw_channel_daily.channel
const CHANNEL_MAP = {
  'facebook-ads':  'META',
  'google-ads':    'GOOGLE',
  'tiktok-ads':    'TIKTOK',
  'snapchat-ads':  'SNAPCHAT',
  'pinterest-ads': 'PINTEREST',
  'bing':          'BING',
  'applovin':      'APPLOVIN',
  'twitter-ads':   'X',
  'amazon':        'AMAZON',
};

const EU_COUNTRY_CODES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
  'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','CH','MC','NO',
]);

// Per-brand config — revenue vs spend EU shop are separate for NOBL.
const BRAND_CONFIG = {
  NOBL: {
    includeAmazon: true,
    euBrand: null,           // main Shopify store revenue includes EU orders
    euSpendBrand: 'NOBL_EU', // only added when TW shopId differs from main (see below)
    includeXChannel: true,
  },
  FLO: {
    includeAmazon: false,
    euBrand: null,
    euSpendBrand: null,      // FLO US only; exclude FLO EU spend
    includeXChannel: false,
  },
};

function mapCountryToSpendRegion(countryRaw) {
  const c = String(countryRaw || '').toUpperCase().trim();
  if (!c || c === 'UNKNOWN' || c === 'NULL') return 'OTHER';
  if (c === 'US' || c === 'USA') return 'US';
  if (c === 'CA' || c === 'CAN') return 'CA';
  if (c === 'AU' || c === 'AUS') return 'AUS';
  if (c === 'AE' || c === 'UAE') return 'DUBAI';
  if (c === 'HK') return 'HK';
  // UK is a first-class region for NOBL — check before EU so GB doesn't fall into EU.
  if (c === 'GB' || c === 'UK') return 'UK';
  if (EU_COUNTRY_CODES.has(c)) return 'EU';
  return 'OTHER';
}

function mapTwChannelToKey(twChannel, brand) {
  const key = CHANNEL_MAP[String(twChannel || '').toLowerCase().trim()];
  if (!key) return null;
  if (key === 'X' && !BRAND_CONFIG[brand]?.includeXChannel) return null;
  return key;
}

/** CAC denominator — Amazon Ads has no new-customer split; use conversions (purchases). */
function channelCac(channel, spend, newCust, purchases) {
  const sp = Number(spend || 0);
  if (sp <= 0) return null;
  if (channel === 'AMAZON') {
    const denom = Number(purchases || 0) || Number(newCust || 0);
    return denom > 0 ? sp / denom : null;
  }
  const nc = Number(newCust || 0);
  return nc > 0 ? sp / nc : null;
}

function nextYmd(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function eachDay(start, end, fn) {
  const d = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  while (d.getTime() <= e.getTime()) {
    fn(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
function indexByDate(rows, key) {
  const out = {};
  (rows || []).forEach(r => {
    const ymd = String(r?.event_date || '').slice(0, 10);
    if (ymd) out[ymd] = Number(r?.[key] || 0);
  });
  return out;
}
function addMaps(a, b) {
  const out = {};
  Object.keys(a || {}).concat(Object.keys(b || {})).forEach(k => {
    if (out[k] !== undefined) return;
    out[k] = Number((a || {})[k] || 0) + Number((b || {})[k] || 0);
  });
  return out;
}
function scaleMap(m, factor) {
  const out = {};
  Object.keys(m || {}).forEach(k => out[k] = Number(m[k] || 0) * factor);
  return out;
}

// ─── Per-source fetchers (Brad's exact queries) ─────────────────────────────

async function fetchShopifyRevenue(brand, startYmd, endYmd) {
  const rows = await twSqlQuery(brand,
    `SELECT ot.event_date AS event_date, COALESCE(SUM(ot.order_revenue), 0) AS revenue
     FROM orders_table AS ot
     WHERE ot.platform = 'shopify'
       AND ot.event_date >= DATE '${startYmd}' AND ot.event_date < DATE '${nextYmd(endYmd)}'
     GROUP BY ot.event_date ORDER BY ot.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });
  return indexByDate(rows, 'revenue');
}

/** Dual revenue metrics from orders_table (TW-aligned amazon fee adjustment when includeAmazon). */
async function fetchDualRevenueMetrics(brand, startYmd, endYmd) {
  const cfg = BRAND_CONFIG[brand];
  if (!cfg) throw new Error('Unknown brand: ' + brand);
  const gmdExpr = sqlGrossMinusDiscounts(cfg.includeAmazon);
  const ordExpr = sqlOrderRevenue(cfg.includeAmazon);
  const platformFilter = sqlOrdersPlatformFilter(cfg.includeAmazon);

  const rows = await twSqlQuery(brand,
    `SELECT ot.event_date AS event_date,
            COALESCE(SUM(${gmdExpr}), 0) AS gross_minus_discounts,
            COALESCE(SUM(${ordExpr}), 0) AS order_revenue
     FROM orders_table AS ot
     WHERE ${platformFilter}
       AND ot.event_date >= DATE '${startYmd}' AND ot.event_date <= DATE '${endYmd}'
     GROUP BY ot.event_date ORDER BY ot.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });

  const out = {};
  (rows || []).forEach(r => {
    const ymd = String(r?.event_date || '').slice(0, 10);
    if (!ymd) return;
    out[ymd] = {
      gross_minus_discounts: Number(r?.gross_minus_discounts || 0),
      order_revenue:         Number(r?.order_revenue || 0),
    };
  });
  return out;
}

/** Shopify-only order revenue from blended_stats (for amazon_revenue split). */
async function fetchBlendedShopifyRevenue(brand, startYmd, endYmd) {
  const rows = await twSqlQuery(brand,
    `SELECT bst.event_date AS event_date,
            COALESCE(SUM(bst.order_revenue), 0) AS shopify_revenue
     FROM blended_stats_tvf(include_amazon=FALSE) AS bst
     WHERE bst.event_date >= '${startYmd}' AND bst.event_date <= '${endYmd}'
     GROUP BY bst.event_date ORDER BY bst.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });
  return indexByDate(rows, 'shopify_revenue');
}

/** Total Amazon marketplace order revenue (topline split; Seller Central OPS basis). */
async function fetchAmazonRevenue(brand, startYmd, endYmd) {
  const ordExpr = sqlOrderRevenue(true);
  const rows = await twSqlQuery(brand,
    `SELECT ot.event_date AS event_date,
            COALESCE(SUM(${ordExpr}), 0) AS amazon_revenue
     FROM orders_table AS ot
     WHERE ot.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
       AND ot.platform = 'amazon'
       AND ot.amazon_fulfillment_status != 'Canceled'
     GROUP BY ot.event_date ORDER BY ot.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });
  return indexByDate(rows, 'amazon_revenue');
}

/** Amazon marketplace order counts (orders_table) for channel daily fallback. */
async function fetchAmazonOrderCounts(brand, startYmd, endYmd) {
  const rows = await twSqlQuery(brand,
    `SELECT ot.event_date AS event_date,
            uniq(ot.order_id) AS total_orders,
            uniqIf(ot.order_id, ot.is_new_customer = 1) AS new_customer_orders
     FROM orders_table AS ot
     WHERE ot.platform = 'amazon'
       AND ot.amazon_fulfillment_status != 'Canceled'
       AND ot.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
     GROUP BY ot.event_date ORDER BY ot.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });
  const out = {};
  (rows || []).forEach((r) => {
    const ymd = String(r?.event_date || '').slice(0, 10);
    if (!ymd) return;
    out[ymd] = {
      total_orders: Number(r?.total_orders || 0),
      new_customer_orders: Number(r?.new_customer_orders || 0),
    };
  });
  return out;
}

async function fetchAdSpend(brand, startYmd, endYmd) {
  const rows = await twSqlQuery(brand,
    `SELECT adt.event_date AS event_date,
            COALESCE(SUM(adt.spend), 0) AS total_ad_spend
     FROM ads_table AS adt
     WHERE adt.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
     GROUP BY adt.event_date ORDER BY adt.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });
  return indexByDate(rows, 'total_ad_spend');
}

// Backward-compatible name: this now intentionally uses ads_table instead of
// blended_stats_tvf so custom expenses marked as ad spend are excluded.
const fetchBlendedSpend = fetchAdSpend;

async function fetchOrderCounts(brand, startYmd, endYmd) {
  // total orders + new customer orders, broken down via orders_table
  const rows = await twSqlQuery(brand,
    `SELECT ot.event_date AS event_date,
            uniq(ot.order_id) AS total_orders,
            uniqIf(ot.order_id, ot.is_new_customer = 1) AS new_customer_orders
     FROM orders_table AS ot
     WHERE ot.platform = 'shopify'
       AND ot.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
     GROUP BY ot.event_date ORDER BY ot.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });
  const out = {};
  (rows || []).forEach(r => {
    const ymd = String(r?.event_date || '').slice(0, 10);
    if (!ymd) return;
    out[ymd] = {
      total_orders:        Number(r?.total_orders || 0),
      new_customer_orders: Number(r?.new_customer_orders || 0),
    };
  });
  return out;
}

async function fetchRegionRevenue(brand, startYmd, endYmd) {
  // Returns { ymd: { US, CA, AUS, DUBAI, EU, TOTAL } } using shipping country
  const rows = await twSqlQuery(brand,
    `SELECT ot.event_date AS event_date,
            CASE
              WHEN ot.customer_from_country_code = 'US' THEN 'US'
              WHEN ot.customer_from_country_code = 'CA' THEN 'CA'
              WHEN ot.customer_from_country_code = 'AU' THEN 'AUS'
              WHEN ot.customer_from_country_code = 'AE' THEN 'DUBAI'
              WHEN ot.customer_from_country_code IN ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','CH','MC','NO') THEN 'EU'
              ELSE 'OTHER'
            END AS region,
            COALESCE(SUM(ot.order_revenue), 0) AS revenue
     FROM orders_table AS ot
     WHERE ot.platform = 'shopify'
       AND ot.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
     GROUP BY ot.event_date, region ORDER BY ot.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });
  const out = {};
  (rows || []).forEach(r => {
    const ymd = String(r?.event_date || '').slice(0, 10);
    if (!ymd) return;
    if (!out[ymd]) out[ymd] = { US: 0, CA: 0, AUS: 0, DUBAI: 0, EU: 0, OTHER: 0 };
    out[ymd][r.region] = Number(r.revenue || 0);
  });
  return out;
}

async function fetchChannelSpend(brand, startYmd, endYmd) {
  // Channel-reported spend from ads_table — matches TW Ads dashboard.
  const rows = await twSqlQuery(brand,
    `SELECT adt.event_date AS event_date, adt.channel AS channel,
            COALESCE(SUM(adt.spend), 0) AS spend
     FROM ads_table AS adt
     WHERE adt.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
     GROUP BY adt.event_date, adt.channel
     ORDER BY adt.event_date, adt.channel`,
    { period: { startDate: startYmd, endDate: endYmd } });
  const out = {};
  (rows || []).forEach(r => {
    const ymd = String(r?.event_date || '').slice(0, 10);
    const ch = mapTwChannelToKey(r.channel, brand);
    if (!ymd || !ch) return;
    if (!out[ymd]) out[ymd] = {};
    out[ymd][ch] = (out[ymd][ch] || 0) + Number(r.spend || 0);
  });
  return out;
}

async function fetchRegionSpend(brand, startYmd, endYmd) {
  // Country breakdown from ads_table — US/CA/AUS/Dubai/EU are actual, not residual.
  const rows = await twSqlQuery(brand,
    `SELECT adt.event_date AS event_date, adt.breakdown_value AS country,
            COALESCE(SUM(adt.spend), 0) AS spend
     FROM ads_table AS adt
     WHERE adt.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
       AND adt.breakdown_dimension = 'country'
     GROUP BY adt.event_date, adt.breakdown_value
     ORDER BY adt.event_date, adt.breakdown_value`,
    { period: { startDate: startYmd, endDate: endYmd } });
  const out = {};
  (rows || []).forEach(r => {
    const ymd = String(r?.event_date || '').slice(0, 10);
    if (!ymd) return;
    if (!out[ymd]) out[ymd] = { US: 0, CA: 0, AUS: 0, DUBAI: 0, EU: 0, OTHER: 0 };
    const region = mapCountryToSpendRegion(r.country);
    out[ymd][region] = (out[ymd][region] || 0) + Number(r.spend || 0);
  });
  return out;
}

async function fetchChannelAttribution(brand, startYmd, endYmd) {
  // Revenue / orders from pixel_joined — spend intentionally excluded (ads_table only).
  const rows = await twSqlQuery(brand,
    `SELECT pjt.event_date AS event_date, pjt.channel AS channel,
            COALESCE(SUM(pjt.order_revenue), 0) AS revenue,
            COALESCE(SUM(pjt.orders_quantity), 0) AS purchases,
            COALESCE(SUM(pjt.new_customer_orders), 0) AS new_customer_orders
     FROM pixel_joined_tvf() AS pjt
     WHERE pjt.model = 'Triple Attribution'
       AND pjt.attribution_window = '1_day'
       AND pjt.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
     GROUP BY pjt.event_date, pjt.channel ORDER BY pjt.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });
  return rows || [];
}

/** Amazon Ads channel — pixel attribution is 0; use ads_table platform attribution. */
async function fetchAmazonChannelMetrics(brand, startYmd, endYmd) {
  const cfg = BRAND_CONFIG[brand];
  if (!cfg?.includeAmazon) return {};

  const rows = await twSqlQuery(brand,
    `SELECT adt.event_date AS event_date,
            COALESCE(SUM(adt.spend), 0) AS spend,
            COALESCE(SUM(adt.conversion_value), 0) AS revenue,
            COALESCE(SUM(adt.conversions), 0) AS purchases
     FROM ads_table AS adt
     WHERE adt.channel = 'amazon'
       AND adt.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
     GROUP BY adt.event_date ORDER BY adt.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });

  const out = {};
  (rows || []).forEach(r => {
    const ymd = String(r?.event_date || '').slice(0, 10);
    if (!ymd) return;
    const purchases = Number(r.purchases || 0);
    out[ymd] = {
      spend: Number(r.spend || 0),
      revenue: Number(r.revenue || 0),
      purchases,
      // TW ads_table has no new-customer split for Amazon — use conversions as proxy.
      new_customer_orders: purchases,
    };
  });
  return out;
}

/** Amazon marketplace fulfillment cost (COGS + handling) when ads spend is zero. */
async function fetchAmazonMarketplaceCosts(brand, startYmd, endYmd) {
  const rows = await twSqlQuery(brand,
    `SELECT ot.event_date AS event_date,
            COALESCE(SUM(ot.cost_of_goods), 0)
              + COALESCE(SUM(ot.handling_fees), 0) AS marketplace_cost
     FROM orders_table AS ot
     WHERE ot.platform = 'amazon'
       AND ot.amazon_fulfillment_status != 'Canceled'
       AND ot.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
     GROUP BY ot.event_date ORDER BY ot.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });
  const out = {};
  (rows || []).forEach((r) => {
    const ymd = String(r?.event_date || '').slice(0, 10);
    if (!ymd) return;
    out[ymd] = Number(r?.marketplace_cost || 0);
  });
  return out;
}

/** @deprecated use fetchChannelAttribution + fetchChannelSpend */
async function fetchChannelMetrics(brand, startYmd, endYmd) {
  return fetchChannelAttribution(brand, startYmd, endYmd);
}

async function fetchFloProductDaily(brand, startYmd, endYmd) {
  // FLO product tab source of truth:
  //   - Spend: ads_table channel-reported spend, categorized by adset/campaign/ad names.
  //            Mixed and unclassified rows are kept separate so product totals are not inflated.
  //   - Units/revenue: product_analytics_tvf product/collection rows.
  const spendRows = await twSqlQuery(brand,
    `WITH ads_classified AS (
       SELECT
         adt.event_date AS event_date,
         CASE
           WHEN adt.channel = 'facebook-ads' THEN 'META'
           WHEN adt.channel = 'google-ads' THEN 'GOOGLE'
           WHEN adt.channel = 'tiktok-ads' THEN 'TIKTOK'
           WHEN adt.channel = 'snapchat-ads' THEN 'SNAPCHAT'
           WHEN adt.channel = 'pinterest-ads' THEN 'PINTEREST'
           WHEN adt.channel = 'bing' THEN 'BING'
           WHEN adt.channel = 'applovin' THEN 'APPLOVIN'
           ELSE 'OTHER'
         END AS sheet_group,
         CASE
           WHEN lowerUTF8(coalesce(adt.adset_name, '')) = 'portable'
             OR lowerUTF8(coalesce(adt.adset_name, '')) LIKE '%portable pilates reformer%'
             OR lowerUTF8(coalesce(adt.adset_name, '')) LIKE '%portable-pdp%'
             OR lowerUTF8(coalesce(adt.adset_name, '')) LIKE '%flo portable%' THEN 'portable'
           WHEN lowerUTF8(coalesce(adt.adset_name, '')) = 'studio'
             OR lowerUTF8(coalesce(adt.adset_name, '')) LIKE '%studio reformer%'
             OR lowerUTF8(coalesce(adt.adset_name, '')) LIKE '%wood reformer%'
             OR lowerUTF8(coalesce(adt.adset_name, '')) LIKE '%wooden reformer%' THEN 'wooden'
           WHEN lowerUTF8(coalesce(adt.adset_name, '')) = 'metal'
             OR lowerUTF8(coalesce(adt.adset_name, '')) LIKE '%home reformer%'
             OR lowerUTF8(coalesce(adt.adset_name, '')) LIKE '%metal reformer%' THEN 'metal'

           WHEN lowerUTF8(coalesce(adt.campaign_name, '')) LIKE '%all mixed%'
             OR lowerUTF8(coalesce(adt.adset_name, '')) LIKE '%all mixed%'
             OR lowerUTF8(coalesce(adt.ad_name, '')) LIKE '%all mixed%'
             OR lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%portable + studio%'
             OR lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%portable + metal%'
             OR lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%studio + metal%'
             OR lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%portable + studio + home%'
             OR lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%portable + studio + metal%' THEN 'mixed'

           WHEN lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%studio%'
             OR lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%wood%' THEN 'wooden'
           WHEN lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%metal%'
             OR lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%home%' THEN 'metal'
           WHEN lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%portable%'
             OR lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%reformer pro%'
             OR lowerUTF8(concat(coalesce(adt.campaign_name, ''), ' ', coalesce(adt.adset_name, ''), ' ', coalesce(adt.ad_name, ''))) LIKE '%reformer board%' THEN 'portable'
           ELSE 'unclassified'
         END AS product_line,
         adt.spend AS raw_spend
       FROM ads_table AS adt
       WHERE adt.event_date >= toDate('${startYmd}') AND adt.event_date < toDate('${nextYmd(endYmd)}')
     )
     SELECT
       event_date,
       product_line,
       SUM(raw_spend) AS spend,
       SUM(CASE WHEN sheet_group = 'META' THEN raw_spend ELSE 0 END) AS meta_spend,
       SUM(CASE WHEN sheet_group = 'GOOGLE' THEN raw_spend ELSE 0 END) AS google_spend,
       SUM(CASE WHEN sheet_group = 'TIKTOK' THEN raw_spend ELSE 0 END) AS tiktok_spend,
       SUM(CASE WHEN sheet_group = 'SNAPCHAT' THEN raw_spend ELSE 0 END) AS snap_spend,
       SUM(CASE WHEN sheet_group = 'PINTEREST' THEN raw_spend ELSE 0 END) AS pinterest_spend,
       SUM(CASE WHEN sheet_group = 'BING' THEN raw_spend ELSE 0 END) AS bing_spend,
       SUM(CASE WHEN sheet_group = 'APPLOVIN' THEN raw_spend ELSE 0 END) AS applovin_spend
     FROM ads_classified
     GROUP BY event_date, product_line
     ORDER BY event_date, product_line`,
    { period: { startDate: startYmd, endDate: endYmd } });

  const portableRows = await twSqlQuery(brand,
    `SELECT
       pat.event_date AS event_date,
       'portable' AS product_line,
       SUM(pat.total_items_sold) AS units_sold,
       SUM(pat.revenue) AS revenue
     FROM product_analytics_tvf AS pat
     WHERE pat.event_date >= toDate('${startYmd}') AND pat.event_date < toDate('${nextYmd(endYmd)}')
       AND pat.entity = 'collection'
       AND lowerUTF8(pat.name) = 'portable reformer'
     GROUP BY pat.event_date
     ORDER BY pat.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });

  const variantRows = await twSqlQuery(brand,
    `SELECT
       pat.event_date AS event_date,
       CASE
         WHEN lowerUTF8(pat.product_name) = 'pilates studio reformer' THEN 'wooden'
         WHEN lowerUTF8(pat.product_name) = 'pilates home reformer' THEN 'metal'
         ELSE NULL
       END AS product_line,
       SUM(pat.total_items_sold) AS units_sold,
       SUM(pat.revenue) AS revenue
     FROM product_analytics_tvf AS pat
     WHERE pat.event_date >= toDate('${startYmd}') AND pat.event_date < toDate('${nextYmd(endYmd)}')
       AND pat.entity = 'variant'
       AND lowerUTF8(pat.product_name) IN ('pilates studio reformer', 'pilates home reformer')
     GROUP BY pat.event_date, product_line
     ORDER BY pat.event_date, product_line`,
    { period: { startDate: startYmd, endDate: endYmd } });

  const merged = new Map();
  function key(row) { return `${String(row.event_date || '').slice(0, 10)}|${row.product_line}`; }
  function ensure(row) {
    const k = key(row);
    if (!merged.has(k)) {
      merged.set(k, {
        event_date: String(row.event_date || '').slice(0, 10),
        product_line: row.product_line,
        spend: 0, revenue: 0, new_customer_orders: 0,
        meta_spend: 0, google_spend: 0, tiktok_spend: 0, snap_spend: 0,
        pinterest_spend: 0, bing_spend: 0, applovin_spend: 0,
      });
    }
    return merged.get(k);
  }

  for (const row of spendRows || []) {
    if (!row.product_line) continue;
    const out = ensure(row);
    out.spend = Number(row.spend || 0);
    out.meta_spend = Number(row.meta_spend || 0);
    out.google_spend = Number(row.google_spend || 0);
    out.tiktok_spend = Number(row.tiktok_spend || 0);
    out.snap_spend = Number(row.snap_spend || 0);
    out.pinterest_spend = Number(row.pinterest_spend || 0);
    out.bing_spend = Number(row.bing_spend || 0);
    out.applovin_spend = Number(row.applovin_spend || 0);
  }
  for (const row of [...(portableRows || []), ...(variantRows || [])]) {
    if (!row.product_line) continue;
    const out = ensure(row);
    out.revenue = Number(row.revenue || 0);
    out.new_customer_orders = Number(row.units_sold || 0);
  }

  return [...merged.values()].sort((a, b) =>
    String(a.event_date).localeCompare(String(b.event_date)) || String(a.product_line).localeCompare(String(b.product_line))
  );
}

// ─── Top-level: refresh one brand's tw_summary_daily + tw_channel_daily ─────

async function refreshBrand(brand, startYmd, endYmd) {
  const cfg = BRAND_CONFIG[brand];
  if (!cfg) throw new Error('Unknown brand: ' + brand);

  console.log(`[TW SQL] ${brand} ${startYmd} → ${endYmd}`);

  if (cfg.euSpendBrand) {
    const { shopId, apiKey } = brandCreds(cfg.euSpendBrand);
    const mainId = brandCreds(brand).shopId;
    if (apiKey && shopId && shopId !== mainId) {
      console.log(`[TW SQL] ${brand} EU spend via ${cfg.euSpendBrand} (${shopId})`);
    } else if (!apiKey) {
      console.warn(`[TW SQL] ${brand} ${cfg.euSpendBrand} skipped — set NOBL_EU_TW_API_KEY for EU ad spend`);
    }
  }
  const dualRev = await fetchDualRevenueMetrics(brand, startYmd, endYmd);
  const shopRev = await fetchBlendedShopifyRevenue(brand, startYmd, endYmd);
  const amzRev = cfg.includeAmazon ? await fetchAmazonRevenue(brand, startYmd, endYmd) : {};
  const spend = await fetchBlendedSpend(brand, startYmd, endYmd);
  const orders = await fetchOrderCounts(brand, startYmd, endYmd);
  const regionRev = await fetchRegionRevenue(brand, startYmd, endYmd);
  const regionSp = await fetchRegionSpend(brand, startYmd, endYmd);
  const channelSpend = await fetchChannelSpend(brand, startYmd, endYmd);
  const channelAttr = await fetchChannelAttribution(brand, startYmd, endYmd);
  const amazonChannel = cfg.includeAmazon
    ? await fetchAmazonChannelMetrics(brand, startYmd, endYmd)
    : {};
  const amazonOrders = cfg.includeAmazon
    ? await fetchAmazonOrderCounts(brand, startYmd, endYmd)
    : {};
  const amazonMarketplaceCosts = cfg.includeAmazon
    ? await fetchAmazonMarketplaceCosts(brand, startYmd, endYmd)
    : {};

  // Optional EU shop — revenue via euBrand, ad spend via euSpendBrand (NOBL only).
  let euRev = {};
  let euSpend = {};
  if (cfg.euBrand) {
    try {
      const er = await fetchShopifyRevenue(cfg.euBrand, startYmd, endYmd);
      euRev = scaleMap(er, EU_EUR_TO_USD);
    } catch (e) {
      console.warn(`[TW SQL] ${brand} EU revenue fetch failed: ${e.message}`);
    }
  }
  if (cfg.euSpendBrand) {
    try {
      const mainCreds = brandCreds(brand);
      const euCreds = brandCreds(cfg.euSpendBrand);
      // Skip when EU workspace points at the same shop (would double-count spend).
      if (euCreds.shopId && euCreds.shopId !== mainCreds.shopId) {
        const es = await fetchBlendedSpend(cfg.euSpendBrand, startYmd, endYmd);
        euSpend = scaleMap(es, EU_EUR_TO_USD);
      }
    } catch (e) {
      console.warn(`[TW SQL] ${brand} EU spend fetch failed: ${e.message}`);
    }
  }

  // Combine per-day
  const allDates = new Set();
  [dualRev, shopRev, amzRev, spend, orders, regionRev, regionSp, channelSpend, euRev, euSpend].forEach(m =>
    Object.keys(m).forEach(d => allDates.add(d)));
  eachDay(startYmd, endYmd, d => allDates.add(d));

  let written = 0;
  for (const date of [...allDates].sort()) {
    const metrics  = dualRev[date] || { gross_minus_discounts: 0, order_revenue: 0 };
    const orderRev = Number(metrics.order_revenue || 0);
    const gmd      = Number(metrics.gross_minus_discounts || 0);
    const shopVal  = cfg.includeAmazon
      ? Math.max(0, orderRev - Number(amzRev[date] || 0))
      : Number(shopRev[date] || orderRev);
    const amzVal   = cfg.includeAmazon
      ? Number(amzRev[date] || 0)
      : 0;
    const totalRev = orderRev;
    const totalSp  = Number(spend[date] || 0) + Number(euSpend[date] || 0);
    const ord      = orders[date] || { total_orders: 0, new_customer_orders: 0 };
    const reg      = regionRev[date] || { US: 0, CA: 0, AUS: 0, DUBAI: 0, EU: 0, OTHER: 0 };
    const regSp    = regionSp[date] || { US: 0, CA: 0, AUS: 0, DUBAI: 0, EU: 0, OTHER: 0 };

    // EU shop ad spend rolls into EU region bucket when NOBL_EU is configured.
    const euSpendVal = Number(euSpend[date] || 0);
    if (euSpendVal > 0) regSp.EU = (regSp.EU || 0) + euSpendVal;

    // Spend with no country breakout (TW "No country breakout" row).
    const breakdownSum = (regSp.US || 0) + (regSp.CA || 0) + (regSp.AUS || 0)
      + (regSp.DUBAI || 0) + (regSp.EU || 0) + (regSp.OTHER || 0);
    const unallocated = Math.max(0, totalSp - breakdownSum);
    if (unallocated > 0) regSp.OTHER = (regSp.OTHER || 0) + unallocated;

    const regionEUForGeo = reg.EU;

    const mer = totalSp > 0 ? totalRev / totalSp : null;
    await pgRun(`
      INSERT INTO tw_summary_daily (
        brand, date,
        total_revenue, order_revenue, gross_minus_discounts,
        shopify_revenue, amazon_revenue,
        total_sales, refund_amount, total_spend, mer,
        total_orders, new_customer_orders, returning_customer_orders
      ) VALUES (
        $1, $2, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7::numeric,
        $8::numeric, 0::numeric, $9::numeric, $10::numeric,
        $11::int, $12::int, $13::int
      )
      ON CONFLICT (brand, date) DO UPDATE SET
        total_revenue         = EXCLUDED.total_revenue,
        order_revenue         = EXCLUDED.order_revenue,
        gross_minus_discounts = EXCLUDED.gross_minus_discounts,
        shopify_revenue       = EXCLUDED.shopify_revenue,
        amazon_revenue        = EXCLUDED.amazon_revenue,
        total_sales           = EXCLUDED.total_sales,
        total_spend           = EXCLUDED.total_spend,
        mer                   = EXCLUDED.mer,
        total_orders          = EXCLUDED.total_orders,
        new_customer_orders       = EXCLUDED.new_customer_orders,
        returning_customer_orders = EXCLUDED.returning_customer_orders,
        updated_at            = NOW()
    `, [
      brand, date,
      totalRev,                                 // $3 total_revenue (= order_revenue)
      orderRev,                                 // $4 order_revenue
      gmd,                                      // $5 gross_minus_discounts
      shopVal,                                  // $6 shopify_revenue
      amzVal,                                   // $7 amazon_revenue
      totalRev,                                 // $8 total_sales (refunds not in this ETL path)
      totalSp,                                  // $9 total_spend
      mer,                                      // $10 mer
      ord.total_orders,                         // $11
      ord.new_customer_orders,                  // $12
      Math.max(0, ord.total_orders - ord.new_customer_orders), // $13
    ]);
    written++;

    // Geo upsert — revenue from orders_table, spend from ads_table country breakdown.
    const geoRows = {
      US:    { revenue: reg.US,    spend: regSp.US },
      CA:    { revenue: reg.CA,    spend: regSp.CA },
      AUS:   { revenue: reg.AUS,   spend: regSp.AUS },
      DUBAI: { revenue: reg.DUBAI, spend: regSp.DUBAI },
      EU:    { revenue: regionEUForGeo, spend: regSp.EU },
      OTHER: { revenue: reg.OTHER || 0, spend: regSp.OTHER || 0 },
      TOTAL: { revenue: totalRev,  spend: totalSp },
    };
    for (const [region, vals] of Object.entries(geoRows)) {
      const sp = Number(vals.spend || 0);
      const rv = Number(vals.revenue || 0);
      const geoMer = sp > 0 ? rv / sp : null;
      await pgRun(`
        INSERT INTO tw_geo_daily (brand, date, region, revenue_actual, spend_actual, mer)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (brand, date, region) DO UPDATE SET
          revenue_actual = EXCLUDED.revenue_actual,
          spend_actual   = EXCLUDED.spend_actual,
          mer            = EXCLUDED.mer,
          updated_at     = NOW()
      `, [brand, date, region, rv, sp, geoMer]);
    }
  }

  // Channel upsert — spend from ads_table, revenue/orders from Triple Attribution.
  await pgRun(
    `DELETE FROM tw_channel_daily WHERE brand = $1 AND date >= $2::date AND date <= $3::date`,
    [brand, startYmd, endYmd],
  );

  const channelMerged = new Map();
  function chKey(date, channel) { return `${date}|${channel}`; }
  function ensureCh(date, channel) {
    const k = chKey(date, channel);
    if (!channelMerged.has(k)) {
      channelMerged.set(k, {
        date, channel, spend: 0, revenue: 0, purchases: 0, new_customer_orders: 0,
      });
    }
    return channelMerged.get(k);
  }

  const daySpend = channelSpend;
  for (const [date, byCh] of Object.entries(daySpend)) {
    for (const [channel, sp] of Object.entries(byCh)) {
      ensureCh(date, channel).spend = Number(sp || 0);
    }
  }
  for (const row of channelAttr) {
    const date = String(row.event_date || '').slice(0, 10);
    const channelKey = mapTwChannelToKey(row.channel, brand);
    if (!date || !channelKey) continue;
    const out = ensureCh(date, channelKey);
    out.revenue = Number(row.revenue || 0);
    out.purchases = Number(row.purchases || 0);
    out.new_customer_orders = Number(row.new_customer_orders || 0);
  }
  // Override AMAZON — pixel_joined has no Amazon attribution; use Amazon Ads platform data.
  for (const [date, metrics] of Object.entries(amazonChannel)) {
    const out = ensureCh(date, 'AMAZON');
    if (Number(metrics.spend || 0) > 0) {
      out.spend = Number(metrics.spend);
    }
    out.revenue = Number(metrics.revenue || 0);
    out.purchases = Number(metrics.purchases || 0);
    out.new_customer_orders = Number(metrics.new_customer_orders || 0);
  }
  // Daily AMAZON channel rows for every day with marketplace sales (orders_table OPS).
  // When ads attribution is zero, use marketplace OPS + order counts + fulfillment cost.
  if (cfg.includeAmazon) {
    for (const [date, opsRaw] of Object.entries(amzRev)) {
      const marketplaceOps = Number(opsRaw || 0);
      const ord = amazonOrders[date] || {};
      if (marketplaceOps <= 0 && !ord.total_orders) continue;
      const out = ensureCh(date, 'AMAZON');
      if (Number(out.revenue || 0) <= 0 && marketplaceOps > 0) {
        out.revenue = marketplaceOps;
      }
      if (Number(out.purchases || 0) <= 0 && Number(ord.total_orders || 0) > 0) {
        out.purchases = Number(ord.total_orders);
      }
      if (Number(out.new_customer_orders || 0) <= 0 && Number(ord.new_customer_orders || 0) > 0) {
        out.new_customer_orders = Number(ord.new_customer_orders);
      }
      if (Number(out.spend || 0) <= 0) {
        const cost = Number(amazonMarketplaceCosts[date] || 0);
        if (cost > 0) out.spend = cost;
      }
    }
  }

  let chWritten = 0;
  for (const row of channelMerged.values()) {
    const sp = Number(row.spend || 0);
    const rv = Number(row.revenue || 0);
    const purch = Number(row.purchases || 0);
    const nc = Number(row.new_customer_orders || 0);
    if (sp === 0 && rv === 0 && purch === 0 && nc === 0) continue;
    await pgRun(`
      INSERT INTO tw_channel_daily
        (brand, date, channel, spend_1d, revenue_1d, purchases_1d, roas_1d, new_cust_orders, cac)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (brand, date, channel) DO UPDATE SET
        spend_1d        = EXCLUDED.spend_1d,
        revenue_1d      = EXCLUDED.revenue_1d,
        purchases_1d    = EXCLUDED.purchases_1d,
        roas_1d         = EXCLUDED.roas_1d,
        new_cust_orders = EXCLUDED.new_cust_orders,
        cac             = EXCLUDED.cac,
        updated_at      = NOW()
    `, [
      brand, row.date, row.channel,
      sp, rv, purch,
      sp > 0 ? rv / sp : null,
      nc,
      channelCac(row.channel, sp, nc, purch),
    ]);
    chWritten++;
  }

  console.log(`  → ${written} summary rows, ${chWritten} channel rows`);

  // FLO products
  if (brand === 'FLO') {
    // Remove stale product_line rows for this window (e.g. mixed/unclassified split).
    await pgRun(
      `DELETE FROM tw_product_daily WHERE brand = $1 AND date >= $2::date AND date <= $3::date`,
      [brand, startYmd, endYmd],
    );
    const productRows = await fetchFloProductDaily(brand, startYmd, endYmd);
    for (const row of productRows) {
      const date = String(row.event_date || '').slice(0, 10);
      if (!date || !row.product_line) continue;
      await pgRun(`
        INSERT INTO tw_product_daily
          (brand, date, product_line, spend, revenue, new_cust_orders,
           meta_spend, google_spend, tiktok_spend, snap_spend, pinterest_spend, bing_spend, applovin_spend)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (brand, date, product_line) DO UPDATE SET
          spend           = EXCLUDED.spend,
          revenue         = EXCLUDED.revenue,
          new_cust_orders = EXCLUDED.new_cust_orders,
          meta_spend      = EXCLUDED.meta_spend,
          google_spend    = EXCLUDED.google_spend,
          tiktok_spend    = EXCLUDED.tiktok_spend,
          snap_spend      = EXCLUDED.snap_spend,
          pinterest_spend = EXCLUDED.pinterest_spend,
          bing_spend      = EXCLUDED.bing_spend,
          applovin_spend  = EXCLUDED.applovin_spend,
          updated_at      = NOW()
      `, [
        brand, date, row.product_line,
        Number(row.spend || 0),
        Number(row.revenue || 0),
        Number(row.new_customer_orders || 0),
        Number(row.meta_spend || 0),
        Number(row.google_spend || 0),
        Number(row.tiktok_spend || 0),
        Number(row.snap_spend || 0),
        Number(row.pinterest_spend || 0),
        Number(row.bing_spend || 0),
        Number(row.applovin_spend || 0),
      ]);
    }
    console.log(`  → ${productRows.length} product rows`);
  }

  return { rows: written, channelRows: chWritten };
}

// Backward-compat alias
async function refreshSummary(brand, startDate, endDate) {
  return refreshBrand(brand, startDate, endDate);
}

module.exports = {
  refreshBrand, refreshSummary,
  fetchShopifyRevenue, fetchAmazonRevenue, fetchBlendedSpend, fetchAdSpend,
  fetchDualRevenueMetrics, fetchBlendedShopifyRevenue,
  fetchChannelAttribution, fetchChannelSpend, fetchChannelMetrics,
  fetchRegionRevenue, fetchRegionSpend, fetchFloProductDaily,
  CHANNEL_MAP, mapTwChannelToKey, mapCountryToSpendRegion,
};
