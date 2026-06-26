require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const express = require('express');
const router = express.Router();
const { pgQuery } = require('../db/postgres');
const { checkDataGaps } = require('../etl/syncEngine');

/**
 * GET /api/sync/status
 * Returns recent ETL run log, per-task last success dates, data freshness, and gap summary.
 */
router.get('/', async (req, res) => {
  try {
    // ── 1. Last 20 ETL runs ──────────────────────────────────────────────────
    const recentResult = await pgQuery(
      `SELECT id, run_id, brand, task, start_date, end_date, status,
              rows_written, error_message, started_at, finished_at
       FROM etl_run_log
       ORDER BY started_at DESC
       LIMIT 20`
    );
    const recent = recentResult.rows.map(r => {
      const startedAt  = r.started_at  ? new Date(r.started_at)  : null;
      const finishedAt = r.finished_at ? new Date(r.finished_at) : null;
      return {
        ...r,
        start_date:  r.start_date  ? (r.start_date instanceof Date  ? r.start_date.toISOString().slice(0,10)  : String(r.start_date).slice(0,10))  : null,
        end_date:    r.end_date    ? (r.end_date   instanceof Date  ? r.end_date.toISOString().slice(0,10)    : String(r.end_date).slice(0,10))    : null,
        started_at:  startedAt  ? startedAt.toISOString()  : null,
        finished_at: finishedAt ? finishedAt.toISOString() : null,
        duration_ms: startedAt && finishedAt ? finishedAt - startedAt : null,
      };
    });

    // ── 2. Last success date per brand+task ──────────────────────────────────
    const lastSuccessResult = await pgQuery(
      `SELECT brand, task, MAX(finished_at) AS last_success, SUM(rows_written) AS total_rows
       FROM etl_run_log
       WHERE status = 'success'
       GROUP BY brand, task
       ORDER BY brand, task`
    );
    const last_success_by_task = {};
    for (const row of lastSuccessResult.rows) {
      const key = `${row.brand}::${row.task}`;
      last_success_by_task[key] = {
        brand:       row.brand,
        task:        row.task,
        last_success: row.last_success ? new Date(row.last_success).toISOString() : null,
        total_rows:  parseInt(row.total_rows || 0),
      };
    }

    // ── 3. Data freshness ────────────────────────────────────────────────────
    const fmtD = (d) => d ? (d instanceof Date ? d.toISOString().slice(0,10) : String(d).slice(0,10)) : null;

    // Freshness for the data sources that are actually live in the current
    // pipeline. (The old tw_orders/sessions/customers/segments/refunds/email_sms/
    // benchmarks tables are unused/empty and were dropped from this view.)
    const [
      noblSummR, floSummR, noblChR, floChR, appstleR, klavR, twAdsR, metaAdsR,
      noblAirR, iapRevR, iapSubR, forecastR, perfR, opsR, csR, sessionsR, emailSmsR,
    ] = await Promise.all([
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM nobl_brand_tw_summary_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM flo_brand_tw_summary_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM nobl_brand_tw_channel_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM flo_brand_tw_channel_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT COUNT(*) as cnt, COUNT(CASE WHEN status='active' THEN 1 END) as active_cnt FROM appstle_subscriptions`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM klaviyo_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM tw_ads_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM meta_ads_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM nobl_air_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM iap_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM iap_subscription_daily`).catch(() => ({ rows: [{}] })),
      // Plan/import tables are future-dated, so freshness uses MAX(updated_at) = last import.
      pgQuery(`SELECT MAX(updated_at)::date as max_date, COUNT(*) as cnt FROM forecast_plan_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(updated_at)::date as max_date, COUNT(*) as cnt FROM brand_performance_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM ops_metrics_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM cs_tickets_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM tw_sessions_daily`).catch(() => ({ rows: [{}] })),
      pgQuery(`SELECT MAX(date) as max_date, COUNT(*) as cnt FROM tw_email_sms_daily`).catch(() => ({ rows: [{}] })),
    ]);

    const mk = (r, extra = {}) => ({ latest_date: fmtD(r.rows[0]?.max_date), row_count: parseInt(r.rows[0]?.cnt || 0), ...extra });
    const data_freshness = {
      nobl_summary:   mk(noblSummR),
      flo_summary:    mk(floSummR),
      nobl_channels:  mk(noblChR),
      flo_channels:   mk(floChR),
      meta_ads:       mk(metaAdsR),
      tw_ads:         mk(twAdsR),
      klaviyo_emails: mk(klavR),
      nobl_subs:      { latest_date: null, row_count: parseInt(appstleR.rows[0]?.cnt || 0), active: parseInt(appstleR.rows[0]?.active_cnt || 0) },
      nobl_air:       mk(noblAirR),
      iap_revenue:    mk(iapRevR),
      iap_subs:       mk(iapSubR),
      forecast_plan:  mk(forecastR),
      performance:    mk(perfR),
      ops_metrics:    mk(opsR),
      cs_tickets:     mk(csR),
      tw_sessions:    mk(sessionsR),
      tw_email_sms:   mk(emailSmsR),
    };

    // ── 4. Gap check (quick, only check last 90 days) ────────────────────────
    let gaps = {};
    try {
      const [noblGaps, floGaps, klavGaps] = await Promise.all([
        checkDataGaps('nobl_brand_tw_summary_daily', 'NOBL'),
        checkDataGaps('flo_brand_tw_summary_daily',  'FLO'),
        checkDataGaps('klaviyo_daily', 'NOBL'),
      ]);
      gaps = {
        nobl_summary: { missing_count: noblGaps.missing.length, sample: noblGaps.missing.slice(0, 5) },
        flo_summary:  { missing_count: floGaps.missing.length,  sample: floGaps.missing.slice(0, 5) },
        klaviyo:      { missing_count: klavGaps.missing.length,  sample: klavGaps.missing.slice(0, 5) },
      };
    } catch (e) {
      gaps = { error: e.message };
    }

    res.json({
      ok: true,
      recent,
      last_success_by_task,
      data_freshness,
      gaps,
      generated_at: new Date().toISOString(),
    });

  } catch (e) {
    console.error('[SyncStatus]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
