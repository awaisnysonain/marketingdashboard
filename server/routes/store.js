const express  = require('express');
const router   = express.Router();
const { pgQuery } = require('../db/postgres');
const { calcMer }  = require('../config/brandConfig');

/*
 * ══════════════════════════════════════════════════════════════════
 *  STORE ROUTES — Comprehensive per-store data for the Stores section
 *
 *  CRITICAL RULE: NOBL TRAVEL + EU = ONE STORE, ALWAYS COMBINED.
 *  All NOBL queries use brand='NOBL' which already includes EU.
 *  EU appears as region='EU' in geo breakdown only — never as a
 *  separate brand or separate entity.
 * ══════════════════════════════════════════════════════════════════
 */

function getDefaultDates(req) {
  const end   = req.query.end   || new Date().toISOString().slice(0, 10);
  const start = req.query.start || (() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
  })();
  return { start, end };
}

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
        out[k] = isNaN(num) || (typeof v === 'string' && isNaN(Number(v))) ? v : num;
      }
    }
    return out;
  });
}

// ── GET /api/store/nobl ─────────────────────────────────────────────────────
// Returns complete NOBL Travel data: summary, channels, geo, subs, email
// EU is always included (same store — brand='NOBL' already contains EU)
router.get('/nobl', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
    const [summaryRes, channelsRes, geoRes, subsRes, subsStatsRes, emailRes] = await Promise.all([

      // Daily summary — order_revenue is canonical (Shopify+Amazon, before refunds)
      // Falls back to total_revenue (TW attributed) until order_revenue backfill runs
      pgQuery(`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               total_revenue, total_spend, total_orders,
               new_customer_orders, returning_customer_orders,
               COALESCE(order_revenue, total_revenue) AS order_revenue,
               shopify_revenue, amazon_revenue, total_sales,
               COALESCE(refund_amount, 0) AS refund_amount, refund_count
        FROM   nobl_brand_tw_summary_daily
        WHERE  DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
        ORDER  BY date DESC
      `, [start, end]),

      // Daily channel rows (date × channel)
      pgQuery(`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               channel, spend_1d, revenue_1d, roas_1d, purchases_1d,
               new_cust_orders, cac
        FROM   nobl_brand_tw_channel_daily
        WHERE  DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
        ORDER  BY date DESC, channel
      `, [start, end]),

      // Daily geo rows (date × region) — EU always included, TOTAL excluded
      pgQuery(`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               region, revenue_actual, spend_actual, mer AS mer_stored
        FROM   nobl_brand_tw_geo_daily
        WHERE  DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
          AND  region != 'TOTAL'
        ORDER  BY date DESC, region
      `, [start, end]),

      // Daily subscription revenue
      pgQuery(`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               shopify_sub_gross, shopify_sub_disc, shopify_sub_refunds,
               rebill_revenue, new_sub_revenue, sub_revenue_actual
        FROM   nobl_air_sub_revenue_daily
        WHERE  DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
        ORDER  BY date DESC
      `, [start, end]),

      // Subscriber stats (all-time snapshot)
      pgQuery(`
        SELECT
          COUNT(*)                                                     AS total,
          SUM(CASE WHEN status='active'    THEN 1 ELSE 0 END)         AS active,
          SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END)         AS cancelled,
          SUM(CASE WHEN status='trialing'  THEN 1 ELSE 0 END)         AS trialing,
          SUM(CASE WHEN status='converted' THEN 1 ELSE 0 END)         AS converted,
          AVG(last_order_amount)                                       AS avg_order_amount
        FROM appstle_subscriptions
      `, []),

      // Klaviyo daily email data
      pgQuery(`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               emails_sent, emails_opened, emails_clicked,
               open_rate, click_rate, revenue AS email_revenue
        FROM   klaviyo_daily
        WHERE  brand = 'NOBL'
          AND  DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
        ORDER  BY date DESC
      `, [start, end]).catch(() => ({ rows: [] })),
    ]);

    // Enrich summary — order_revenue is the canonical metric for MER and AOV
    const summary = fmtRows(summaryRes.rows).map(r => {
      const rev = parseFloat(r.order_revenue || r.total_revenue || 0);
      return {
        ...r,
        revenue:           rev,  // canonical revenue (order_revenue with fallback)
        shopify_revenue:   parseFloat(r.shopify_revenue || 0),
        amazon_revenue:    parseFloat(r.amazon_revenue  || 0),
        total_sales:       parseFloat(r.total_sales     || 0),
        refund_amount:     parseFloat(r.refund_amount   || 0),
        mer:     calcMer(rev, r.total_spend),
        aov:     r.total_orders > 0 ? parseFloat((rev / r.total_orders).toFixed(2)) : null,
        nvp_pct: r.total_orders > 0 ? parseFloat(((r.new_customer_orders / r.total_orders) * 100).toFixed(1)) : null,
        rc_pct:  r.total_orders > 0 ? parseFloat(((r.returning_customer_orders / r.total_orders) * 100).toFixed(1)) : null,
      };
    });

    // Enrich channels — always recalculate ROAS, never trust stored roas
    const channels = fmtRows(channelsRes.rows).map(r => ({
      ...r,
      roas: calcMer(r.revenue_1d, r.spend_1d),
    }));

    // Enrich geo — always recalculate MER
    const geo = fmtRows(geoRes.rows).map(r => ({
      date:           r.date,
      region:         r.region,
      revenue:        r.revenue_actual,
      spend:          r.spend_actual,
      mer:            calcMer(r.revenue_actual, r.spend_actual),
    }));

    const subs_daily = fmtRows(subsRes.rows);

    const ss = subsStatsRes.rows[0] || {};
    const subs_stats = {
      total:            parseInt(ss.total            || 0),
      active:           parseInt(ss.active           || 0),
      cancelled:        parseInt(ss.cancelled        || 0),
      trialing:         parseInt(ss.trialing         || 0),
      converted:        parseInt(ss.converted        || 0),
      avg_order_amount: parseFloat(ss.avg_order_amount || 0),
    };

    const email = fmtRows(emailRes.rows);

    res.json({ summary, channels, geo, subs_daily, subs_stats, email });
  } catch (e) {
    console.error('[Store /nobl]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/store/flo ──────────────────────────────────────────────────────
// Returns complete Pilates FLO data: summary, channels, geo, products, email
router.get('/flo', async (req, res) => {
  const { start, end } = getDefaultDates(req);
  try {
    const [summaryRes, channelsRes, geoRes, productsRes, emailRes] = await Promise.all([

      // Daily summary — order_revenue is canonical
      pgQuery(`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               total_revenue, total_spend, total_orders,
               new_customer_orders, returning_customer_orders,
               COALESCE(order_revenue, total_revenue) AS order_revenue,
               shopify_revenue, amazon_revenue, total_sales,
               COALESCE(refund_amount, 0) AS refund_amount, refund_count
        FROM   flo_brand_tw_summary_daily
        WHERE  DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
        ORDER  BY date DESC
      `, [start, end]),

      // Daily channel rows
      pgQuery(`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               channel, spend_1d, revenue_1d, roas_1d, purchases_1d,
               new_cust_orders, cac
        FROM   flo_brand_tw_channel_daily
        WHERE  DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
        ORDER  BY date DESC, channel
      `, [start, end]),

      // Daily geo rows
      pgQuery(`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               region, revenue_actual, spend_actual
        FROM   flo_brand_tw_geo_daily
        WHERE  DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
          AND  region != 'TOTAL'
        ORDER  BY date DESC, region
      `, [start, end]),

      // Daily product rows (date × product_line)
      pgQuery(`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               product_line, spend, revenue, new_cust_orders,
               meta_spend, google_spend, tiktok_spend, snap_spend,
               pinterest_spend, bing_spend, applovin_spend
        FROM   flo_brand_tw_product_daily
        WHERE  DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
        ORDER  BY date DESC, product_line
      `, [start, end]),

      // Klaviyo email
      pgQuery(`
        SELECT TO_CHAR(date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               emails_sent, emails_opened, emails_clicked,
               open_rate, click_rate, revenue AS email_revenue
        FROM   klaviyo_daily
        WHERE  brand = 'FLO'
          AND  DATE(date AT TIME ZONE 'UTC') BETWEEN $1::date AND $2::date
        ORDER  BY date DESC
      `, [start, end]).catch(() => ({ rows: [] })),
    ]);

    const summary = fmtRows(summaryRes.rows).map(r => {
      const rev = parseFloat(r.order_revenue || r.total_revenue || 0);
      return {
        ...r,
        revenue:        rev,
        shopify_revenue: parseFloat(r.shopify_revenue || 0),
        amazon_revenue:  parseFloat(r.amazon_revenue  || 0),
        total_sales:     parseFloat(r.total_sales     || 0),
        refund_amount:   parseFloat(r.refund_amount   || 0),
        mer:     calcMer(rev, r.total_spend),
        aov:     r.total_orders > 0 ? parseFloat((rev / r.total_orders).toFixed(2)) : null,
        nvp_pct: r.total_orders > 0 ? parseFloat(((r.new_customer_orders / r.total_orders) * 100).toFixed(1)) : null,
        rc_pct:  r.total_orders > 0 ? parseFloat(((r.returning_customer_orders / r.total_orders) * 100).toFixed(1)) : null,
      };
    });

    const channels = fmtRows(channelsRes.rows).map(r => ({
      ...r,
      roas: calcMer(r.revenue_1d, r.spend_1d),
    }));

    const geo = fmtRows(geoRes.rows).map(r => ({
      date:    r.date,
      region:  r.region,
      revenue: r.revenue_actual,
      spend:   r.spend_actual,
      mer:     calcMer(r.revenue_actual, r.spend_actual),
    }));

    const products = fmtRows(productsRes.rows).map(r => ({
      ...r,
      mer: calcMer(r.revenue, r.spend),
    }));

    const email = fmtRows(emailRes.rows);

    res.json({ summary, channels, geo, products, email });
  } catch (e) {
    console.error('[Store /flo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
