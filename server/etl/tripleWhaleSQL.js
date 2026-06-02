/**
 * Triple Whale ETL — rewritten to use the working `/orcabase/api/sql` endpoint
 * with Brad's exact queries from the Apps Script. This replaces the Summary-API
 * approach (which gave inflated MTA numbers + missed EU + missed Amazon).
 *
 * Tables refreshed:
 *   tw_summary_daily     — total_revenue (= Shopify + Amazon for the selected brand),
 *                          total_spend (= ads_table channel-reported spend), order counts.
 *   tw_channel_daily     — per-channel spend / revenue using Triple Attribution +
 *                          1-day click window (matches the TW dashboard UI).
 *   tw_geo_daily         — per-region revenue + spend (US/CA/AUS/DUBAI/EU/TOTAL).
 *   tw_product_daily     — FLO product-line breakdown (portable/wooden/metal).
 *
 * Timezone: America/New_York (matches Brad's reportTz; the date keys here are
 * the dates as Brad's report displays them).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgRun } = require('../db/postgres');
const { twSqlQuery, brandCreds } = require('./twSqlApi');

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
};

// Per-brand config controls which sources contribute to total_revenue & total_spend.
// FLO EU is a separate business unit and must not be included in FLO totals.
const BRAND_CONFIG = {
  NOBL: { includeAmazon: true,  euBrand: null      /* main Shopify includes EU   */ },
  FLO:  { includeAmazon: false, euBrand: null      /* FLO US only; exclude EU    */ },
};

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

async function fetchAmazonRevenue(brand, startYmd, endYmd) {
  const rows = await twSqlQuery(brand,
    `SELECT ot.event_date AS event_date,
            COALESCE(SUM(ot.gross_product_sales), 0) AS amazon_revenue
     FROM orders_table AS ot
     WHERE ot.event_date BETWEEN DATE '${startYmd}' AND DATE '${endYmd}'
       AND ot.platform = 'amazon'
       AND ot.amazon_fulfillment_status != 'Canceled'
     GROUP BY ot.event_date ORDER BY ot.event_date`,
    { period: { startDate: startYmd, endDate: endYmd } });
  return indexByDate(rows, 'amazon_revenue');
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

async function fetchChannelMetrics(brand, startYmd, endYmd) {
  // pixel_joined_tvf with Triple Attribution + 1_day window — matches TW dashboard
  const rows = await twSqlQuery(brand,
    `SELECT pjt.event_date AS event_date, pjt.channel AS channel,
            COALESCE(SUM(pjt.spend), 0) AS spend,
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

  const [shopRev, amzRev, spend, orders, regionRev, channelRows] = await Promise.all([
    fetchShopifyRevenue(brand, startYmd, endYmd),
    cfg.includeAmazon ? fetchAmazonRevenue(brand, startYmd, endYmd) : Promise.resolve({}),
    fetchBlendedSpend(brand, startYmd, endYmd),
    fetchOrderCounts(brand, startYmd, endYmd),
    fetchRegionRevenue(brand, startYmd, endYmd),
    fetchChannelMetrics(brand, startYmd, endYmd),
  ]);

  // Optional EU shop support. FLO EU is intentionally excluded from FLO totals;
  // NOBL EU is also not added here because NOBL's main shop already includes EU.
  let euRev = {};
  let euSpend = {};
  if (cfg.euBrand) {
    try {
      const [er, es] = await Promise.all([
        fetchShopifyRevenue(cfg.euBrand, startYmd, endYmd),
        fetchBlendedSpend(cfg.euBrand,   startYmd, endYmd),
      ]);
      euRev   = scaleMap(er, EU_EUR_TO_USD);
      euSpend = scaleMap(es, EU_EUR_TO_USD);
    } catch (e) {
      console.warn(`[TW SQL] ${brand} EU fetch failed: ${e.message}`);
    }
  }

  // Combine per-day
  const allDates = new Set();
  [shopRev, amzRev, spend, orders, regionRev, euRev, euSpend].forEach(m =>
    Object.keys(m).forEach(d => allDates.add(d)));
  eachDay(startYmd, endYmd, d => allDates.add(d));

  let written = 0;
  for (const date of [...allDates].sort()) {
    const shopVal  = Number(shopRev[date]  || 0);
    const amzVal   = Number(amzRev[date]   || 0);
    const euVal    = Number(euRev[date]    || 0);
    const totalRev = shopVal + amzVal + euVal;
    const totalSp  = Number(spend[date] || 0) + Number(euSpend[date] || 0);
    const ord      = orders[date] || { total_orders: 0, new_customer_orders: 0 };
    const reg      = regionRev[date] || { US: 0, CA: 0, AUS: 0, DUBAI: 0, EU: 0, OTHER: 0 };

    // EU region is only a geo breakdown; separate EU stores are not included
    // in the brand-level FLO total.
    const regionEUForGeo = reg.EU;

    const mer = totalSp > 0 ? totalRev / totalSp : null;
    await pgRun(`
      INSERT INTO tw_summary_daily (
        brand, date,
        total_revenue, order_revenue, shopify_revenue, amazon_revenue,
        total_sales, refund_amount, total_spend, mer,
        total_orders, new_customer_orders, returning_customer_orders
      ) VALUES (
        $1, $2, $3::numeric, $4::numeric, $5::numeric, $6::numeric,
        $7::numeric, 0::numeric, $8::numeric, $9::numeric,
        $10::int, $11::int, $12::int
      )
      ON CONFLICT (brand, date) DO UPDATE SET
        total_revenue   = EXCLUDED.total_revenue,
        order_revenue   = EXCLUDED.order_revenue,
        shopify_revenue = EXCLUDED.shopify_revenue,
        amazon_revenue  = EXCLUDED.amazon_revenue,
        total_sales     = EXCLUDED.total_sales,
        total_spend     = EXCLUDED.total_spend,
        mer             = EXCLUDED.mer,
        total_orders    = EXCLUDED.total_orders,
        new_customer_orders       = EXCLUDED.new_customer_orders,
        returning_customer_orders = EXCLUDED.returning_customer_orders,
        updated_at      = NOW()
    `, [
      brand, date,
      totalRev,                                 // $3 total_revenue
      totalRev,                                 // $4 order_revenue (same)
      shopVal,                                  // $5 shopify_revenue (raw Shopify SQL)
      amzVal,                                   // $6 amazon_revenue
      totalRev,                                 // $7 total_sales (we use the same; we don't have refunds yet)
      totalSp,                                  // $8 total_spend
      mer,                                      // $9 mer
      ord.total_orders,                         // $10
      ord.new_customer_orders,                  // $11
      Math.max(0, ord.total_orders - ord.new_customer_orders), // $12
    ]);
    written++;

    // Geo upsert
    const regions = {
      US:    reg.US,
      CA:    reg.CA,
      AUS:   reg.AUS,
      DUBAI: reg.DUBAI,
      EU:    regionEUForGeo,
      TOTAL: totalRev,
    };
    for (const [region, revenue] of Object.entries(regions)) {
      await pgRun(`
        INSERT INTO tw_geo_daily (brand, date, region, revenue_actual, spend_actual)
        VALUES ($1, $2, $3, $4, NULL)
        ON CONFLICT (brand, date, region) DO UPDATE SET
          revenue_actual = EXCLUDED.revenue_actual,
          updated_at     = NOW()
      `, [brand, date, region, revenue]);
    }
  }

  // Channel upsert (Triple Attribution + 1_day)
  let chWritten = 0;
  for (const row of channelRows) {
    const date = String(row.event_date || '').slice(0, 10);
    const channelKey = CHANNEL_MAP[row.channel];
    if (!date || !channelKey) continue;
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
      brand, date, channelKey,
      sp, rv, purch,
      sp > 0 ? rv / sp : null,
      nc,
      nc > 0 ? sp / nc : null,
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
  fetchChannelMetrics, fetchRegionRevenue, fetchFloProductDaily,
};
