const express = require('express');
const router  = express.Router();
const { pgQuery } = require('../db/postgres');
const { refreshNoblAirMetaAdDaily } = require('../etl/noblAirMetaAdDaily');
const { metaAdsDailySourceSql } = require('../etl/metaAdsSync');
const { getNoblAirDataVersion } = require('../utils/noblAirDataVersion');
const { withResponseCache } = require('../utils/responseCache');

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

function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
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
    plan: {
      '2026-03': 19117775,
      '2026-04': 15311615,
      '2026-05': 14589630,
      '2026-06': 42000000,
      '2026-07': 60000000,
      '2026-08': 58000000,
      '2026-09': 45200000,
      '2026-10': 32300000,
      '2026-11': 142400000,
      '2026-12': 113900000,
    },
    merTargets: {
      '2026-05': 3.30,
      '2026-06': 3.25,
      '2026-07': 3.20,
      '2026-08': 3.30,
      '2026-09': 3.20,
      '2026-10': 3.10,
      '2026-11': 2.85,
      '2026-12': 3.00,
    },
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
  const forecastMonths = [
    ['2026-03', 'Mar', null],
    ['2026-04', 'Apr', null],
    ['2026-05', 'May', null],
    ['2026-06', 'Jun', 42000000],
    ['2026-07', 'Jul', 60000000],
    ['2026-08', 'Aug', 58000000],
    ['2026-09', 'Sep', 45200000],
    ['2026-10', 'Oct', 32300000],
    ['2026-11', 'Nov', 142400000],
    ['2026-12', 'Dec', 113900000],
  ];
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
    res.json({
      as_of: results.map(r => r.as_of).sort()[0] || asOf,
      brands: results,
      combined,
      methodology: {
        purpose: 'Daily actuals plus calendar-aware forward projection for current month and full year.',
        factors: ['day-of-week weights', 'sale calendar and strength tier', 'monthly seasonality', 'MER targets', 'manufactured drop windows', 'regional pacing'],
        redlines: ['no flat rolling average', 'drop windows remain discrete', 'BFCM is model anchored', 'full-year below P25 triggers review'],
      },
    });
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
  try {
    const [noblRes, floRes, subsRes] = await Promise.all([
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                total_revenue, total_spend, mer,
                total_orders, new_customer_orders, returning_customer_orders,
                COALESCE(order_revenue, total_revenue) AS order_revenue,
                shopify_revenue, amazon_revenue, total_sales,
                COALESCE(refund_amount, 0) AS refund_amount
         FROM nobl_brand_tw_summary_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
         ORDER BY date`,
        [start, end]
      ),
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                total_revenue, total_spend, mer,
                total_orders, new_customer_orders, returning_customer_orders,
                COALESCE(order_revenue, total_revenue) AS order_revenue,
                shopify_revenue, amazon_revenue, total_sales,
                COALESCE(refund_amount, 0) AS refund_amount
         FROM flo_brand_tw_summary_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
         ORDER BY date`,
        [start, end]
      ),
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                sub_revenue_actual
         FROM nobl_air_sub_revenue_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
         ORDER BY date`,
        [start, end]
      ),
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
        nobl_orders:         parseInt(n.total_orders || 0),
        nobl_nc_orders:      parseInt(n.new_customer_orders || 0),
        flo_revenue:         fRev,
        flo_order_revenue:   parseFloat(f.order_revenue   || 0),
        flo_shopify_revenue: parseFloat(f.shopify_revenue || 0),
        flo_amazon_revenue:  parseFloat(f.amazon_revenue  || 0),
        flo_total_sales:     parseFloat(f.total_sales     || 0),
        flo_refund_amount:   parseFloat(f.refund_amount   || 0),
        flo_spend:           fSpend,
        flo_mer:             fSpend > 0 ? parseFloat((fRev / fSpend).toFixed(4)) : null,
        flo_orders:          parseInt(f.total_orders || 0),
        flo_nc_orders:       parseInt(f.new_customer_orders || 0),
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

    res.json({ rows, totals });
  } catch (e) {
    console.error('[Analytics /overview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/topline
router.get('/nobl/topline', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
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
      pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                shopify_sub_gross, shopify_sub_disc, shopify_sub_refunds,
                rebill_revenue, new_sub_revenue, sub_revenue_actual
         FROM nobl_air_sub_revenue_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date`,
        [start, end]
      ),
    ]);
    res.json({
      summary: fmtRows(summaryRes.rows),
      channels: fmtRows(channelsRes.rows),
      geo: fmtRows(geoRes.rows),
      subs: fmtRows(subsRes.rows),
    });
  } catch (e) {
    console.error('[Analytics /nobl/topline]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /flo/topline
router.get('/flo/topline', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
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
    res.json({
      summary: fmtRows(summaryRes.rows),
      channels: fmtRows(channelsRes.rows),
      geo: fmtRows(geoRes.rows),
      products: fmtRows(productsRes.rows),
    });
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
  try {
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
      rows = fmtRows(r.rows);
    } else if (brand === 'FLO') {
      const r = await pgQuery(
        `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                brand, channel, spend_1d, revenue_1d, purchases_1d, roas_1d,
                spend_7d, new_cust_orders, cac
         FROM flo_brand_tw_channel_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, channel`,
        [start, end]
      );
      rows = fmtRows(r.rows);
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
      rows = [...fmtRows(noblRes.rows), ...fmtRows(floRes.rows)];
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
    res.json({ rows });
  } catch (e) {
    console.error('[Analytics /channels]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/subscriptions
router.get('/nobl/subscriptions', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
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
    res.json({
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
    });
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
    if (brands.length === 1) {
      const r = brands[0] === 'FLO' ? await fetchFloSubs(start, end) : await fetchNoblSubs(start, end);
      return res.json(r);
    }
    const fetchers = brands.map(b => b === 'FLO' ? fetchFloSubs(start, end) : fetchNoblSubs(start, end));
    const results = await Promise.all(fetchers);
    return res.json(mergeBrandSubs(results));
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
    res.json({
      rows,
      chart_rows: fmtRows(chartRes.rows),
      totals,
      pagination: buildPagination(page, pageSize, totalRows),
      search: searchPattern ? String(req.query.search || req.query.q || '').trim() : '',
      level,
      brand,
      start,
      end,
    });
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
    const r = await pgQuery(
      `SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
              brand, product_line, spend, new_cust_orders, revenue,
              meta_spend, google_spend, tiktok_spend, snap_spend, pinterest_spend, bing_spend, applovin_spend
       FROM flo_brand_tw_product_daily
       WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date, product_line`,
      [start, end]
    );
    res.json({ rows: fmtRows(r.rows) });
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
