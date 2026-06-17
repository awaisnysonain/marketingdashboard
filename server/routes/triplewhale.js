/**
 * Live Data routes — powered by PostgreSQL
 *
 * Data sources verified 2026-04-29:
 *  - tw_summary_daily        → summary KPIs, has orders, through Apr 29 (stored `mer` column is WRONG — always recalculate)
 *  - tw_channel_daily        → channel breakdown, NOBL valid through Apr 22, FLO through Apr 23
 *  - nobl_brand_tw_geo_daily → NOBL regional MER, valid through Apr 22 (has correct MER)
 *  - flo_brand_tw_geo_daily  → FLO regional MER, valid through Apr 23 (has correct MER)
 *  - nobl_main_tw_store_summary_daily → NOBL store-level summary (correct MER, no orders)
 *  - flo_main_tw_store_summary_daily  → FLO store-level summary
 *  - flo_eu_tw_store_summary_daily    → FLO EU store-level summary
 */

const express  = require('express');
const router   = express.Router();
const { pgQuery } = require('../db/postgres');
const { getBrand, THRESHOLDS, classify, calcMer } = require('../config/brandConfig');
const { reportTodayStr, reportYesterdayStr, SUMMARY_HAS_DATA_SQL } = require('../utils/reportTime');

/*
 * ══════════════════════════════════════════════════════════════
 *  BRAND RULE: NOBL TRAVEL + NOBL EU = ONE STORE, ALWAYS COMBINED
 *  See server/config/brandConfig.js for full documentation.
 *  Never query NOBL without EU. Never separate them.
 * ══════════════════════════════════════════════════════════════
 */

/**
 * Find the most-recent date in tw_summary_daily for a brand.
 * Falls back to yesterday if empty.
 */
async function latestSummaryDate(dbBrand) {
  const today = reportTodayStr();
  try {
    // Prefer today when hourly Live snapshot has landed partial ET data.
    const todayR = await pgQuery(
      `SELECT date::text AS d FROM tw_summary_daily
       WHERE brand = $1 AND date = $2::date AND ${SUMMARY_HAS_DATA_SQL}
       LIMIT 1`,
      [dbBrand, today]
    );
    if (todayR.rows[0]?.d) return todayR.rows[0].d;

    const r = await pgQuery(
      `SELECT MAX(date)::text AS mx
       FROM tw_summary_daily
       WHERE brand = $1 AND ${SUMMARY_HAS_DATA_SQL}`,
      [dbBrand]
    );
    return r.rows[0]?.mx || reportYesterdayStr();
  } catch {
    return reportYesterdayStr();
  }
}

/**
 * Find the most-recent VALID channel date for a brand.
 * "Valid" = total channel spend on that day > $50 (filters corrupted partial days).
 * NOBL Apr 23 only had $9.72 Pinterest spend — this skips it.
 */
async function latestValidChannelDate(dbBrand) {
  try {
    const r = await pgQuery(
      `SELECT MAX(date)::text AS mx
       FROM (
         SELECT date
         FROM tw_channel_daily
         WHERE brand = $1
         GROUP BY date
         HAVING SUM(spend_1d) > 50
       ) sub`,
      [dbBrand]
    );
    return r.rows[0]?.mx || reportYesterdayStr();
  } catch {
    return reportYesterdayStr();
  }
}

/**
 * Find the most-recent VALID geo date for a brand.
 */
async function latestValidGeoDate(brandParam) {
  const brand    = getBrand(brandParam);
  const geoTable = brand.geoTable || 'nobl_brand_tw_geo_daily';
  try {
    const r = await pgQuery(
      `SELECT MAX(date)::text AS mx
       FROM (
         SELECT date
         FROM ${geoTable}
         WHERE region != 'TOTAL'
         GROUP BY date
         HAVING SUM(spend_actual) > 50
       ) sub`
    );
    return r.rows[0]?.mx || reportYesterdayStr();
  } catch {
    return reportYesterdayStr();
  }
}

// ── GET /api/tw/live ─────────────────────────────────────────────────────────
router.get('/live', async (req, res) => {
  const brandParam = req.query.brand || 'nobl';
  const brand      = getBrand(brandParam);          // always use brandConfig — enforces NOBL+EU rule
  const dbBrand    = brand.dbBrand;
  const geoTable   = brand.geoTable || 'nobl_brand_tw_geo_daily';

  try {
    // Determine dates
    const [summaryLatest, chLatest, geoLatest] = await Promise.all([
      latestSummaryDate(dbBrand),
      latestValidChannelDate(dbBrand),
      latestValidGeoDate(brandParam),
    ]);

    const reqDate = req.query.date;
    const summaryDate = reqDate || summaryLatest;
    // For channels/geo: use requested date only if it's ≤ their latest valid date.
    // If requested date is newer than what's available (ETL lag), fall back to their latest.
    const channelDate = (reqDate && reqDate <= chLatest) ? reqDate : chLatest;
    const geoDate     = (reqDate && reqDate <= geoLatest) ? reqDate : geoLatest;

    // ── 1. Summary (tw_summary_daily has orders; always recalculate MER) ────────
    const summaryR = await pgQuery(
      `SELECT COALESCE(order_revenue, total_revenue) AS order_revenue,
              total_revenue, total_spend,
              total_orders, new_customer_orders, returning_customer_orders
       FROM tw_summary_daily
       WHERE brand = $1 AND date = $2::date
       LIMIT 1`,
      [dbBrand, summaryDate]
    );

    // ── 2. Channels ────────────────────────────────────────────────────────────
    const channelsR = await pgQuery(
      `SELECT channel, spend_1d, revenue_1d, roas_1d, purchases_1d,
              new_cust_orders, cac, spend_7d
       FROM tw_channel_daily
       WHERE brand = $1 AND date = $2::date
       ORDER BY spend_1d DESC NULLS LAST`,
      [dbBrand, channelDate]
    );

    // ── 3. Geo (use brand-specific table — has correct stored MER) ─────────────
    // For NOBL: always include ALL regions including EU, even if spend=$0 for that date
    const geoR = await pgQuery(
      brandParam === 'nobl'
        ? `SELECT region, revenue_actual, spend_actual, mer
           FROM ${geoTable}
           WHERE date = $1::date AND region != 'TOTAL'
           ORDER BY spend_actual DESC NULLS LAST`
        : `SELECT region, revenue_actual, spend_actual, mer
           FROM ${geoTable}
           WHERE date = $1::date AND region != 'TOTAL' AND spend_actual > 0
           ORDER BY spend_actual DESC NULLS LAST`,
      [geoDate]
    );

    const sum = summaryR.rows[0] || {};
    const totalRevenue = parseFloat(sum.order_revenue || sum.total_revenue || 0);
    const totalSpend   = parseFloat(sum.total_spend   || 0);
    const totalOrders  = parseInt(sum.total_orders    || 0);
    const ncOrders     = parseInt(sum.new_customer_orders || 0);
    const retOrders    = parseInt(sum.returning_customer_orders || 0);
    const merVal       = calcMer(totalRevenue, totalSpend);
    const aov          = totalOrders > 0 ? parseFloat((totalRevenue / totalOrders).toFixed(2)) : 0;
    const ncRate       = totalOrders > 0 ? parseFloat((ncOrders / totalOrders).toFixed(4)) : 0;

    // For NOBL: compute EU contribution (from geo data) to surface it clearly
    const euGeoRow = brandParam === 'nobl'
      ? geoR.rows.find(r => r.region === 'EU') || null
      : null;
    const euContrib = euGeoRow ? {
      revenue:    parseFloat(euGeoRow.revenue_actual || 0),
      spend:      parseFloat(euGeoRow.spend_actual   || 0),
      mer:        calcMer(parseFloat(euGeoRow.revenue_actual || 0), parseFloat(euGeoRow.spend_actual || 0)),
      rev_pct:    totalRevenue > 0
        ? parseFloat(((parseFloat(euGeoRow.revenue_actual || 0) / totalRevenue) * 100).toFixed(2))
        : 0,
    } : null;

    const channels = channelsR.rows.map(ch => {
      const t    = THRESHOLDS.roas[ch.channel] || THRESHOLDS.roas.default;
      const roas = parseFloat(ch.roas_1d || 0);
      return {
        channel:     ch.channel,
        spend:       parseFloat(ch.spend_1d      || 0),
        revenue:     parseFloat(ch.revenue_1d    || 0),
        roas,
        purchases:   parseFloat(ch.purchases_1d  || 0),
        nc_orders:   parseFloat(ch.new_cust_orders || 0),
        cac:         parseFloat(ch.cac           || 0),
        spend_7d:    parseFloat(ch.spend_7d      || 0),
        roas_status: classify(roas, t),
      };
    });

    const geo = geoR.rows.map(g => {
      const rev   = parseFloat(g.revenue_actual || 0);
      const spend = parseFloat(g.spend_actual   || 0);
      // Recalculate MER from actual values for accuracy
      const mer   = spend > 0 ? calcMer(rev, spend) : parseFloat(g.mer || 0);
      const t     = g.region === 'DUBAI' ? THRESHOLDS.mer.dubai : THRESHOLDS.mer.global;
      return {
        region:     g.region,
        revenue:    rev,
        spend,
        mer,
        mer_status: classify(mer, t),
      };
    });

    res.json({
      ok: true,
      brand: brandParam,
      // Dates used for each section (may differ if channel/geo haven't caught up)
      summary_date:  summaryDate,
      channel_date:  channelDate,
      geo_date:      geoDate,
      date:          summaryDate, // backwards compat
      // Latest available for each type
      latest_summary_date: summaryLatest,
      latest_channel_date: chLatest,
      latest_geo_date:     geoLatest,
      // Flag when channel/geo are behind summary
      channel_lag: chLatest < summaryLatest,
      geo_lag:     geoLatest < summaryLatest,
      summary: {
        total_revenue:       totalRevenue,
        order_revenue:       totalRevenue,
        total_spend:         totalSpend,
        mer:                 merVal,
        mer_status:          classify(merVal, THRESHOLDS.mer.global),
        total_orders:        totalOrders,
        new_customer_orders: ncOrders,
        returning_orders:    retOrders,
        new_customer_rate:   ncRate,
        aov,
      },
      channels,
      geo,
      // NOBL only: EU contribution breakdown (EU is always included in NOBL totals)
      eu_contribution: euContrib,
      generated_at: new Date().toISOString(),
    });

  } catch (e) {
    console.error('[TW live]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tw/trend ─────────────────────────────────────────────────────────
router.get('/trend', async (req, res) => {
  const dbBrand = getBrand(req.query.brand).dbBrand;
  const days    = Math.min(parseInt(req.query.days || 30), 90);
  const endDate = req.query.endDate || await latestSummaryDate(dbBrand);
  const startDate = (() => {
    const d = new Date(endDate); d.setDate(d.getDate() - days + 1);
    return d.toISOString().slice(0, 10);
  })();

  try {
    const r = await pgQuery(
      `SELECT
         date::text                                            AS date,
         total_revenue                                        AS revenue,
         total_spend                                          AS spend,
         CASE WHEN total_spend > 0
              THEN ROUND((total_revenue / total_spend)::numeric, 4)
              ELSE 0 END                                      AS mer,
         total_orders                                         AS orders,
         new_customer_orders                                  AS nc_orders,
         CASE WHEN total_orders > 0
              THEN ROUND((total_revenue / total_orders)::numeric, 2)
              ELSE 0 END                                      AS aov
       FROM tw_summary_daily
       WHERE brand = $1
         AND date BETWEEN $2::date AND $3::date
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
  const brandParam = req.query.brand || 'nobl';
  const dbBrand    = getBrand(brandParam).dbBrand;
  const chLatest   = await latestValidChannelDate(dbBrand);
  const endDate    = req.query.endDate   || chLatest;
  const startDate  = req.query.startDate || (() => {
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
         AND date BETWEEN $2::date AND $3::date
         AND spend_1d > 0
       GROUP BY channel
       ORDER BY total_spend DESC NULLS LAST`,
      [dbBrand, startDate, endDate]
    );

    const channels = r.rows.map(ch => {
      const t    = THRESHOLDS.roas[ch.channel] || THRESHOLDS.roas.default;
      const roas = parseFloat(ch.roas || 0);
      return {
        channel:     ch.channel,
        spend:       parseFloat(ch.total_spend    || 0),
        revenue:     parseFloat(ch.total_revenue  || 0),
        roas,
        purchases:   parseFloat(ch.total_purchases || 0),
        nc_orders:   parseFloat(ch.total_nc_orders || 0),
        nc_cpa:      parseFloat(ch.nc_cpa         || 0),
        aov:         parseFloat(ch.aov            || 0),
        roas_status: classify(roas, t),
      };
    });

    res.json({ ok: true, brand: brandParam, startDate, endDate, latest_channel_date: chLatest, channels });

  } catch (e) {
    console.error('[TW channels]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tw/geo ───────────────────────────────────────────────────────────
router.get('/geo', async (req, res) => {
  const brandParam = req.query.brand || 'nobl';
  const geoTable   = getBrand(brandParam).geoTable || 'nobl_brand_tw_geo_daily';
  const geoLatest  = await latestValidGeoDate(brandParam);
  const endDate    = req.query.endDate   || geoLatest;
  const startDate  = req.query.startDate || (() => {
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
       FROM ${geoTable}
       WHERE region != 'TOTAL'
         AND date BETWEEN $1::date AND $2::date
       GROUP BY region
       ORDER BY spend DESC NULLS LAST`,
      [startDate, endDate]
    );

    const regions = r.rows.map(g => {
      const mer = parseFloat(g.mer || 0);
      const t   = g.region === 'DUBAI' ? THRESHOLDS.mer.dubai : THRESHOLDS.mer.global;
      return {
        region:     g.region,
        revenue:    parseFloat(g.revenue || 0),
        spend:      parseFloat(g.spend   || 0),
        mer,
        mer_status: classify(mer, t),
      };
    });

    res.json({ ok: true, brand: brandParam, startDate, endDate, latest_geo_date: geoLatest, regions });

  } catch (e) {
    console.error('[TW geo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tw/available-dates ───────────────────────────────────────────────
router.get('/available-dates', async (req, res) => {
  const brandParam = req.query.brand || 'nobl';
  const dbBrand    = getBrand(brandParam).dbBrand;
  try {
    const [sumRes, chLatest, geoLatest] = await Promise.all([
      pgQuery(
        `SELECT
           MAX(date)::text AS latest_summary,
           MIN(date)::text AS oldest_summary
         FROM tw_summary_daily
         WHERE brand = $1 AND ${SUMMARY_HAS_DATA_SQL}`,
        [dbBrand]
      ),
      latestValidChannelDate(dbBrand),
      latestValidGeoDate(brandParam),
    ]);

    const latestSummary = await latestSummaryDate(dbBrand);

    res.json({
      ok: true,
      latest_summary: latestSummary || sumRes.rows[0]?.latest_summary || '',
      oldest_summary: sumRes.rows[0]?.oldest_summary || '',
      report_today:   reportTodayStr(),
      latest_channel: chLatest,
      latest_geo:     geoLatest,
      // Expose lag so UI can show a warning
      channel_lag: chLatest < latestSummary,
      geo_lag:     geoLatest < latestSummary,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tw/store-summary ─────────────────────────────────────────────────
// Returns the store-level daily summary (correct MER, no orders column)
router.get('/store-summary', async (req, res) => {
  const brandParam = req.query.brand || 'nobl';
  const storeTable = getBrand(brandParam).storeSummary || 'nobl_main_tw_store_summary_daily';
  const days       = Math.min(parseInt(req.query.days || 30), 90);

  try {
    const r = await pgQuery(
      `SELECT date::text, total_revenue, total_spend,
              CASE WHEN total_spend > 0
                   THEN ROUND((total_revenue / total_spend)::numeric, 4)
                   ELSE 0 END AS mer
       FROM ${storeTable}
       WHERE total_spend > 0
       ORDER BY date DESC LIMIT $1`,
      [days]
    );
    const rows = r.rows.map(row => ({
      date:    String(row.date).slice(0, 10),
      revenue: parseFloat(row.total_revenue || 0),
      spend:   parseFloat(row.total_spend   || 0),
      mer:     parseFloat(row.mer           || 0),
    })).reverse();
    res.json({ ok: true, brand: brandParam, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.THRESHOLDS = THRESHOLDS;
module.exports.classify   = classify;
