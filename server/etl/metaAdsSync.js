/**
 * Sync Meta (Facebook) ad insights into meta_ads_daily.
 * Used as primary spend source; tw_ads_daily is fallback when Meta sync is missing or fails.
 */
const { pgQuery, pgRun } = require('../db/postgres');
const { getMetaAccount } = require('../config/metaConfig');

const PURCHASE_ACTION_TYPES = [
  'omni_purchase',
  'purchase',
  'web_in_store_purchase',
  'onsite_web_purchase',
  'offsite_conversion.fb_pixel_purchase',
];

function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function firstActionValue(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const actionType of types) {
    const match = actions.find((item) => item.action_type === actionType);
    if (match) return toNum(match.value);
  }
  return 0;
}

function parseInsightDate(row) {
  const d = row.date_start || row.date_stop;
  if (!d) return null;
  return String(d).slice(0, 10);
}

function normalizeMetaAdRow(row, brand) {
  const spend = toNum(row.spend);
  const purchases = Math.round(firstActionValue(row.actions, PURCHASE_ACTION_TYPES));
  const revenue = firstActionValue(row.action_values, PURCHASE_ACTION_TYPES);
  const date = parseInsightDate(row);
  if (!date) return null;

  const adId = String(row.ad_id || '').trim();
  if (!adId) return null;

  return {
    brand,
    date,
    platform: 'META',
    campaign_id: String(row.campaign_id || ''),
    campaign_name: row.campaign_name || null,
    adset_id: String(row.adset_id || ''),
    adset_name: row.adset_name || null,
    ad_id: adId,
    ad_name: row.ad_name || null,
    impressions: Math.round(toNum(row.impressions)),
    clicks: Math.round(toNum(row.clicks)),
    spend,
    purchases,
    revenue,
    link_clicks: Math.round(toNum(row.inline_link_clicks)),
    add_to_cart: 0,
    initiate_checkout: 0,
  };
}

async function fetchMetaInsightsPage(url, timeoutMs = 120_000, attempt = 0) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || `Meta API HTTP ${res.status}`;
    const rateLimited = /limit reached|rate limit|too many calls/i.test(msg);
    if (rateLimited && attempt < 6) {
      const waitMs = 20_000 * (attempt + 1);
      console.warn(`[metaAdsSync] rate limited — retry in ${waitMs / 1000}s (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, waitMs));
      return fetchMetaInsightsPage(url, timeoutMs, attempt + 1);
    }
    throw new Error(msg);
  }
  return json;
}

async function fetchMetaInsightsRange(actId, token, startDate, endDate, apiVersion = 'v20.0') {
  const fields = [
    'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
    'spend', 'impressions', 'clicks', 'inline_link_clicks', 'actions', 'action_values',
    'date_start', 'date_stop',
  ].join(',');

  const params = new URLSearchParams({
    access_token: token,
    level: 'ad',
    fields,
    time_range: JSON.stringify({ since: startDate, until: endDate }),
    time_increment: '1',
    limit: '500',
  });

  let nextUrl = `https://graph.facebook.com/${apiVersion}/${actId}/insights?${params}`;
  const rawRows = [];
  let pages = 0;
  const maxPages = 80;

  while (nextUrl && pages < maxPages) {
    const json = await fetchMetaInsightsPage(nextUrl);
    rawRows.push(...(Array.isArray(json.data) ? json.data : []));
    nextUrl = json?.paging?.next || null;
    pages += 1;
    if (nextUrl) await new Promise((r) => setTimeout(r, 1500));
  }

  if (nextUrl && pages >= maxPages) {
    console.warn(`[metaAdsSync] pagination cap (${maxPages} pages) for ${startDate}..${endDate}`);
  }

  return rawRows;
}

async function ensureMetaAdsDailyTable() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS meta_ads_daily (
      id BIGSERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      date DATE NOT NULL,
      platform TEXT NOT NULL DEFAULT 'META',
      campaign_id TEXT NOT NULL DEFAULT '',
      campaign_name TEXT,
      adset_id TEXT NOT NULL DEFAULT '',
      adset_name TEXT,
      ad_id TEXT NOT NULL,
      ad_name TEXT,
      impressions BIGINT DEFAULT 0,
      clicks BIGINT DEFAULT 0,
      spend NUMERIC(14,4) DEFAULT 0,
      purchases INT DEFAULT 0,
      revenue NUMERIC(14,4) DEFAULT 0,
      link_clicks BIGINT DEFAULT 0,
      add_to_cart BIGINT DEFAULT 0,
      initiate_checkout BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (brand, date, platform, ad_id)
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_meta_ads_brand_date ON meta_ads_daily (brand, date DESC)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_meta_ads_ad ON meta_ads_daily (brand, ad_id, date DESC)`);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  const s = new Date(startDate);
  const e = new Date(endDate);
  return Math.round((e - s) / 86400000);
}

function chunksOf(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function upsertMetaAdRows(normalized) {
  let written = 0;
  const errors = [];
  for (const batch of chunksOf(normalized, 400)) {
    const values = [];
    const params = [];
    let p = 1;
    for (const r of batch) {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(
        r.brand, r.date, r.platform,
        r.campaign_id, r.campaign_name,
        r.adset_id, r.adset_name,
        r.ad_id, r.ad_name,
        r.impressions, r.clicks, r.spend, r.purchases, r.revenue,
        r.link_clicks, r.add_to_cart, r.initiate_checkout,
      );
    }
    try {
      await pgRun(`
        INSERT INTO meta_ads_daily (
          brand, date, platform, campaign_id, campaign_name, adset_id, adset_name,
          ad_id, ad_name, impressions, clicks, spend, purchases, revenue,
          link_clicks, add_to_cart, initiate_checkout
        ) VALUES ${values.join(', ')}
        ON CONFLICT (brand, date, platform, ad_id) DO UPDATE SET
          campaign_name = EXCLUDED.campaign_name,
          adset_name = EXCLUDED.adset_name,
          ad_name = EXCLUDED.ad_name,
          impressions = EXCLUDED.impressions,
          clicks = EXCLUDED.clicks,
          spend = EXCLUDED.spend,
          purchases = EXCLUDED.purchases,
          revenue = EXCLUDED.revenue,
          link_clicks = EXCLUDED.link_clicks,
          add_to_cart = EXCLUDED.add_to_cart,
          initiate_checkout = EXCLUDED.initiate_checkout,
          updated_at = NOW()
      `, params);
      written += batch.length;
    } catch (e) {
      errors.push(`meta_ads upsert: ${e.message}`);
    }
  }
  return { written, errors };
}

async function fetchAndUpsertMetaRange(brand, actId, token, startDate, endDate, apiVersion = 'v20.0') {
  let rawRows = [];
  try {
    rawRows = await fetchMetaInsightsRange(actId, token, startDate, endDate, apiVersion);
  } catch (e) {
    if (startDate !== endDate && /reduce the amount|timeout|timed out|try again/i.test(e.message)) {
      const span = daysBetween(startDate, endDate);
      const midOffset = Math.floor(span / 2);
      const midDate = addDays(startDate, midOffset);
      console.warn(`[metaAdsSync] split ${startDate}..${endDate} at ${midDate}: ${e.message}`);
      const left = await fetchAndUpsertMetaRange(brand, actId, token, startDate, midDate, apiVersion);
      const right = await fetchAndUpsertMetaRange(brand, actId, token, addDays(midDate, 1), endDate, apiVersion);
      return {
        rows: left.rows + right.rows,
        errors: [...left.errors, ...right.errors],
      };
    }
    return { rows: 0, errors: [`Meta insights ${startDate}..${endDate}: ${e.message}`] };
  }

  const normalized = [];
  for (const row of rawRows) {
    const n = normalizeMetaAdRow(row, brand);
    if (!n) continue;
    if (n.spend <= 0 && n.purchases <= 0 && n.impressions <= 0) continue;
    normalized.push(n);
  }

  if (!normalized.length) {
    return { rows: 0, errors: [] };
  }

  const { written, errors } = await upsertMetaAdRows(normalized);
  console.log(`[metaAdsSync] ${brand} ${startDate}..${endDate}: ${written} rows upserted`);
  return { rows: written, errors };
}

/**
 * Pull ad-level insights from Meta and upsert into meta_ads_daily.
 * Works for any brand that has Meta credentials configured (NOBL, FLO, …).
 * @param {'NOBL'|'FLO'} brand
 */
async function syncMetaAds(brand, startDate, endDate) {
  const account = getMetaAccount(brand);
  if (!account) {
    const B = String(brand || '').toUpperCase();
    return {
      rows: 0,
      errors: [`No Meta account configured for ${B} — set ${B}_META_AD_ACCOUNT_ID and ${B}_META_ACCESS_TOKEN (using Triple Whale only)`],
      skipped: true,
    };
  }

  await ensureMetaAdsDailyTable();

  const result = await fetchAndUpsertMetaRange(
    account.brand, account.accountId, account.token, startDate, endDate, account.apiVersion,
  );
  return { rows: result.rows, errors: result.errors };
}

/** SQL fragment: daily ad spend — Meta first, Triple Whale fallback. */
function adsSpendDailySubquery(dateParams = '$1::date AND $2::date', brand = "'NOBL'") {
  return `
    SELECT
      COALESCE(m.date, t.date) AS date,
      COALESCE(m.campaign_id, t.campaign_id, '') AS campaign_id,
      COALESCE(m.campaign_name, t.campaign_name) AS campaign_name,
      COALESCE(m.adset_id, t.adset_id, '') AS adset_id,
      COALESCE(m.adset_name, t.adset_name) AS adset_name,
      COALESCE(m.ad_id, t.ad_id, '') AS ad_id,
      COALESCE(m.ad_name, t.ad_name) AS ad_name,
      COALESCE(m.spend, t.spend, 0)::numeric(14,2) AS spend,
      COALESCE(m.revenue, t.revenue, 0)::numeric(14,2) AS revenue,
      COALESCE(m.purchases, t.purchases, 0)::numeric(14,2) AS purchases,
      COALESCE(m.impressions, t.impressions, 0)::bigint AS impressions,
      COALESCE(m.clicks, t.clicks, 0)::bigint AS clicks,
      COALESCE(m.link_clicks, t.link_clicks, 0)::bigint AS link_clicks,
      COALESCE(m.add_to_cart, t.add_to_cart, 0)::bigint AS add_to_cart,
      COALESCE(m.initiate_checkout, t.initiate_checkout, 0)::bigint AS initiate_checkout
    FROM (
      SELECT date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
        spend, revenue, purchases, impressions, clicks, link_clicks, add_to_cart, initiate_checkout
      FROM meta_ads_daily
      WHERE brand = ${brand} AND platform = 'META' AND date BETWEEN ${dateParams}
        AND COALESCE(ad_id, '') <> ''
    ) m
    FULL OUTER JOIN (
      SELECT date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
        spend, revenue, purchases, impressions, clicks, link_clicks, add_to_cart, initiate_checkout
      FROM tw_ads_daily
      WHERE brand = ${brand} AND platform = 'META' AND date BETWEEN ${dateParams}
        AND COALESCE(ad_id, '') <> ''
    ) t ON m.date = t.date
      AND COALESCE(m.ad_id, '') = COALESCE(t.ad_id, '')
      AND COALESCE(m.campaign_id, '') = COALESCE(t.campaign_id, '')
      AND COALESCE(m.adset_id, '') = COALESCE(t.adset_id, '')`;
}

/**
 * All Meta ad rows for dashboard queries — Meta-first merge for EVERY brand.
 * Any brand that has rows in meta_ads_daily uses them (more accurate, less lag);
 * brands/rows without a Meta match fall back to Triple Whale (tw_ads_daily).
 * Consumers still filter by `brand` so NOBL-only queries are unaffected.
 */
function metaAdsDailySourceSql(dateBetween = '$1::date AND $2::date') {
  return `
    (
      SELECT
        COALESCE(m.brand, t.brand) AS brand,
        COALESCE(m.date, t.date) AS date,
        'META'::text AS platform,
        COALESCE(m.campaign_id, t.campaign_id, '') AS campaign_id,
        COALESCE(m.campaign_name, t.campaign_name) AS campaign_name,
        COALESCE(m.adset_id, t.adset_id, '') AS adset_id,
        COALESCE(m.adset_name, t.adset_name) AS adset_name,
        COALESCE(m.ad_id, t.ad_id, '') AS ad_id,
        COALESCE(m.ad_name, t.ad_name) AS ad_name,
        COALESCE(m.spend, t.spend, 0)::numeric(14,4) AS spend,
        COALESCE(m.revenue, t.revenue, 0)::numeric(14,4) AS revenue,
        COALESCE(m.purchases, t.purchases, 0)::int AS purchases,
        COALESCE(m.impressions, t.impressions, 0)::bigint AS impressions,
        COALESCE(m.clicks, t.clicks, 0)::bigint AS clicks,
        COALESCE(m.link_clicks, t.link_clicks, 0)::bigint AS link_clicks,
        COALESCE(m.add_to_cart, t.add_to_cart, 0)::bigint AS add_to_cart,
        COALESCE(m.initiate_checkout, t.initiate_checkout, 0)::bigint AS initiate_checkout
      FROM (
        SELECT brand, date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
          spend, revenue, purchases, impressions, clicks, link_clicks, add_to_cart, initiate_checkout
        FROM meta_ads_daily
        WHERE platform = 'META' AND date BETWEEN ${dateBetween}
          AND COALESCE(ad_id, '') <> ''
      ) m
      FULL OUTER JOIN (
        SELECT brand, date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
          spend, revenue, purchases, impressions, clicks, link_clicks, add_to_cart, initiate_checkout
        FROM tw_ads_daily
        WHERE platform = 'META' AND date BETWEEN ${dateBetween}
          AND COALESCE(ad_id, '') <> ''
      ) t ON m.brand = t.brand
        AND m.date = t.date
        AND COALESCE(m.ad_id, '') = COALESCE(t.ad_id, '')
        AND COALESCE(m.campaign_id, '') = COALESCE(t.campaign_id, '')
        AND COALESCE(m.adset_id, '') = COALESCE(t.adset_id, '')
    )`;
}

module.exports = {
  syncMetaAds,
  ensureMetaAdsDailyTable,
  adsSpendDailySubquery,
  metaAdsDailySourceSql,
  normalizeMetaAdRow,
};
