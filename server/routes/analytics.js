const express = require('express');
const router  = express.Router();
const { pgQuery } = require('../db/postgres');

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
    ttp_cohorts AS (
      SELECT
        DATE(s.created_at) AS date,
        SUM(CASE WHEN s.is_mature THEN 1 ELSE 0 END)::int AS mature_count,
        SUM(CASE WHEN s.is_mature AND s.is_converted THEN 1 ELSE 0 END)::int AS converted_count,
        SUM(CASE WHEN s.is_same_day_cancel THEN 1 ELSE 0 END)::int AS same_day_cancels
      FROM nobl_air_subscribers s
      JOIN o ON o.order_name = s.order_name
      WHERE o.has_air AND o.has_luggage
        AND DATE(s.created_at) BETWEEN $1::date AND $2::date
      GROUP BY DATE(s.created_at)
    )
    SELECT
      TO_CHAR(d.date, 'YYYY-MM-DD') AS date,
      d.total_orders, d.air_orders,
      CASE WHEN d.total_orders > 0 THEN ROUND(d.air_orders::numeric / d.total_orders, 4) ELSE NULL END AS attach_rate,
      CASE
        WHEN COALESCE(t.mature_count, 0) > 0 THEN ROUND(t.converted_count::numeric / t.mature_count, 4)
        WHEN d.air_orders > 0 THEN ROUND(d.paid_air_orders::numeric / d.air_orders, 4)
        ELSE NULL
      END AS ttp_rate,
      CASE
        WHEN d.total_orders > 0 AND (
          CASE
            WHEN COALESCE(t.mature_count, 0) > 0 THEN t.converted_count::numeric / NULLIF(t.mature_count, 0)
            WHEN d.air_orders > 0 THEN d.paid_air_orders::numeric / NULLIF(d.air_orders, 0)
            ELSE NULL
          END
        ) IS NOT NULL THEN ROUND((d.air_orders::numeric / d.total_orders) * (
          CASE
            WHEN COALESCE(t.mature_count, 0) > 0 THEN t.converted_count::numeric / NULLIF(t.mature_count, 0)
            WHEN d.air_orders > 0 THEN d.paid_air_orders::numeric / NULLIF(d.air_orders, 0)
            ELSE NULL
          END
        ), 4)
        ELSE NULL
      END AS activation_rate,
      d.zero_air_orders, d.paid_air_orders, d.rebill_orders, COALESCE(t.same_day_cancels, 0) AS same_day_cancels,
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
    LEFT JOIN new_tiers_pivot np ON np.date = d.date
    LEFT JOIN rebill_tiers_pivot rp ON rp.date = d.date
    ORDER BY d.date ASC
  `, [start, end, countryCodes]);
  return fmtRows(r.rows);
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
        `SELECT
           COUNT(*) AS total,
            COUNT(*) FILTER (WHERE LOWER(status) = 'active') AS active,
            COUNT(*) FILTER (WHERE LOWER(status) = 'cancelled') AS cancelled,
            COUNT(*) FILTER (WHERE LOWER(status) = 'paused') AS paused,
            COUNT(*) FILTER (WHERE LOWER(status) = 'trialing') AS trialing,
           COUNT(*) FILTER (WHERE is_converted) AS converted,
           AVG(contract_amount) FILTER (WHERE contract_amount IS NOT NULL AND contract_amount > 0) AS avg_order_amount
         FROM nobl_air_subscribers`,
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
router.get('/subscriptions', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const brand = String(req.query.brand || 'NOBL').toUpperCase();

  try {
    if (brand === 'FLO') {
      const [dailyRes, summaryRes] = await Promise.all([
        pgQuery(
          `WITH parsed AS (
             SELECT *, CASE
               WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'object' THEN raw_json->'lastSuccessfulOrder'
               WHEN jsonb_typeof(raw_json->'lastSuccessfulOrder') = 'string' THEN (raw_json->>'lastSuccessfulOrder')::jsonb
               ELSE NULL
             END AS success_json
             FROM flo_appstle_subscribers
           ), dates AS (
             SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS date
           ), new_subs AS (
             SELECT DATE(created_at) AS date,
                    COALESCE(SUM(order_amount), 0) AS new_sub_revenue
             FROM parsed
             WHERE DATE(created_at) BETWEEN $1::date AND $2::date
             GROUP BY DATE(created_at)
           ), rebills AS (
             SELECT (success_json->>'orderDate')::timestamptz::date AS date,
                    COALESCE(SUM((success_json->>'orderAmount')::numeric), 0) AS rebill_revenue
             FROM parsed
             WHERE success_json ? 'orderDate'
               AND (success_json->>'orderDate')::timestamptz::date BETWEEN $1::date AND $2::date
             GROUP BY (success_json->>'orderDate')::timestamptz::date
           )
           SELECT TO_CHAR(d.date, 'YYYY-MM-DD') AS date,
                  0::numeric AS shopify_sub_gross,
                  0::numeric AS shopify_sub_disc,
                  0::numeric AS shopify_sub_refunds,
                  COALESCE(n.new_sub_revenue, 0) AS new_sub_revenue,
                  COALESCE(r.rebill_revenue, 0) AS rebill_revenue,
                  COALESCE(n.new_sub_revenue, 0) + COALESCE(r.rebill_revenue, 0) AS sub_revenue_actual
           FROM dates d
           LEFT JOIN new_subs n ON n.date = d.date
           LEFT JOIN rebills r ON r.date = d.date
           ORDER BY d.date`,
          [start, end]
        ),
        pgQuery(
          `SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE LOWER(status) = 'active') AS active,
             COUNT(*) FILTER (WHERE LOWER(status) = 'cancelled') AS cancelled,
             COUNT(*) FILTER (WHERE LOWER(status) = 'paused') AS paused,
             COUNT(*) FILTER (WHERE LOWER(status) = 'trialing') AS trialing,
             COUNT(*) FILTER (WHERE is_converted) AS converted,
             AVG(contract_amount) FILTER (WHERE contract_amount IS NOT NULL AND contract_amount > 0) AS avg_order_amount
           FROM flo_appstle_subscribers`,
          []
        ),
      ]);
      const s = summaryRes.rows[0] || {};
      return res.json({
        brand,
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
    }

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
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE LOWER(status) = 'active') AS active,
           COUNT(*) FILTER (WHERE LOWER(status) = 'cancelled') AS cancelled,
           COUNT(*) FILTER (WHERE LOWER(status) = 'paused') AS paused,
           COUNT(*) FILTER (WHERE LOWER(status) = 'trialing') AS trialing,
           COUNT(*) FILTER (WHERE is_converted) AS converted,
           AVG(contract_amount) FILTER (WHERE contract_amount IS NOT NULL AND contract_amount > 0) AS avg_order_amount
         FROM nobl_air_subscribers`,
        []
      ),
    ]);
    const s = summaryRes.rows[0] || {};
    res.json({
      brand: 'NOBL',
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
    console.error('[Analytics /subscriptions]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/air-performance
router.get('/nobl/air-performance', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const rollingDays = Math.max(7, Math.min(parseInt(req.query.rollingDays || '14', 10), 60));
  const forecastDays = Math.max(7, Math.min(parseInt(req.query.forecastDays || '14', 10), 60));
  const region = String(req.query.region || 'ALL').toUpperCase();
  const regionCountries = {
    US: ['US'],
    CA: ['CA'],
    AUS: ['AU'],
  };

  try {
    const effectiveEnd = await capNoblAirEndDate(end);
    const daily = regionCountries[region]
      ? await loadNoblAirRegionalDaily(start, effectiveEnd, regionCountries[region])
      : fmtRows((await pgQuery(
          `SELECT
             TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
             total_orders, air_orders, attach_rate, ttp_rate, activation_rate,
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
          [start, effectiveEnd]
        )).rows);
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
      combined_net_revenue: (acc.combined_net_revenue || 0) + (r.combined_net_revenue || 0),
    }), {});

    totals.attach_rate = totals.total_orders > 0
      ? parseFloat((totals.air_orders / totals.total_orders).toFixed(4))
      : null;
    totals.ttp_rate = totals.air_orders > 0
      ? parseFloat((totals.paid_air_orders / totals.air_orders).toFixed(4))
      : null;
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

    res.json({
      rows: rowsDesc,
      totals,
      forecast,
      rolling_days: rollingDays,
      forecast_days: forecastDays,
      region,
      data_end: effectiveEnd,
      requested_end: end,
    });
  } catch (e) {
    console.error('[Analytics /nobl/air-performance]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/air-meta-adsets — live Meta ad set performance for the selected date range
router.get('/nobl/air-meta-adsets', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const rowLimit = Math.max(10, Math.min(parseInt(req.query.limit || '50', 10), 100));
  const token = process.env.META_ADS_READ_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;

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

    const allRows = rawRows
      .map(normalizeMetaAdSet)
      .filter(row => row.spend > 0 || row.purchases > 0 || row.impressions > 0)
      .sort((a, b) => b.spend - a.spend);
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

// GET /meta/ads — saved TW ad performance, grouped by campaign/adset/ad
router.get('/meta/ads', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const brand = (req.query.brand || 'NOBL').toUpperCase();
  const level = ['campaign', 'adset', 'ad'].includes(req.query.level) ? req.query.level : 'adset';

  const groupFields = {
    campaign: ['campaign_id', 'campaign_name'],
    adset: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name'],
    ad: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'],
  }[level];

  try {
    const r = await pgQuery(`
      SELECT
        ${groupFields.join(', ')},
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
        CASE WHEN SUM(impressions) > 0 THEN SUM(spend) * 1000 / SUM(impressions) ELSE NULL END AS cpm
      FROM tw_ads_daily
      WHERE brand = $1
        AND platform = 'META'
        AND date BETWEEN $2::date AND $3::date
      GROUP BY ${groupFields.join(', ')}
      HAVING SUM(spend) > 0 OR SUM(purchases) > 0
      ORDER BY spend DESC
      LIMIT 500
    `, [brand, start, end]);

    const totals = r.rows.reduce((acc, row) => ({
      spend: acc.spend + Number(row.spend || 0),
      revenue: acc.revenue + Number(row.revenue || 0),
      purchases: acc.purchases + Number(row.purchases || 0),
      impressions: acc.impressions + Number(row.impressions || 0),
      clicks: acc.clicks + Number(row.clicks || 0),
      link_clicks: acc.link_clicks + Number(row.link_clicks || 0),
    }), { spend: 0, revenue: 0, purchases: 0, impressions: 0, clicks: 0, link_clicks: 0 });

    totals.roas = totals.spend > 0 ? totals.revenue / totals.spend : null;
    totals.cac = totals.purchases > 0 ? totals.spend / totals.purchases : null;
    totals.ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : null;
    totals.cpc = totals.clicks > 0 ? totals.spend / totals.clicks : null;
    totals.cpm = totals.impressions > 0 ? totals.spend * 1000 / totals.impressions : null;

    res.json({ rows: fmtRows(r.rows), totals, level, start, end });
  } catch (e) {
    console.error('[Analytics /meta/ads]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/air-attribution — exact NOBL Air purchases from TW order-level attribution
router.get('/nobl/air-attribution', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  const level = ['campaign', 'adset', 'ad'].includes(req.query.level) ? req.query.level : 'ad';

  const groupFields = {
    campaign: ['campaign_id', 'campaign_name'],
    adset: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name'],
    ad: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'],
  }[level];
  const groupCols = groupFields.join(', ');
  const totalJoin = groupFields
    .map(field => `COALESCE(air.${field}, '') = COALESCE(total.${field}, '')`)
    .join(' AND ');

  try {
    const r = await pgQuery(`
      WITH attr AS (
        SELECT *
        FROM tw_air_order_attribution
        WHERE brand = 'NOBL'
          AND channel = 'facebook-ads'
          AND model = 'Triple Attribution'
          AND attribution_window = '1_day'
          AND date BETWEEN $1::date AND $2::date
      ), sub_match AS (
        SELECT
          a.id,
          BOOL_OR(COALESCE(s.is_mature, false)) AS is_mature,
          BOOL_OR(COALESCE(s.is_mature, false) AND COALESCE(s.is_converted, false)) AS is_converted,
          COUNT(DISTINCT s.appstle_id) FILTER (WHERE s.is_mature)::int AS ttp_mature_subscribers,
          COUNT(DISTINCT s.appstle_id) FILTER (WHERE s.is_mature AND s.is_converted)::int AS ttp_paid_subscribers
        FROM attr a
        LEFT JOIN LATERAL (
          SELECT appstle_id, is_mature, is_converted
          FROM nobl_air_subscribers
          WHERE order_name = a.order_name
          UNION
          SELECT appstle_id, is_mature, is_converted
          FROM nobl_air_subscribers
          WHERE graph_order_id = CONCAT('gid://shopify/Order/', a.order_id)
          UNION
          SELECT appstle_id, is_mature, is_converted
          FROM nobl_air_subscribers
          WHERE graph_order_id = a.order_id
        ) s ON true
        GROUP BY a.id
      ), air AS (
        SELECT
          ${groupCols},
          COUNT(DISTINCT a.order_id)::int AS air_orders,
          SUM(a.linear_weight)::numeric(14,2) AS attributed_air_orders,
          SUM(a.order_revenue * a.linear_weight)::numeric(14,2) AS attributed_air_revenue,
          SUM(a.linear_weight) FILTER (WHERE sm.is_mature)::numeric(14,2) AS ttp_mature_air_orders,
          SUM(a.linear_weight) FILTER (WHERE sm.is_converted)::numeric(14,2) AS ttp_paid_air_orders,
          SUM(sm.ttp_mature_subscribers)::int AS ttp_mature_subscribers,
          SUM(sm.ttp_paid_subscribers)::int AS ttp_paid_subscribers
        FROM attr a
        LEFT JOIN sub_match sm ON sm.id = a.id
        GROUP BY ${groupCols}
      ),
      total AS (
        SELECT
          ${groupCols},
          SUM(purchases)::numeric(14,2) AS total_attributed_orders
        FROM tw_ads_daily
        WHERE brand = 'NOBL'
          AND platform = 'META'
          AND date BETWEEN $1::date AND $2::date
        GROUP BY ${groupCols}
      )
      SELECT
        ${groupFields.map(field => `air.${field}`).join(', ')},
        COALESCE(total.total_attributed_orders, 0)::numeric(14,2) AS total_attributed_orders,
        air.air_orders,
        air.attributed_air_orders,
        air.attributed_air_revenue,
        COALESCE(air.ttp_mature_air_orders, 0)::numeric(14,2) AS ttp_mature_air_orders,
        COALESCE(air.ttp_paid_air_orders, 0)::numeric(14,2) AS ttp_paid_air_orders,
        air.ttp_mature_subscribers,
        air.ttp_paid_subscribers,
        CASE
          WHEN COALESCE(total.total_attributed_orders, 0) > 0
            THEN ROUND(air.attributed_air_orders / total.total_attributed_orders, 4)
          ELSE NULL
        END AS attach_rate,
        CASE
          WHEN COALESCE(air.ttp_mature_air_orders, 0) > 0
            THEN ROUND(air.ttp_paid_air_orders / air.ttp_mature_air_orders, 4)
          ELSE NULL
        END AS ttp_rate,
        CASE
          WHEN COALESCE(total.total_attributed_orders, 0) > 0 AND COALESCE(air.ttp_mature_air_orders, 0) > 0
            THEN ROUND((air.attributed_air_orders / total.total_attributed_orders) * (air.ttp_paid_air_orders / air.ttp_mature_air_orders), 4)
          ELSE NULL
        END AS activation_rate
      FROM air
      LEFT JOIN total ON ${totalJoin}
      ORDER BY attributed_air_orders DESC, attributed_air_revenue DESC
      LIMIT 500
    `, [start, end]);

    const totals = r.rows.reduce((acc, row) => ({
      total_attributed_orders: acc.total_attributed_orders + Number(row.total_attributed_orders || 0),
      air_orders: acc.air_orders + Number(row.air_orders || 0),
      attributed_air_orders: acc.attributed_air_orders + Number(row.attributed_air_orders || 0),
      attributed_air_revenue: acc.attributed_air_revenue + Number(row.attributed_air_revenue || 0),
      ttp_mature_air_orders: acc.ttp_mature_air_orders + Number(row.ttp_mature_air_orders || 0),
      ttp_paid_air_orders: acc.ttp_paid_air_orders + Number(row.ttp_paid_air_orders || 0),
      ttp_mature_subscribers: acc.ttp_mature_subscribers + Number(row.ttp_mature_subscribers || 0),
      ttp_paid_subscribers: acc.ttp_paid_subscribers + Number(row.ttp_paid_subscribers || 0),
    }), {
      total_attributed_orders: 0,
      air_orders: 0,
      attributed_air_orders: 0,
      attributed_air_revenue: 0,
      ttp_mature_air_orders: 0,
      ttp_paid_air_orders: 0,
      ttp_mature_subscribers: 0,
      ttp_paid_subscribers: 0,
    });
    totals.attach_rate = totals.total_attributed_orders > 0
      ? Number((totals.attributed_air_orders / totals.total_attributed_orders).toFixed(4))
      : null;
    totals.ttp_rate = totals.ttp_mature_air_orders > 0
      ? Number((totals.ttp_paid_air_orders / totals.ttp_mature_air_orders).toFixed(4))
      : null;
    totals.activation_rate = totals.attach_rate != null && totals.ttp_rate != null
      ? Number((totals.attach_rate * totals.ttp_rate).toFixed(4))
      : null;

    res.json({ rows: fmtRows(r.rows), totals, level, start, end });
  } catch (e) {
    console.error('[Analytics /nobl/air-attribution]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /nobl/air-subscribers — subscriber-level analytics from nobl_air_subscribers
router.get('/nobl/air-subscribers', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
    // Status counts (across all contracts)
    const statusRes = await pgQuery(`
      SELECT status, COUNT(*)::int AS n
      FROM nobl_air_subscribers
      GROUP BY status ORDER BY n DESC`);

    // Tier mix (the main 10 tiers)
    const tierRes = await pgQuery(`
      SELECT
        ROUND(contract_amount)::int AS tier,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int    AS active,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE status = 'paused')::int    AS paused,
        COUNT(*) FILTER (WHERE is_mature)::int           AS mature,
        COUNT(*) FILTER (WHERE is_mature AND is_converted)::int AS converted
      FROM nobl_air_subscribers
      WHERE ROUND(contract_amount) IN (49, 79, 89, 99, 109, 119, 129, 139, 149, 159)
      GROUP BY tier ORDER BY tier`);

    // TTP is a mature cohort metric. Do not restrict it to the selected MTD
    // range, because recent subscribers are still inside the 14-day trial window.
    const ttpRes = await pgQuery(`
      SELECT
        (SELECT COUNT(*)::int
         FROM nobl_air_subscribers
         WHERE DATE(created_at) BETWEEN $1::date AND $2::date)         AS total_in_range,
        COUNT(*) FILTER (WHERE is_mature)::int                         AS mature,
        COUNT(*) FILTER (WHERE is_mature AND is_converted)::int        AS converted,
        (SELECT COUNT(*)::int
         FROM nobl_air_subscribers
         WHERE DATE(created_at) BETWEEN $1::date AND $2::date
           AND is_same_day_cancel)                                     AS same_day_cancels
      FROM nobl_air_subscribers`, [start, end]);

    // New subs per day (created_at)
    const dailyRes = await pgQuery(`
      SELECT
        DATE(created_at) AS date,
        COUNT(*)::int                                                  AS new_subs,
        COUNT(*) FILTER (WHERE is_mature AND is_converted)::int        AS converted,
        COUNT(*) FILTER (WHERE is_same_day_cancel)::int                AS same_day_cancels
      FROM nobl_air_subscribers
      WHERE DATE(created_at) BETWEEN $1::date AND $2::date
      GROUP BY DATE(created_at) ORDER BY DATE(created_at)`, [start, end]);

    // Estimated MRR — sum of contract_amount for active subs (assumes monthly billing)
    const mrrRes = await pgQuery(`
      SELECT
        COALESCE(SUM(contract_amount), 0)::numeric(14,2) AS active_arr,
        COUNT(*) FILTER (WHERE status = 'active')::int     AS active_count
      FROM nobl_air_subscribers
      WHERE status = 'active'`);

    const ttp = ttpRes.rows[0] || {};
    const ttpRate = ttp.mature > 0 ? Number((ttp.converted / ttp.mature).toFixed(4)) : null;

    res.json({
      status:         statusRes.rows,
      tiers:          tierRes.rows,
      ttp_cohort: {
        total_in_range:    ttp.total_in_range || 0,
        mature:            ttp.mature || 0,
        converted:         ttp.converted || 0,
        same_day_cancels:  ttp.same_day_cancels || 0,
        ttp_rate:          ttpRate,
      },
      daily:          dailyRes.rows.map(r => ({
        date:             r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0,10),
        new_subs:         r.new_subs,
        converted:        r.converted,
        same_day_cancels: r.same_day_cancels,
      })),
      active_arr:     Number(mrrRes.rows[0]?.active_arr || 0),
      active_count:   mrrRes.rows[0]?.active_count || 0,
    });
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
