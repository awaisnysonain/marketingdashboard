/**
 * Live Data routes — powered by PostgreSQL (synced TW data)
 * GET /api/tw/live     — snapshot for a date
 * GET /api/tw/trend    — daily MER/revenue/spend trend
 * GET /api/tw/channels — channel breakdown for a date range
 * GET /api/tw/geo      — regional MER breakdown
 */

const express  = require('express');
const router   = express.Router();
const { pgQuery } = require('../db/postgres');

// ── Performance thresholds (from DanielMetricsData.js) ───────────────────────
const THRESHOLDS = {
  mer:   { global: { red: 1.8, yellow: 2.0 }, dubai: { red: 1.6, yellow: 1.8 } },
  roas:  {
    META:     { red: 1.6, yellow: 1.8 },
    GOOGLE:   { red: 2.0, yellow: 3.0 },
    APPLOVIN: { red: 2.0, yellow: 2.2 },
    SNAPCHAT: { red: 1.6, yellow: 1.8 },
    TIKTOK:   { red: 1.6, yellow: 1.8 },
    BING:     { red: 1.5, yellow: 2.0 },
    PINTEREST:{ red: 1.5, yellow: 2.0 },
    X:        { red: 1.5, yellow: 2.0 },
    default:  { red: 1.5, yellow: 2.0 },
  },
  nvp:    { red: 0.45, yellow: 0.50 },
  refund: { red_above: 0.13, yellow_above: 0.06 },
};

function classify(value, t, invert = false) {
  if (value == null || isNaN(value)) return 'gray';
  if (invert) {
    if (value > t.red_above)    return 'red';
    if (value > t.yellow_above) return 'yellow';
    return 'green';
  }
  if (value < t.red)    return 'red';
  if (value < t.yellow) return 'yellow';
  return 'green';
}

// Brand → DB brand string
const BRAND_MAP = { nobl: 'NOBL', flo: 'FLO', flo_eu: 'FLO' };

/**
 * Find the most-recent date available in a table for a given brand.
 * Falls back to "yesterday" if the table is empty.
 */
async function latestDate(table, brand) {
  try {
    const r = await pgQuery(
      `SELECT MAX(DATE(date AT TIME ZONE 'UTC')) AS mx FROM ${table} WHERE brand = $1`,
      [brand]
    );
    return r.rows[0]?.mx
      ? String(r.rows[0].mx).slice(0, 10)
      : (() => { const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })();
  } catch {
    const d = new Date(); d.setDate(d.getDate()-1);
    return d.toISOString().slice(0,10);
  }
}

// ── GET /api/tw/live ─────────────────────────────────────────────────────────
router.get('/live', async (req, res) => {
  const dbBrand = BRAND_MAP[req.query.brand] || 'NOBL';
  const reqDate = req.query.date;    // YYYY-MM-DD

  try {
    // If no date given, use latest available in summary table
    const date = reqDate || await latestDate('tw_summary_daily', dbBrand);

    // ── 1. Summary ─────────────────────────────────────────────────────────────
    const summaryR = await pgQuery(
      `SELECT total_revenue, total_spend, mer,
              total_orders, new_customer_orders, returning_customer_orders
       FROM tw_summary_daily
       WHERE brand = $1
         AND DATE(date AT TIME ZONE 'UTC') = $2::date
       LIMIT 1`,
      [dbBrand, date]
    );

    // ── 2. Channels ────────────────────────────────────────────────────────────
    const channelsR = await pgQuery(
      `SELECT channel, spend_1d, revenue_1d, roas_1d, purchases_1d,
              new_cust_orders, cac, spend_7d
       FROM tw_channel_daily
       WHERE brand = $1
         AND DATE(date AT TIME ZONE 'UTC') = $2::date
       ORDER BY spend_1d DESC NULLS LAST`,
      [dbBrand, date]
    );

    // ── 3. Geo breakdown ───────────────────────────────────────────────────────
    const geoR = await pgQuery(
      `SELECT region, revenue_actual, spend_actual, mer
       FROM tw_geo_daily
       WHERE brand = $1
         AND DATE(date AT TIME ZONE 'UTC') = $2::date
       ORDER BY spend_actual DESC NULLS LAST`,
      [dbBrand, date]
    );

    const sum = summaryR.rows[0] || {};
    const totalRevenue = parseFloat(sum.total_revenue || 0);
    const totalSpend   = parseFloat(sum.total_spend   || 0);
    const totalOrders  = parseInt(sum.total_orders    || 0);
    const ncOrders     = parseInt(sum.new_customer_orders || 0);
    const retOrders    = parseInt(sum.returning_customer_orders || 0);
    const merVal       = totalSpend > 0 ? totalRevenue / totalSpend : parseFloat(sum.mer || 0);
    const aov          = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const ncRate       = totalOrders > 0 ? ncOrders / totalOrders : 0;

    const channels = channelsR.rows.map(ch => {
      const t   = THRESHOLDS.roas[ch.channel] || THRESHOLDS.roas.default;
      const roas = parseFloat(ch.roas_1d || 0);
      return {
        channel:      ch.channel,
        spend:        parseFloat(ch.spend_1d    || 0),
        revenue:      parseFloat(ch.revenue_1d  || 0),
        roas:         roas,
        purchases:    parseFloat(ch.purchases_1d || 0),
        nc_orders:    parseFloat(ch.new_cust_orders || 0),
        cac:          parseFloat(ch.cac         || 0),
        spend_7d:     parseFloat(ch.spend_7d    || 0),
        roas_status:  classify(roas, t),
      };
    });

    const geo = geoR.rows.map(g => {
      const rev   = parseFloat(g.revenue_actual || 0);
      const spend = parseFloat(g.spend_actual   || 0);
      const mer   = spend > 0 ? rev / spend : parseFloat(g.mer || 0);
      const t     = g.region === 'DUBAI' ? THRESHOLDS.mer.dubai : THRESHOLDS.mer.global;
      return {
        region:     g.region,
        revenue:    rev,
        spend:      spend,
        mer:        parseFloat(mer.toFixed(4)),
        mer_status: classify(mer, t),
      };
    });

    // Latest dates available (for UI info)
    const latestChannelDate = channelsR.rows.length ? date : await latestDate('tw_channel_daily', dbBrand);

    res.json({
      ok: true,
      date,
      latest_channel_date: latestChannelDate,
      brand: req.query.brand || 'nobl',
      summary: {
        total_revenue:        totalRevenue,
        total_spend:          totalSpend,
        mer:                  parseFloat(merVal.toFixed(4)),
        mer_status:           classify(merVal, THRESHOLDS.mer.global),
        total_orders:         totalOrders,
        new_customer_orders:  ncOrders,
        returning_orders:     retOrders,
        new_customer_rate:    parseFloat(ncRate.toFixed(4)),
        aov:                  parseFloat(aov.toFixed(2)),
      },
      channels,
      geo,
      generated_at: new Date().toISOString(),
    });

  } catch (e) {
    console.error('[TW live]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tw/trend ─────────────────────────────────────────────────────────
router.get('/trend', async (req, res) => {
  const dbBrand = BRAND_MAP[req.query.brand] || 'NOBL';
  const days    = Math.min(parseInt(req.query.days || 30), 90);
  const endDate = req.query.endDate || await latestDate('tw_summary_daily', dbBrand);
  const startDate = (() => {
    const d = new Date(endDate); d.setDate(d.getDate() - days + 1);
    return d.toISOString().slice(0, 10);
  })();

  try {
    const r = await pgQuery(
      `SELECT
         DATE(date AT TIME ZONE 'UTC')                     AS date,
         total_revenue                                     AS revenue,
         total_spend                                       AS spend,
         CASE WHEN total_spend > 0
              THEN ROUND((total_revenue / total_spend)::numeric, 4)
              ELSE mer END                                 AS mer,
         total_orders                                      AS orders,
         new_customer_orders                               AS nc_orders,
         CASE WHEN total_orders > 0
              THEN ROUND((total_revenue / total_orders)::numeric, 2)
              ELSE 0 END                                   AS aov
       FROM tw_summary_daily
       WHERE brand = $1
         AND DATE(date AT TIME ZONE 'UTC') BETWEEN $2::date AND $3::date
       ORDER BY date ASC`,
      [dbBrand, startDate, endDate]
    );

    const trend = r.rows.map(row => ({
      date:       String(row.date).slice(0, 10),
      revenue:    parseFloat(row.revenue || 0),
      spend:      parseFloat(row.spend   || 0),
      mer:        parseFloat(row.mer     || 0),
      orders:     parseInt(row.orders    || 0),
      nc_orders:  parseInt(row.nc_orders || 0),
      aov:        parseFloat(row.aov     || 0),
      mer_status: classify(parseFloat(row.mer || 0), THRESHOLDS.mer.global),
    }));

    res.json({ ok: true, brand: req.query.brand || 'nobl', startDate, endDate, trend });

  } catch (e) {
    console.error('[TW trend]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tw/channels ──────────────────────────────────────────────────────
router.get('/channels', async (req, res) => {
  const dbBrand   = BRAND_MAP[req.query.brand] || 'NOBL';
  const latestCh  = await latestDate('tw_channel_daily', dbBrand);
  const endDate   = req.query.endDate   || latestCh;
  const startDate = req.query.startDate || (() => {
    const d = new Date(endDate); d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  })();

  try {
    const r = await pgQuery(
      `SELECT
         channel,
         SUM(spend_1d)        AS total_spend,
         SUM(revenue_1d)      AS total_revenue,
         SUM(purchases_1d)    AS total_purchases,
         SUM(new_cust_orders) AS total_nc_orders,
         CASE WHEN SUM(spend_1d) > 0
              THEN ROUND((SUM(revenue_1d) / SUM(spend_1d))::numeric, 4)
              ELSE 0 END      AS roas,
         CASE WHEN SUM(new_cust_orders) > 0
              THEN ROUND((SUM(spend_1d) / SUM(new_cust_orders))::numeric, 2)
              ELSE 0 END      AS nc_cpa,
         CASE WHEN SUM(purchases_1d) > 0
              THEN ROUND((SUM(revenue_1d) / SUM(purchases_1d))::numeric, 2)
              ELSE 0 END      AS aov
       FROM tw_channel_daily
       WHERE brand = $1
         AND DATE(date AT TIME ZONE 'UTC') BETWEEN $2::date AND $3::date
       GROUP BY channel
       ORDER BY total_spend DESC NULLS LAST`,
      [dbBrand, startDate, endDate]
    );

    const channels = r.rows.map(ch => {
      const t    = THRESHOLDS.roas[ch.channel] || THRESHOLDS.roas.default;
      const roas = parseFloat(ch.roas || 0);
      return {
        channel:      ch.channel,
        spend:        parseFloat(ch.total_spend    || 0),
        revenue:      parseFloat(ch.total_revenue  || 0),
        roas:         roas,
        purchases:    parseFloat(ch.total_purchases || 0),
        nc_orders:    parseFloat(ch.total_nc_orders || 0),
        nc_cpa:       parseFloat(ch.nc_cpa         || 0),
        aov:          parseFloat(ch.aov            || 0),
        roas_status:  classify(roas, t),
      };
    });

    res.json({ ok: true, brand: req.query.brand || 'nobl', startDate, endDate, channels });

  } catch (e) {
    console.error('[TW channels]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tw/geo ───────────────────────────────────────────────────────────
router.get('/geo', async (req, res) => {
  const dbBrand   = BRAND_MAP[req.query.brand] || 'NOBL';
  const latestG   = await latestDate('tw_geo_daily', dbBrand);
  const endDate   = req.query.endDate   || latestG;
  const startDate = req.query.startDate || (() => {
    const d = new Date(endDate); d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  })();

  try {
    const r = await pgQuery(
      `SELECT
         region,
         SUM(revenue_actual) AS revenue,
         SUM(spend_actual)   AS spend,
         CASE WHEN SUM(spend_actual) > 0
              THEN ROUND((SUM(revenue_actual) / SUM(spend_actual))::numeric, 4)
              ELSE 0 END     AS mer
       FROM tw_geo_daily
       WHERE brand = $1
         AND DATE(date AT TIME ZONE 'UTC') BETWEEN $2::date AND $3::date
         AND region != 'TOTAL'
       GROUP BY region
       ORDER BY spend DESC NULLS LAST`,
      [dbBrand, startDate, endDate]
    );

    const regions = r.rows.map(g => {
      const mer = parseFloat(g.mer || 0);
      const t   = g.region === 'DUBAI' ? THRESHOLDS.mer.dubai : THRESHOLDS.mer.global;
      return {
        region:     g.region,
        revenue:    parseFloat(g.revenue || 0),
        spend:      parseFloat(g.spend   || 0),
        mer:        mer,
        mer_status: classify(mer, t),
      };
    });

    res.json({ ok: true, brand: req.query.brand || 'nobl', startDate, endDate, regions });

  } catch (e) {
    console.error('[TW geo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tw/available-dates ───────────────────────────────────────────────
router.get('/available-dates', async (req, res) => {
  const dbBrand = BRAND_MAP[req.query.brand] || 'NOBL';
  try {
    const r = await pgQuery(
      `SELECT
         MAX(DATE(date AT TIME ZONE 'UTC')) AS latest_summary,
         MIN(DATE(date AT TIME ZONE 'UTC')) AS oldest_summary
       FROM tw_summary_daily WHERE brand = $1`,
      [dbBrand]
    );
    const ch = await pgQuery(
      `SELECT MAX(DATE(date AT TIME ZONE 'UTC')) AS latest_channel
       FROM tw_channel_daily WHERE brand = $1`,
      [dbBrand]
    );
    res.json({
      ok: true,
      latest_summary: String(r.rows[0]?.latest_summary || '').slice(0,10),
      oldest_summary: String(r.rows[0]?.oldest_summary || '').slice(0,10),
      latest_channel: String(ch.rows[0]?.latest_channel || '').slice(0,10),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.THRESHOLDS = THRESHOLDS;
module.exports.classify   = classify;
