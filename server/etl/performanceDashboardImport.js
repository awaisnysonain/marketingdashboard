/**
 * Import NOBL + FLO performance dashboard sheet into PostgreSQL.
 * Also seeds FLO daily revenue forecasts (Revenue F) into forecast_daily.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pgRun, pgQuery } = require('../db/postgres');
const { PERFORMANCE_DASHBOARD } = require('../config/performanceDashboardConfig');
const { ensureForecastSchema, upsertForecastRows } = require('./forecastImport');
const { clearResponseCache } = require('../utils/responseCache');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseMoney(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,%]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function parsePct(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace('%', '').trim();
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function normalizeDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function findHeaderRow(lines) {
  for (let i = 0; i < Math.min(lines.length, 120); i++) {
    const c = parseCsvLine(lines[i]);
    if (c.some(h => /^date$/i.test(String(h).trim())) && c.some(h => /revenue \(f\)/i.test(String(h).trim()))) {
      return { index: i, header: c.map(h => String(h).trim()) };
    }
  }
  return null;
}

function colIdx(header, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  return header.findIndex(h => re.test(h));
}

async function ensurePerformanceSchema() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS brand_performance_daily (
      brand                 TEXT NOT NULL,
      date                  DATE NOT NULL,
      gross_sales_tw        NUMERIC(14,2),
      meta_cpmr             NUMERIC(10,2),
      revenue_forecast      NUMERIC(14,2),
      revenue_actual        NUMERIC(14,2),
      week_start            DATE,
      weekly_gross_sales    NUMERIC(14,2),
      avg_meta_cpmr         NUMERIC(10,2),
      rolling_7d_reach      BIGINT,
      rolling_7d_cpmr       NUMERIC(10,2),
      meta_cpmr_2025        NUMERIC(10,2),
      meta_cpmr_2026        NUMERIC(10,2),
      tiktok_cpmr_2025      NUMERIC(10,2),
      tiktok_cpmr_2026      NUMERIC(10,2),
      cvr_weekly            NUMERIC(8,4),
      source                TEXT DEFAULT 'import',
      updated_at            TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (brand, date)
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_brand_perf_daily_date ON brand_performance_daily (date DESC)`);
}

function parsePerformanceCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const hdr = findHeaderRow(lines);
  if (!hdr) throw new Error('Performance dashboard CSV: could not locate header row');

  const h = hdr.header;
  const cols = {
    noblDate: colIdx(h, /^date$/),
    noblGross: colIdx(h, /gross sales.*tw/i),
    noblCpmr: colIdx(h, /^meta cpmr$/),
    noblRevF: colIdx(h, /^revenue \(f\)$/),
    noblRevA: colIdx(h, /^revenue \(a\)$/),
    floDate: -1,
    floCpmr: -1,
    floRevF: -1,
    floRevA: -1,
    weekStart: colIdx(h, /^week start$/i),
    weeklyGross: colIdx(h, /weekly gross sales/i),
    avgCpmr: colIdx(h, /avg meta cpmr/i),
    rollDate: colIdx(h, /^date$/),
    rollReach: colIdx(h, /7d rolling reach/i),
    rollCpmr: colIdx(h, /7d rolling cpmr/i),
    meta25: colIdx(h, /^meta 2025 cpmr$/i),
    meta26: colIdx(h, /^meta 2026 cpmr$/i),
    tt25: colIdx(h, /^tiktok 2025 cpmr$/i),
    tt26: colIdx(h, /^tiktok 2026 cpmr$/i),
    cvrDate: colIdx(h, /^date$/),
    cvr: colIdx(h, /^cvr$/),
  };

  // Second Date / Revenue block is FLO (columns after first Revenue A).
  const dateCols = h.map((x, i) => (/^date$/i.test(x) ? i : -1)).filter(i => i >= 0);
  if (dateCols.length >= 3) {
    cols.floDate = dateCols[2];
    const revFCols = h.map((x, i) => (/revenue \(f\)/i.test(x) ? i : -1)).filter(i => i >= 0);
    const revACols = h.map((x, i) => (/revenue \(a\)/i.test(x) ? i : -1)).filter(i => i >= 0);
    const cpmrCols = h.map((x, i) => (/^meta cpmr$/i.test(x) ? i : -1)).filter(i => i >= 0);
    if (revFCols.length >= 2) cols.floRevF = revFCols[1];
    if (revACols.length >= 2) cols.floRevA = revACols[1];
    if (cpmrCols.length >= 2) cols.floCpmr = cpmrCols[1];
  }

  const noblByDate = {};
  const floByDate = {};
  const floForecastRows = [];

  for (let i = hdr.index + 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const shared = {
      week_start: normalizeDate(c[cols.weekStart]),
      weekly_gross_sales: parseMoney(c[cols.weeklyGross]),
      avg_meta_cpmr: parseMoney(c[cols.avgCpmr]),
      rolling_7d_reach: parseMoney(c[cols.rollReach]) != null ? Math.round(parseMoney(c[cols.rollReach])) : null,
      rolling_7d_cpmr: parseMoney(c[cols.rollCpmr]),
      meta_cpmr_2025: parseMoney(c[cols.meta25]),
      meta_cpmr_2026: parseMoney(c[cols.meta26]),
      tiktok_cpmr_2025: parseMoney(c[cols.tt25]),
      tiktok_cpmr_2026: parseMoney(c[cols.tt26]),
    };

    const noblDate = normalizeDate(c[cols.noblDate]);
    if (noblDate) {
      const revF = parseMoney(c[cols.noblRevF]);
      const revA = parseMoney(c[cols.noblRevA]);
      noblByDate[noblDate] = {
        brand: 'NOBL',
        date: noblDate,
        gross_sales_tw: parseMoney(c[cols.noblGross]),
        meta_cpmr: parseMoney(c[cols.noblCpmr]),
        revenue_forecast: revF,
        revenue_actual: revA,
        cvr_weekly: parsePct(c[cols.cvr]),
        ...shared,
      };
    }

    const floDate = cols.floDate >= 0 ? normalizeDate(c[cols.floDate]) : null;
    if (floDate) {
      const revF = parseMoney(c[cols.floRevF]);
      const revA = parseMoney(c[cols.floRevA]);
      floByDate[floDate] = {
        brand: 'FLO',
        date: floDate,
        meta_cpmr: parseMoney(c[cols.floCpmr]),
        revenue_forecast: revF,
        revenue_actual: revA,
        ...shared,
      };
      if (revF != null && revF > 0) {
        floForecastRows.push({
          brand: 'FLO',
          date: floDate,
          row_type: 'Import',
          forecast_revenue: revF,
          forecast_note: 'Daily revenue forecast from performance dashboard import.',
        });
      }
    }
  }

  return {
    rows: [...Object.values(noblByDate), ...Object.values(floByDate)],
    floForecastRows,
  };
}

async function upsertPerformanceRows(rows) {
  let n = 0;
  for (const r of rows) {
    await pgRun(`
      INSERT INTO brand_performance_daily (
        brand, date, gross_sales_tw, meta_cpmr, revenue_forecast, revenue_actual,
        week_start, weekly_gross_sales, avg_meta_cpmr, rolling_7d_reach, rolling_7d_cpmr,
        meta_cpmr_2025, meta_cpmr_2026, tiktok_cpmr_2025, tiktok_cpmr_2026, cvr_weekly,
        source, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'import',NOW())
      ON CONFLICT (brand, date) DO UPDATE SET
        gross_sales_tw = COALESCE(EXCLUDED.gross_sales_tw, brand_performance_daily.gross_sales_tw),
        meta_cpmr = COALESCE(EXCLUDED.meta_cpmr, brand_performance_daily.meta_cpmr),
        revenue_forecast = COALESCE(EXCLUDED.revenue_forecast, brand_performance_daily.revenue_forecast),
        revenue_actual = COALESCE(EXCLUDED.revenue_actual, brand_performance_daily.revenue_actual),
        week_start = COALESCE(EXCLUDED.week_start, brand_performance_daily.week_start),
        weekly_gross_sales = COALESCE(EXCLUDED.weekly_gross_sales, brand_performance_daily.weekly_gross_sales),
        avg_meta_cpmr = COALESCE(EXCLUDED.avg_meta_cpmr, brand_performance_daily.avg_meta_cpmr),
        rolling_7d_reach = COALESCE(EXCLUDED.rolling_7d_reach, brand_performance_daily.rolling_7d_reach),
        rolling_7d_cpmr = COALESCE(EXCLUDED.rolling_7d_cpmr, brand_performance_daily.rolling_7d_cpmr),
        meta_cpmr_2025 = COALESCE(EXCLUDED.meta_cpmr_2025, brand_performance_daily.meta_cpmr_2025),
        meta_cpmr_2026 = COALESCE(EXCLUDED.meta_cpmr_2026, brand_performance_daily.meta_cpmr_2026),
        tiktok_cpmr_2025 = COALESCE(EXCLUDED.tiktok_cpmr_2025, brand_performance_daily.tiktok_cpmr_2025),
        tiktok_cpmr_2026 = COALESCE(EXCLUDED.tiktok_cpmr_2026, brand_performance_daily.tiktok_cpmr_2026),
        cvr_weekly = COALESCE(EXCLUDED.cvr_weekly, brand_performance_daily.cvr_weekly),
        source = 'import',
        updated_at = NOW()
    `, [
      r.brand, r.date, r.gross_sales_tw, r.meta_cpmr, r.revenue_forecast, r.revenue_actual,
      r.week_start, r.weekly_gross_sales, r.avg_meta_cpmr, r.rolling_7d_reach, r.rolling_7d_cpmr,
      r.meta_cpmr_2025, r.meta_cpmr_2026, r.tiktok_cpmr_2025, r.tiktok_cpmr_2026, r.cvr_weekly,
    ]);
    n++;
  }
  return n;
}

async function importPerformanceDashboard() {
  await ensurePerformanceSchema();
  const url = `https://docs.google.com/spreadsheets/d/${PERFORMANCE_DASHBOARD.spreadsheetId}/export?format=csv&gid=${PERFORMANCE_DASHBOARD.gid}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok || text.trim().startsWith('<!')) {
    throw new Error('Performance dashboard CSV export failed. Share sheet publicly or run import manually.');
  }
  const { rows, floForecastRows } = parsePerformanceCsv(text);
  const count = await upsertPerformanceRows(rows);

  await ensureForecastSchema();
  if (floForecastRows.length) await upsertForecastRows(floForecastRows);

  clearResponseCache('forecast');
  clearResponseCache('performance');
  const range = await pgQuery(
    `SELECT MIN(date)::text AS min_date, MAX(date)::text AS max_date, COUNT(*)::int AS n FROM brand_performance_daily`,
    []
  );
  return { rows: count, flo_forecast_rows: floForecastRows.length, ...range.rows[0] };
}

module.exports = {
  ensurePerformanceSchema,
  importPerformanceDashboard,
  parsePerformanceCsv,
};

if (require.main === module) {
  importPerformanceDashboard()
    .then(r => { console.log('[performanceDashboardImport] OK', r); process.exit(0); })
    .catch(e => { console.error('[performanceDashboardImport] FAILED', e.message); process.exit(1); });
}
