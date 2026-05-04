require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

/**
 * ══════════════════════════════════════════════════════════════════
 *  TripleWhale Full-Sync ETL
 *
 *  Syncs ALL missing tables from TW's SQL (Willy) API to PostgreSQL.
 *  Each sync function queries the TW ClickHouse table and upserts
 *  rows into the local PG table.
 *
 *  Tables synced here (all were previously ❌ Not synced):
 *    tw_channel_daily      ← ads_table grouped by platform/date   (FIX LAG)
 *    tw_geo_daily          ← blended_stats_tvf geo columns        (FIX LAG)
 *    tw_ads_daily          ← ads_table at campaign/adset/ad level
 *    tw_orders_detail      ← orders_table at order level
 *    tw_sessions_daily     ← sessions_table grouped by date
 *    tw_customers          ← customers_table LTV snapshot
 *    tw_customer_segments  ← customer_segmentation_table RFM
 *    tw_refunds_daily      ← refunds_table grouped by date
 *    tw_email_sms_daily    ← email_sms_table campaign performance
 *    tw_benchmarks         ← benchmarks_table (monthly)
 * ══════════════════════════════════════════════════════════════════
 */

const { pgRun, pgQuery } = require('../db/postgres');
const { twSqlSafe, chDateRange } = require('./twSqlApi');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toDateStr(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function chunksOf(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Map TW platform names → our channel keys
 */
const PLATFORM_MAP = {
  'facebook':       'META',
  'facebook-ads':   'META',
  'meta':           'META',
  'google':         'GOOGLE',
  'google-ads':     'GOOGLE',
  'tiktok':         'TIKTOK',
  'tiktok-ads':     'TIKTOK',
  'snapchat':       'SNAPCHAT',
  'snapchat-ads':   'SNAPCHAT',
  'pinterest':      'PINTEREST',
  'pinterest-ads':  'PINTEREST',
  'bing':           'BING',
  'microsoft-ads':  'BING',
  'twitter':        'X',
  'twitter-ads':    'X',
  'x':              'X',
  'applovin':       'APPLOVIN',
};

function normalizePlatform(raw) {
  const lower = String(raw || '').toLowerCase().trim();
  return PLATFORM_MAP[lower] || String(raw).toUpperCase();
}

/**
 * Map TW country codes → our region keys
 */
function normalizeRegion(country) {
  const upper = String(country || '').toUpperCase().trim();
  const REGION_MAP = {
    'US': 'US', 'USA': 'US', 'UNITED STATES': 'US',
    'CA': 'CA', 'CAN': 'CA', 'CANADA': 'CA',
    'AU': 'AUS', 'AUS': 'AUS', 'AUSTRALIA': 'AUS',
    'AE': 'DUBAI', 'UAE': 'DUBAI', 'UNITED ARAB EMIRATES': 'DUBAI',
    'GB': 'EU', 'DE': 'EU', 'FR': 'EU', 'NL': 'EU', 'ES': 'EU',
    'IT': 'EU', 'SE': 'EU', 'NO': 'EU', 'DK': 'EU', 'FI': 'EU',
    'PT': 'EU', 'BE': 'EU', 'AT': 'EU', 'CH': 'EU', 'IE': 'EU',
    'PL': 'EU', 'CZ': 'EU', 'HU': 'EU', 'RO': 'EU', 'EU': 'EU',
  };
  return REGION_MAP[upper] || upper;
}

// ─────────────────────────────────────────────────────────────────
//  1. CHANNEL DAILY  (fixes the 6-day lag)
// ─────────────────────────────────────────────────────────────────
/**
 * Sync tw_channel_daily from TW ads_table, grouped by date+platform.
 * Replaces/fixes the lagged ETL.
 */
async function syncTWChannels(brand, startDate, endDate) {
  const errors = [];
  let written = 0;
  const dr = chDateRange('date', startDate, endDate);

  const sql = `
    SELECT
      date,
      platform,
      SUM(spend)                                      AS spend_1d,
      SUM(revenue)                                    AS revenue_1d,
      SUM(purchases)                                  AS purchases_1d,
      SUM(revenue) / NULLIF(SUM(spend), 0)            AS roas_1d,
      SUM(clicks)                                     AS clicks,
      SUM(impressions)                                AS impressions,
      SUM(purchases)                                  AS new_cust_orders,
      SUM(spend) / NULLIF(SUM(purchases), 0)          AS cac
    FROM ads_table
    WHERE ${dr}
      AND spend > 0
    GROUP BY date, platform
    ORDER BY date, platform
  `;

  const rows = await twSqlSafe(brand, sql, { period: { startDate, endDate } });
  if (!rows.length) {
    console.log(`[twFullSync] syncTWChannels ${brand}: no rows for ${startDate}→${endDate}`);
    return { rows: 0, errors };
  }

  for (const r of rows) {
    const date    = toDateStr(r.date);
    const channel = normalizePlatform(r.platform);
    try {
      await pgRun(`
        INSERT INTO tw_channel_daily
          (brand, date, channel, spend_1d, revenue_1d, purchases_1d, roas_1d, new_cust_orders, cac)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (brand, date, channel) DO UPDATE SET
          spend_1d     = EXCLUDED.spend_1d,
          revenue_1d   = EXCLUDED.revenue_1d,
          purchases_1d = EXCLUDED.purchases_1d,
          roas_1d      = EXCLUDED.roas_1d,
          new_cust_orders = EXCLUDED.new_cust_orders,
          cac          = EXCLUDED.cac,
          updated_at   = NOW()
      `, [
        brand, date, channel,
        parseFloat(r.spend_1d || 0),
        parseFloat(r.revenue_1d || 0),
        parseInt(r.purchases_1d || 0),
        r.roas_1d ? parseFloat(r.roas_1d) : null,
        parseInt(r.new_cust_orders || 0),
        r.cac ? parseFloat(r.cac) : null,
      ]);
      written++;
    } catch (e) {
      errors.push(`channel ${brand}/${date}/${channel}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWChannels ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

// ─────────────────────────────────────────────────────────────────
//  2. GEO DAILY  (fixes the 6-day lag)
// ─────────────────────────────────────────────────────────────────
async function syncTWGeo(brand, startDate, endDate) {
  const errors = [];
  let written = 0;
  const dr = chDateRange('date', startDate, endDate);

  // blended_stats_tvf gives us revenue and spend broken down by country
  const sql = `
    SELECT
      date,
      country                                         AS region,
      SUM(revenue)                                    AS revenue_actual,
      SUM(spend)                                      AS spend_actual,
      SUM(revenue) / NULLIF(SUM(spend), 0)            AS mer
    FROM blended_stats_tvf('${startDate}', '${endDate}')
    WHERE ${dr}
      AND country IS NOT NULL
      AND country != ''
    GROUP BY date, country
    HAVING SUM(revenue) + SUM(spend) > 0
    ORDER BY date, country
  `;

  const rows = await twSqlSafe(brand, sql, { period: { startDate, endDate } });
  if (!rows.length) {
    console.log(`[twFullSync] syncTWGeo ${brand}: no rows for ${startDate}→${endDate}`);
    return { rows: 0, errors };
  }

  // Also build TOTAL row per date
  const dateMap = {};
  for (const r of rows) {
    const d = toDateStr(r.date);
    if (!dateMap[d]) dateMap[d] = { revenue: 0, spend: 0 };
    dateMap[d].revenue += parseFloat(r.revenue_actual || 0);
    dateMap[d].spend   += parseFloat(r.spend_actual   || 0);
  }

  for (const r of rows) {
    const date   = toDateStr(r.date);
    const region = normalizeRegion(r.region);
    try {
      await pgRun(`
        INSERT INTO tw_geo_daily
          (brand, date, region, revenue_actual, spend_actual, mer)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (brand, date, region) DO UPDATE SET
          revenue_actual = EXCLUDED.revenue_actual,
          spend_actual   = EXCLUDED.spend_actual,
          mer            = EXCLUDED.mer,
          updated_at     = NOW()
      `, [
        brand, date, region,
        parseFloat(r.revenue_actual || 0),
        parseFloat(r.spend_actual   || 0),
        r.mer ? parseFloat(r.mer)   : null,
      ]);
      written++;
    } catch (e) {
      errors.push(`geo ${brand}/${date}/${region}: ${e.message}`);
    }
  }

  // Upsert TOTAL rows
  for (const [date, t] of Object.entries(dateMap)) {
    try {
      const totalMer = t.spend > 0 ? t.revenue / t.spend : null;
      await pgRun(`
        INSERT INTO tw_geo_daily (brand, date, region, revenue_actual, spend_actual, mer)
        VALUES ($1,$2,'TOTAL',$3,$4,$5)
        ON CONFLICT (brand, date, region) DO UPDATE SET
          revenue_actual = EXCLUDED.revenue_actual,
          spend_actual   = EXCLUDED.spend_actual,
          mer            = EXCLUDED.mer,
          updated_at     = NOW()
      `, [brand, date, t.revenue, t.spend, totalMer]);
      written++;
    } catch (e) {
      errors.push(`geo TOTAL ${brand}/${date}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWGeo ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

// ─────────────────────────────────────────────────────────────────
//  3. ADS DAILY  (campaign/adset/ad level)
// ─────────────────────────────────────────────────────────────────
async function syncTWAds(brand, startDate, endDate) {
  const errors = [];
  let written = 0;
  const dr = chDateRange('event_date', startDate, endDate);

  const sql = `
    SELECT
      pjt.event_date AS date,
      pjt.channel AS platform,
      pjt.campaign_id,
      pjt.campaign_name,
      pjt.adset_id,
      pjt.adset_name,
      pjt.ad_id,
      pjt.ad_name,
      SUM(pjt.impressions)          AS impressions,
      SUM(pjt.clicks)               AS clicks,
      SUM(pjt.spend)                AS spend,
      SUM(pjt.orders_quantity)      AS purchases,
      SUM(pjt.order_revenue)        AS revenue,
      SUM(pjt.outbound_clicks)      AS link_clicks,
      SUM(pjt.add_to_carts)         AS add_to_cart,
      SUM(pjt.checkouts)            AS initiate_checkout
    FROM pixel_joined_tvf() AS pjt
    WHERE ${dr}
      AND pjt.channel = 'facebook-ads'
      AND pjt.model = 'Triple Attribution'
      AND pjt.attribution_window = '1_day'
    GROUP BY pjt.event_date, pjt.channel, pjt.campaign_id, pjt.campaign_name, pjt.adset_id, pjt.adset_name, pjt.ad_id, pjt.ad_name
    HAVING SUM(pjt.spend) > 0
  `;

  const rows = await twSqlSafe(brand, sql, { period: { startDate, endDate } });
  if (!rows.length) {
    console.log(`[twFullSync] syncTWAds ${brand}: no rows`);
    return { rows: 0, errors };
  }

  for (const batch of chunksOf(rows, 500)) {
    const values = [];
    const params = [];
    let p = 1;

    for (const r of batch) {
      const date     = toDateStr(r.date);
      const platform = normalizePlatform(r.platform);
      const adId     = String(r.ad_id || `${r.campaign_id}_${r.adset_id}_${r.date}`);
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(
        brand, date, platform,
        String(r.campaign_id || ''), String(r.campaign_name || ''),
        String(r.adset_id    || ''), String(r.adset_name    || ''),
        adId, String(r.ad_name || ''),
        parseInt(r.impressions       || 0),
        parseInt(r.clicks            || 0),
        parseFloat(r.spend           || 0),
        parseInt(r.purchases         || 0),
        parseFloat(r.revenue         || 0),
        parseInt(r.link_clicks       || 0),
        parseInt(r.add_to_cart       || 0),
        parseInt(r.initiate_checkout || 0),
      );
    }

    try {
      await pgRun(`
        INSERT INTO tw_ads_daily
          (brand, date, platform, campaign_id, campaign_name, adset_id, adset_name,
           ad_id, ad_name, impressions, clicks, spend, purchases, revenue,
           link_clicks, add_to_cart, initiate_checkout)
        VALUES ${values.join(', ')}
        ON CONFLICT (brand, date, platform, ad_id) DO UPDATE SET
          campaign_name      = EXCLUDED.campaign_name,
          adset_name         = EXCLUDED.adset_name,
          ad_name            = EXCLUDED.ad_name,
          impressions        = EXCLUDED.impressions,
          clicks             = EXCLUDED.clicks,
          spend              = EXCLUDED.spend,
          purchases          = EXCLUDED.purchases,
          revenue            = EXCLUDED.revenue,
          link_clicks        = EXCLUDED.link_clicks,
          add_to_cart        = EXCLUDED.add_to_cart,
          initiate_checkout  = EXCLUDED.initiate_checkout,
          updated_at         = NOW()
      `, params);
      written += batch.length;
    } catch (e) {
      errors.push(`ads ${brand}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWAds ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

async function ensureTWAirAttributionTable() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS tw_air_order_attribution (
      id                 BIGSERIAL PRIMARY KEY,
      brand              TEXT        NOT NULL,
      date               DATE        NOT NULL,
      order_id           TEXT        NOT NULL,
      order_name         TEXT,
      channel            TEXT        NOT NULL,
      model              TEXT        NOT NULL,
      attribution_window TEXT        NOT NULL,
      campaign_id        TEXT        NOT NULL DEFAULT '',
      campaign_name      TEXT,
      adset_id           TEXT        NOT NULL DEFAULT '',
      adset_name         TEXT,
      ad_id              TEXT        NOT NULL DEFAULT '',
      ad_name            TEXT,
      linear_weight      NUMERIC(14,6) DEFAULT 1,
      order_revenue      NUMERIC(14,4) DEFAULT 0,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (brand, order_id, channel, model, attribution_window, campaign_id, adset_id, ad_id)
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_air_attr_brand_date ON tw_air_order_attribution (brand, date DESC)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_air_attr_channel ON tw_air_order_attribution (brand, channel, date DESC)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_tw_air_attr_adset ON tw_air_order_attribution (brand, adset_id, date DESC)`);
}

async function syncTWAirOrderAttribution(brand, startDate, endDate) {
  const errors = [];
  let written = 0;

  if (brand !== 'NOBL') {
    return { rows: 0, errors };
  }

  await ensureTWAirAttributionTable();

  const sql = `
    SELECT DISTINCT
      event_date AS date,
      order_id,
      order_name,
      channel,
      model,
      attribution_window,
      campaign_id,
      campaign_name,
      adset_id,
      adset_name,
      ad_id,
      ad_name,
      linear_weight,
      order_revenue
    FROM pixel_orders_table ARRAY JOIN products_info AS pi
    WHERE event_date >= toDate('${startDate}') AND event_date < toDate('${addDays(endDate, 1)}')
      AND model = 'Triple Attribution'
      AND attribution_window = '1_day'
      AND lowerUTF8(tupleElement(pi, 'product_name')) LIKE '%nobl air%'
  `;

  const rows = await twSqlSafe(brand, sql, { period: { startDate, endDate } });
  if (!rows.length) {
    console.log(`[twFullSync] syncTWAirOrderAttribution ${brand}: no rows`);
    return { rows: 0, errors };
  }

  for (const batch of chunksOf(rows, 500)) {
    const values = [];
    const params = [];
    let p = 1;

    for (const r of batch) {
      const date = toDateStr(r.date || r.event_date);
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(
        brand,
        date,
        String(r.order_id || ''),
        String(r.order_name || ''),
        String(r.channel || ''),
        String(r.model || ''),
        String(r.attribution_window || ''),
        String(r.campaign_id || ''),
        String(r.campaign_name || ''),
        String(r.adset_id || ''),
        String(r.adset_name || ''),
        String(r.ad_id || ''),
        String(r.ad_name || ''),
        parseFloat(r.linear_weight || 1),
        parseFloat(r.order_revenue || 0),
      );
    }

    try {
      await pgRun(`
        INSERT INTO tw_air_order_attribution
          (brand, date, order_id, order_name, channel, model, attribution_window,
           campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
           linear_weight, order_revenue)
        VALUES ${values.join(', ')}
        ON CONFLICT (brand, order_id, channel, model, attribution_window, campaign_id, adset_id, ad_id)
        DO UPDATE SET
          date               = EXCLUDED.date,
          order_name         = EXCLUDED.order_name,
          campaign_name      = EXCLUDED.campaign_name,
          adset_name         = EXCLUDED.adset_name,
          ad_name            = EXCLUDED.ad_name,
          linear_weight      = EXCLUDED.linear_weight,
          order_revenue      = EXCLUDED.order_revenue,
          updated_at         = NOW()
      `, params);
      written += batch.length;
    } catch (e) {
      errors.push(`air_attr ${brand}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWAirOrderAttribution ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

// ─────────────────────────────────────────────────────────────────
//  4. ORDERS DETAIL  (order-level)
// ─────────────────────────────────────────────────────────────────
async function syncTWOrders(brand, startDate, endDate) {
  const errors = [];
  let written = 0;
  const dr = chDateRange('order_date', startDate, endDate);

  const sql = `
    SELECT
      order_id,
      order_number,
      order_date,
      created_at,
      customer_id,
      financial_status,
      fulfillment_status,
      total_price,
      subtotal_price,
      total_discounts,
      total_tax,
      shipping_price,
      currency,
      country,
      province,
      city,
      utm_source,
      utm_medium,
      utm_campaign,
      is_first_order,
      customer_order_number,
      line_items_count
    FROM orders_table
    WHERE ${dr}
      AND financial_status IN ('paid','partially_refunded','refunded')
    ORDER BY order_date DESC
  `;

  const rows = await twSqlSafe(brand, sql);
  if (!rows.length) {
    console.log(`[twFullSync] syncTWOrders ${brand}: no rows`);
    return { rows: 0, errors };
  }

  for (const r of rows) {
    try {
      await pgRun(`
        INSERT INTO tw_orders_detail
          (brand, order_id, order_number, order_date, created_at_ts, customer_id,
           financial_status, fulfillment_status, total_price, subtotal_price,
           total_discounts, total_tax, shipping_price, country, province, city,
           utm_source, utm_medium, utm_campaign, is_first_order, customer_order_number)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT (brand, order_id) DO UPDATE SET
          financial_status   = EXCLUDED.financial_status,
          fulfillment_status = EXCLUDED.fulfillment_status,
          total_price        = EXCLUDED.total_price,
          total_discounts    = EXCLUDED.total_discounts,
          updated_at         = NOW()
      `, [
        brand,
        String(r.order_id),
        r.order_number ? parseInt(r.order_number) : null,
        toDateStr(r.order_date),
        r.created_at || null,
        String(r.customer_id || ''),
        String(r.financial_status   || ''),
        String(r.fulfillment_status || ''),
        parseFloat(r.total_price     || 0),
        parseFloat(r.subtotal_price  || 0),
        parseFloat(r.total_discounts || 0),
        parseFloat(r.total_tax       || 0),
        parseFloat(r.shipping_price  || 0),
        String(r.country  || ''),
        String(r.province || ''),
        String(r.city     || ''),
        String(r.utm_source   || ''),
        String(r.utm_medium   || ''),
        String(r.utm_campaign || ''),
        Boolean(r.is_first_order),
        r.customer_order_number ? parseInt(r.customer_order_number) : null,
      ]);
      written++;
    } catch (e) {
      errors.push(`orders ${brand}/${r.order_id}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWOrders ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

// ─────────────────────────────────────────────────────────────────
//  5. SESSIONS DAILY
// ─────────────────────────────────────────────────────────────────
async function syncTWSessions(brand, startDate, endDate) {
  const errors = [];
  let written = 0;
  const dr = chDateRange('session_date', startDate, endDate);

  const sql = `
    SELECT
      session_date                                                          AS date,
      COUNT(*)                                                              AS total_sessions,
      SUM(CASE WHEN is_new_visitor = true THEN 1 ELSE 0 END)               AS new_sessions,
      SUM(CASE WHEN is_new_visitor = false THEN 1 ELSE 0 END)              AS returning_sessions,
      SUM(CASE WHEN bounced = true THEN 1 ELSE 0 END)                      AS bounced_sessions,
      SUM(CASE WHEN converted = true THEN 1 ELSE 0 END)                    AS converted_sessions,
      AVG(duration_seconds)                                                 AS avg_duration_seconds,
      SUM(revenue)                                                          AS revenue,
      SUM(CASE WHEN device_type = 'mobile'  THEN 1 ELSE 0 END)             AS device_mobile,
      SUM(CASE WHEN device_type = 'desktop' THEN 1 ELSE 0 END)             AS device_desktop,
      SUM(CASE WHEN device_type = 'tablet'  THEN 1 ELSE 0 END)             AS device_tablet,
      SUM(pageviews)                                                        AS total_pageviews
    FROM sessions_table
    WHERE ${dr}
    GROUP BY session_date
    ORDER BY session_date DESC
  `;

  const rows = await twSqlSafe(brand, sql);
  if (!rows.length) {
    console.log(`[twFullSync] syncTWSessions ${brand}: no rows`);
    return { rows: 0, errors };
  }

  for (const r of rows) {
    const date  = toDateStr(r.date);
    const total = parseInt(r.total_sessions || 0);
    const converted = parseInt(r.converted_sessions || 0);
    const bounced   = parseInt(r.bounced_sessions   || 0);
    try {
      await pgRun(`
        INSERT INTO tw_sessions_daily
          (brand, date, total_sessions, new_sessions, returning_sessions,
           bounced_sessions, bounce_rate, converted_sessions, conversion_rate,
           avg_duration_seconds, revenue, device_mobile, device_desktop, device_tablet, total_pageviews)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (brand, date) DO UPDATE SET
          total_sessions    = EXCLUDED.total_sessions,
          new_sessions      = EXCLUDED.new_sessions,
          returning_sessions= EXCLUDED.returning_sessions,
          bounced_sessions  = EXCLUDED.bounced_sessions,
          bounce_rate       = EXCLUDED.bounce_rate,
          converted_sessions= EXCLUDED.converted_sessions,
          conversion_rate   = EXCLUDED.conversion_rate,
          avg_duration_seconds = EXCLUDED.avg_duration_seconds,
          revenue           = EXCLUDED.revenue,
          device_mobile     = EXCLUDED.device_mobile,
          device_desktop    = EXCLUDED.device_desktop,
          device_tablet     = EXCLUDED.device_tablet,
          total_pageviews   = EXCLUDED.total_pageviews,
          updated_at        = NOW()
      `, [
        brand, date,
        total,
        parseInt(r.new_sessions       || 0),
        parseInt(r.returning_sessions || 0),
        bounced,
        total > 0 ? parseFloat((bounced   / total).toFixed(4)) : null,
        converted,
        total > 0 ? parseFloat((converted / total).toFixed(4)) : null,
        r.avg_duration_seconds ? parseInt(r.avg_duration_seconds) : null,
        parseFloat(r.revenue            || 0),
        parseInt(r.device_mobile  || 0),
        parseInt(r.device_desktop || 0),
        parseInt(r.device_tablet  || 0),
        parseInt(r.total_pageviews || 0),
      ]);
      written++;
    } catch (e) {
      errors.push(`sessions ${brand}/${date}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWSessions ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

// ─────────────────────────────────────────────────────────────────
//  6. CUSTOMERS  (LTV snapshot)
// ─────────────────────────────────────────────────────────────────
async function syncTWCustomers(brand) {
  const errors = [];
  let written = 0;

  const sql = `
    SELECT
      customer_id,
      total_orders,
      total_spent,
      average_order_value,
      first_order_date,
      last_order_date,
      days_since_last_order,
      country,
      customer_cohort,
      first_order_source,
      first_order_medium,
      accepts_marketing
    FROM customers_table
    ORDER BY total_spent DESC
  `;

  const rows = await twSqlSafe(brand, sql);
  if (!rows.length) {
    console.log(`[twFullSync] syncTWCustomers ${brand}: no rows`);
    return { rows: 0, errors };
  }

  for (const r of rows) {
    try {
      await pgRun(`
        INSERT INTO tw_customers
          (brand, customer_id, total_orders, total_spent, average_order_value,
           first_order_date, last_order_date, days_since_last_order,
           country, cohort_month, first_order_source, accepts_marketing)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (brand, customer_id) DO UPDATE SET
          total_orders         = EXCLUDED.total_orders,
          total_spent          = EXCLUDED.total_spent,
          average_order_value  = EXCLUDED.average_order_value,
          last_order_date      = EXCLUDED.last_order_date,
          days_since_last_order= EXCLUDED.days_since_last_order,
          updated_at           = NOW()
      `, [
        brand,
        String(r.customer_id),
        parseInt(r.total_orders   || 0),
        parseFloat(r.total_spent  || 0),
        r.average_order_value ? parseFloat(r.average_order_value) : null,
        r.first_order_date  ? toDateStr(r.first_order_date)  : null,
        r.last_order_date   ? toDateStr(r.last_order_date)   : null,
        r.days_since_last_order ? parseInt(r.days_since_last_order) : null,
        String(r.country || ''),
        r.customer_cohort  ? toDateStr(r.customer_cohort)  : null,
        String(r.first_order_source || ''),
        Boolean(r.accepts_marketing),
      ]);
      written++;
    } catch (e) {
      errors.push(`customers ${brand}/${r.customer_id}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWCustomers ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

// ─────────────────────────────────────────────────────────────────
//  7. CUSTOMER SEGMENTS  (RFM)
// ─────────────────────────────────────────────────────────────────
async function syncTWSegments(brand) {
  const errors = [];
  let written = 0;
  const today = new Date().toISOString().slice(0, 10);

  const sql = `
    SELECT
      customer_id,
      rfm_segment,
      recency_score,
      frequency_score,
      monetary_score,
      days_since_last_order,
      total_orders,
      total_spent,
      avg_order_value,
      churn_risk,
      churn_probability,
      segment_label,
      cohort_month,
      first_order_channel
    FROM customer_segmentation_table
    WHERE segment_date = toDate(now())
    ORDER BY total_spent DESC
  `;

  const rows = await twSqlSafe(brand, sql);
  if (!rows.length) {
    console.log(`[twFullSync] syncTWSegments ${brand}: no rows`);
    return { rows: 0, errors };
  }

  for (const r of rows) {
    try {
      await pgRun(`
        INSERT INTO tw_customer_segments
          (brand, customer_id, segment_date, rfm_segment, recency_score,
           frequency_score, monetary_score, days_since_last_order,
           total_orders, total_spent, churn_risk, churn_probability, segment_label)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (brand, customer_id, segment_date) DO UPDATE SET
          rfm_segment          = EXCLUDED.rfm_segment,
          recency_score        = EXCLUDED.recency_score,
          frequency_score      = EXCLUDED.frequency_score,
          monetary_score       = EXCLUDED.monetary_score,
          days_since_last_order= EXCLUDED.days_since_last_order,
          total_orders         = EXCLUDED.total_orders,
          total_spent          = EXCLUDED.total_spent,
          churn_risk           = EXCLUDED.churn_risk,
          churn_probability    = EXCLUDED.churn_probability,
          segment_label        = EXCLUDED.segment_label,
          updated_at           = NOW()
      `, [
        brand,
        String(r.customer_id),
        today,
        String(r.rfm_segment || ''),
        r.recency_score   ? parseInt(r.recency_score)   : null,
        r.frequency_score ? parseInt(r.frequency_score) : null,
        r.monetary_score  ? parseInt(r.monetary_score)  : null,
        r.days_since_last_order ? parseInt(r.days_since_last_order) : null,
        parseInt(r.total_orders || 0),
        parseFloat(r.total_spent || 0),
        String(r.churn_risk || ''),
        r.churn_probability ? parseFloat(r.churn_probability) : null,
        String(r.segment_label || r.rfm_segment || ''),
      ]);
      written++;
    } catch (e) {
      errors.push(`segments ${brand}/${r.customer_id}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWSegments ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

// ─────────────────────────────────────────────────────────────────
//  8. REFUNDS DAILY
// ─────────────────────────────────────────────────────────────────
async function syncTWRefunds(brand, startDate, endDate) {
  const errors = [];
  let written = 0;
  const dr = chDateRange('refund_date', startDate, endDate);

  const sql = `
    SELECT
      refund_date                              AS date,
      COUNT(DISTINCT refund_id)                AS refund_count,
      SUM(refund_amount)                       AS refund_amount,
      AVG(refund_amount)                       AS avg_refund_amount,
      AVG(days_to_refund)                      AS avg_days_to_refund,
      SUM(quantity_refunded)                   AS units_refunded
    FROM refunds_table
    WHERE ${dr}
    GROUP BY refund_date
    ORDER BY refund_date DESC
  `;

  const rows = await twSqlSafe(brand, sql);
  if (!rows.length) {
    console.log(`[twFullSync] syncTWRefunds ${brand}: no rows`);
    return { rows: 0, errors };
  }

  for (const r of rows) {
    const date = toDateStr(r.date);
    try {
      await pgRun(`
        INSERT INTO tw_refunds_daily
          (brand, date, refund_count, refund_amount, avg_refund_amount, avg_days_to_refund, units_refunded)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (brand, date) DO UPDATE SET
          refund_count       = EXCLUDED.refund_count,
          refund_amount      = EXCLUDED.refund_amount,
          avg_refund_amount  = EXCLUDED.avg_refund_amount,
          avg_days_to_refund = EXCLUDED.avg_days_to_refund,
          units_refunded     = EXCLUDED.units_refunded,
          updated_at         = NOW()
      `, [
        brand, date,
        parseInt(r.refund_count    || 0),
        parseFloat(r.refund_amount || 0),
        r.avg_refund_amount  ? parseFloat(r.avg_refund_amount)  : null,
        r.avg_days_to_refund ? parseFloat(r.avg_days_to_refund) : null,
        parseInt(r.units_refunded  || 0),
      ]);
      written++;
    } catch (e) {
      errors.push(`refunds ${brand}/${date}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWRefunds ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

// ─────────────────────────────────────────────────────────────────
//  9. EMAIL / SMS CAMPAIGN DETAIL
// ─────────────────────────────────────────────────────────────────
async function syncTWEmailSms(brand, startDate, endDate) {
  const errors = [];
  let written = 0;
  const dr = chDateRange('date', startDate, endDate);

  const sql = `
    SELECT
      date,
      platform,
      channel,
      campaign_name,
      message_type,
      SUM(sent)           AS sent,
      SUM(delivered)      AS delivered,
      SUM(opens)          AS opens,
      SUM(unique_opens)   AS unique_opens,
      SUM(clicks)         AS clicks,
      SUM(unique_clicks)  AS unique_clicks,
      SUM(unsubscribes)   AS unsubscribes,
      SUM(conversions)    AS conversions,
      SUM(revenue)        AS revenue
    FROM email_sms_table
    WHERE ${dr}
    GROUP BY date, platform, channel, campaign_name, message_type
    ORDER BY date DESC, revenue DESC
  `;

  const rows = await twSqlSafe(brand, sql);
  if (!rows.length) {
    console.log(`[twFullSync] syncTWEmailSms ${brand}: no rows`);
    return { rows: 0, errors };
  }

  for (const r of rows) {
    const date = toDateStr(r.date);
    const delivered = parseInt(r.delivered || r.sent || 0);
    const uniqueOpens  = parseInt(r.unique_opens  || 0);
    const uniqueClicks = parseInt(r.unique_clicks || 0);
    try {
      await pgRun(`
        INSERT INTO tw_email_sms_daily
          (brand, date, platform, channel, campaign_name, message_type,
           sent, delivered, opens, unique_opens, clicks, unique_clicks,
           unsubscribes, conversions, revenue, open_rate, click_rate)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (brand, date, platform, campaign_name, message_type) DO UPDATE SET
          sent          = EXCLUDED.sent,
          delivered     = EXCLUDED.delivered,
          opens         = EXCLUDED.opens,
          unique_opens  = EXCLUDED.unique_opens,
          clicks        = EXCLUDED.clicks,
          unique_clicks = EXCLUDED.unique_clicks,
          conversions   = EXCLUDED.conversions,
          revenue       = EXCLUDED.revenue,
          open_rate     = EXCLUDED.open_rate,
          click_rate    = EXCLUDED.click_rate,
          updated_at    = NOW()
      `, [
        brand, date,
        String(r.platform      || ''),
        String(r.channel       || 'email'),
        String(r.campaign_name || ''),
        String(r.message_type  || 'campaign'),
        parseInt(r.sent          || 0),
        delivered,
        parseInt(r.opens         || 0),
        uniqueOpens,
        parseInt(r.clicks        || 0),
        uniqueClicks,
        parseInt(r.unsubscribes  || 0),
        parseInt(r.conversions   || 0),
        parseFloat(r.revenue     || 0),
        delivered > 0 ? parseFloat((uniqueOpens  / delivered).toFixed(4)) : null,
        delivered > 0 ? parseFloat((uniqueClicks / delivered).toFixed(4)) : null,
      ]);
      written++;
    } catch (e) {
      errors.push(`email_sms ${brand}/${date}/${r.campaign_name}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWEmailSms ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

// ─────────────────────────────────────────────────────────────────
//  10. BENCHMARKS (monthly)
// ─────────────────────────────────────────────────────────────────
async function syncTWBenchmarks(brand) {
  const errors = [];
  let written = 0;
  const today = new Date().toISOString().slice(0, 10);
  // Get the start of the current month
  const monthStart = today.slice(0, 7) + '-01';

  const sql = `
    SELECT
      date,
      vertical,
      revenue_tier,
      metric_name,
      metric_value,
      percentile_25,
      percentile_50,
      percentile_75,
      percentile_90,
      sample_size,
      benchmark_type
    FROM benchmarks_table
    WHERE date >= toDate('${monthStart}')
    ORDER BY date DESC, vertical, metric_name
  `;

  const rows = await twSqlSafe(brand, sql);
  if (!rows.length) {
    console.log(`[twFullSync] syncTWBenchmarks ${brand}: no rows`);
    return { rows: 0, errors };
  }

  for (const r of rows) {
    const date = toDateStr(r.date);
    try {
      await pgRun(`
        INSERT INTO tw_benchmarks
          (brand, date, vertical, revenue_tier, metric_name, metric_value,
           percentile_25, percentile_50, percentile_75, percentile_90,
           sample_size, benchmark_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (brand, date, vertical, metric_name) DO UPDATE SET
          metric_value   = EXCLUDED.metric_value,
          percentile_25  = EXCLUDED.percentile_25,
          percentile_50  = EXCLUDED.percentile_50,
          percentile_75  = EXCLUDED.percentile_75,
          percentile_90  = EXCLUDED.percentile_90,
          updated_at     = NOW()
      `, [
        brand, date,
        String(r.vertical      || ''),
        String(r.revenue_tier  || ''),
        String(r.metric_name   || ''),
        parseFloat(r.metric_value  || 0),
        r.percentile_25 ? parseFloat(r.percentile_25) : null,
        r.percentile_50 ? parseFloat(r.percentile_50) : null,
        r.percentile_75 ? parseFloat(r.percentile_75) : null,
        r.percentile_90 ? parseFloat(r.percentile_90) : null,
        r.sample_size   ? parseInt(r.sample_size)     : null,
        String(r.benchmark_type || 'performance'),
      ]);
      written++;
    } catch (e) {
      errors.push(`benchmarks ${brand}/${date}/${r.metric_name}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWBenchmarks ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

// ─────────────────────────────────────────────────────────────────
//  11. ORDER REVENUE  — canonical metric via blended_stats_tvf
//
//  Uses TW's blended_stats_tvf (the same source as the TW UI):
//
//  For NOBL:
//    revenue = blended_stats_tvf(include_amazon=TRUE).order_revenue
//              = Shopify + Amazon, after discounts, before refunds
//    spend   = blended_stats_tvf(include_amazon=TRUE).spend
//              = Ad Spend (Shopify-connected platforms only)
//
//  For FLO:
//    revenue = blended_stats_tvf(include_amazon=TRUE).order_revenue
//              = Gross Sales + Shipping + Taxes − Discounts
//              = FLO US only. FLO EU is a separate store and is excluded.
//
//  shopify_revenue = blended_stats_tvf(include_amazon=FALSE).order_revenue
//  amazon_revenue  = total − shopify
//  total_sales     = order_revenue − refund_amount  (net)
//
//  This is an UPSERT — inserts row if missing, updates if present.
//  Run this BEFORE tw_refresh so revenue is visible immediately.
// ─────────────────────────────────────────────────────────────────
async function syncTWOrderRevenue(brand, startDate, endDate) {
  const errors = [];
  let written = 0;
  const refundsDr = chDateRange('refund_date', startDate, endDate);

  // ── Query 1: Total order revenue + spend (Shopify + Amazon) ─────
  const allRevSql = `
    SELECT
      bst.event_date                              AS date,
      COALESCE(SUM(bst.order_revenue), 0)         AS order_revenue,
      COALESCE(SUM(bst.spend), 0)                 AS total_spend
    FROM blended_stats_tvf(include_amazon=TRUE) AS bst
    WHERE bst.event_date >= '${startDate}'
      AND bst.event_date <= '${endDate}'
    GROUP BY bst.event_date
    ORDER BY bst.event_date
  `;

  // ── Query 2: Shopify-only order revenue (derive Amazon split) ───
  const shopifyRevSql = `
    SELECT
      bst.event_date                              AS date,
      COALESCE(SUM(bst.order_revenue), 0)         AS shopify_revenue
    FROM blended_stats_tvf(include_amazon=FALSE) AS bst
    WHERE bst.event_date >= '${startDate}'
      AND bst.event_date <= '${endDate}'
    GROUP BY bst.event_date
    ORDER BY bst.event_date
  `;

  // ── Query 3: Refunds (for net total_sales) ───────────────────────
  const refundsSql = `
    SELECT
      refund_date                                 AS date,
      COUNT(DISTINCT refund_id)                   AS refund_count,
      SUM(refund_amount)                          AS refund_amount
    FROM refunds_table
    WHERE ${refundsDr}
    GROUP BY refund_date
    ORDER BY refund_date
  `;

  const [allRows, shopifyRows, refundRows] = await Promise.all([
    twSqlSafe(brand, allRevSql),
    twSqlSafe(brand, shopifyRevSql),
    twSqlSafe(brand, refundsSql),
  ]);

  if (!allRows.length) {
    console.log(`[twFullSync] syncTWOrderRevenue ${brand}: no rows for ${startDate}→${endDate}`);
    return { rows: 0, errors };
  }

  // Build lookup maps
  const shopifyMap = {};
  for (const r of shopifyRows) {
    const d = toDateStr(r.date || r.event_date);
    shopifyMap[d] = parseFloat(r.shopify_revenue || 0);
  }

  const refundMap = {};
  for (const r of refundRows) {
    const d = toDateStr(r.date);
    refundMap[d] = {
      count:  parseInt(r.refund_count   || 0),
      amount: parseFloat(r.refund_amount || 0),
    };
  }

  for (const r of allRows) {
    const date         = toDateStr(r.date || r.event_date);
    const orderRevenue = parseFloat(r.order_revenue || 0);
    const totalSpend   = parseFloat(r.total_spend   || 0);
    const shopifyRev   = shopifyMap[date] !== undefined ? shopifyMap[date] : orderRevenue;
    const amazonRev    = Math.max(0, orderRevenue - shopifyRev);
    const refunds      = refundMap[date] || { count: 0, amount: 0 };
    const totalSales   = Math.max(0, orderRevenue - refunds.amount);

    try {
      // UPSERT — works whether or not tw_refresh has run yet
      await pgRun(`
        INSERT INTO tw_summary_daily
          (brand, date, order_revenue, shopify_revenue, amazon_revenue,
           total_sales, refund_amount, refund_count, total_spend,
           total_revenue, total_orders)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$3,0)
        ON CONFLICT (brand, date) DO UPDATE SET
          order_revenue   = EXCLUDED.order_revenue,
          shopify_revenue = EXCLUDED.shopify_revenue,
          amazon_revenue  = EXCLUDED.amazon_revenue,
          total_sales     = EXCLUDED.total_sales,
          total_revenue   = EXCLUDED.total_revenue,
          refund_amount   = EXCLUDED.refund_amount,
          refund_count    = EXCLUDED.refund_count,
          total_spend     = CASE WHEN EXCLUDED.total_spend > 0
                                 THEN EXCLUDED.total_spend
                                 ELSE tw_summary_daily.total_spend END,
          mer             = CASE
            WHEN (CASE WHEN EXCLUDED.total_spend > 0 THEN EXCLUDED.total_spend ELSE tw_summary_daily.total_spend END) > 0
            THEN EXCLUDED.total_revenue / (CASE WHEN EXCLUDED.total_spend > 0 THEN EXCLUDED.total_spend ELSE tw_summary_daily.total_spend END)
            ELSE NULL
          END,
          updated_at      = NOW()
      `, [
        brand, date,
        parseFloat(orderRevenue.toFixed(4)),
        parseFloat(shopifyRev.toFixed(4)),
        parseFloat(amazonRev.toFixed(4)),
        parseFloat(totalSales.toFixed(4)),
        parseFloat(refunds.amount.toFixed(4)),
        refunds.count,
        parseFloat(totalSpend.toFixed(4)),
      ]);
      written++;
    } catch (e) {
      errors.push(`order_revenue ${brand}/${date}: ${e.message}`);
    }
  }

  console.log(`[twFullSync] syncTWOrderRevenue ${brand}: ${written} rows upserted`);
  return { rows: written, errors };
}

module.exports = {
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
};
