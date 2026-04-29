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

// Default date range: last 30 days
function getDefaultDates(req) {
  const end = req.query.end || new Date().toISOString().slice(0, 10);
  const start = req.query.start || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  return { start, end };
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
                shopify_sub_gross, shopify_sub_disc, shopify_sub_refunds,
                rebill_revenue, new_sub_revenue, sub_revenue_actual
         FROM nobl_air_sub_revenue_daily
         WHERE DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date ORDER BY date`,
        [start, end]
      ),
      pgQuery(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active,
           SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled,
           SUM(CASE WHEN status='trialing' THEN 1 ELSE 0 END) as trialing,
           SUM(CASE WHEN status='converted' THEN 1 ELSE 0 END) as converted,
           AVG(last_order_amount) as avg_order_amount
         FROM appstle_subscriptions`,
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
