/**
 * Import NOBL plan calendar into PostgreSQL (not computed forecast output).
 * Runtime forecast/projected values are calculated by noblForecastEngine.js.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { pgRun, pgQuery } = require('../db/postgres');
const { FORECAST_PLAN_SOURCE, NOBL_PLAN_2026, NOBL_MER_TARGETS_2026 } = require('../config/forecastSheetConfig');
const { buildPlanDailyFromMonthly } = require('../forecast/noblForecastEngine');
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
  let s = String(v).trim();
  if (!s || /^#|^error/i.test(s)) return null;
  s = s.replace(/[$,\s]/g, '').replace(/[×x]/gi, '');
  if (/%$/.test(s)) {
    const n = Number(s.replace(/%/g, ''));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseMer(v) {
  const n = parseMoney(v);
  if (n == null) return null;
  // MER targets are ~2–4×; ignore mis-parsed revenue-sized values.
  return n > 0 && n <= 20 ? n : null;
}

function parseDropLiftDollars(v) {
  const n = parseMoney(v);
  if (n == null) return null;
  return n >= 0 && n <= 999999999999 ? n : null;
}

function findPlanDataStartIndex(lines, sheetMonth) {
  const monthPrefix = String(sheetMonth || '').slice(0, 3);
  for (let i = 0; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const label = String(c[0] || '').trim();
    if (monthPrefix && new RegExp(`^${monthPrefix}\\s+\\d{1,2}$`, 'i').test(label)) return i;
    if (/^\d{1,2}$/.test(label)) return i;
  }
  for (let i = 0; i < lines.length; i++) {
    if (String(parseCsvLine(lines[i])[0] || '').trim().toLowerCase() === 'date') return i + 1;
  }
  return 2;
}

function parsePlanDateLabel(label, sheetMonth) {
  const s = String(label || '').trim();
  const m = s.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  const dayOnly = s.match(/^(\d{1,2})$/);
  if (!m && !dayOnly) return null;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = m ? m[1].slice(0, 3) : String(sheetMonth || '').replace(/\s*\+\s*Drops/i, '').slice(0, 3);
  const monthIdx = monthNames.findIndex(x => x.toLowerCase() === monthName.toLowerCase());
  if (monthIdx < 0) return null;
  const day = m ? Number(m[2]) : Number(dayOnly[1]);
  return `2026-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function ensureForecastSchema() {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS forecast_plan_daily (
      brand           TEXT NOT NULL DEFAULT 'NOBL',
      date            DATE NOT NULL,
      plan_revenue    NUMERIC(14,2),
      plan_spend      NUMERIC(14,2),
      plan_meta_spend NUMERIC(14,2),
      plan_mer        NUMERIC(6,3),
      plan_usa        NUMERIC(14,2),
      plan_canada     NUMERIC(14,2),
      plan_australia  NUMERIC(14,2),
      plan_uk         NUMERIC(14,2),
      plan_eu         NUMERIC(14,2),
      promo           TEXT,
      drop_lift       NUMERIC(14,2),
      source          TEXT DEFAULT 'import',
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (brand, date)
    )
  `);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_forecast_plan_daily_brand_date ON forecast_plan_daily (brand, date DESC)`);
  // Migrate drop_lift from ratio-sized column to dollar lift amounts from sheet.
  await pgRun(`
    ALTER TABLE forecast_plan_daily
    ALTER COLUMN drop_lift TYPE NUMERIC(14,2)
  `).catch(() => {});

  // Legacy forecast_daily kept for backward compatibility; plan lives in forecast_plan_daily.
  await pgRun(`
    CREATE TABLE IF NOT EXISTS forecast_daily (
      brand                       TEXT NOT NULL DEFAULT 'NOBL',
      date                        DATE NOT NULL,
      row_type                    TEXT,
      forecast_revenue            NUMERIC(14,2),
      forecast_spend              NUMERIC(14,2),
      forecast_eligible_orders    INT,
      forecast_air_orders         INT,
      forecast_activations        INT,
      forecast_attach_rate        NUMERIC(8,4),
      forecast_activation_rate    NUMERIC(8,4),
      forecast_tag_rev            NUMERIC(14,2),
      forecast_sub_rev            NUMERIC(14,2),
      forecast_air_revenue        NUMERIC(14,2),
      mer_target                  NUMERIC(6,3),
      target_status               TEXT,
      forecast_note               TEXT,
      source                      TEXT DEFAULT 'import',
      updated_at                  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (brand, date)
    )
  `).catch(() => {});
}

async function fetchImportCsv(spreadsheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok || text.trim().startsWith('<!')) {
    throw new Error(`Plan import CSV failed for gid ${gid}. Share sheet publicly or configure gids in .env.`);
  }
  return text;
}

/** Parse May+ Drops style plan tab: col A date, D spend, E meta, F revenue, G MER, H–L regions, N drop lift $. */
function parsePlanDropsCsv(text, sheetMonth) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const start = findPlanDataStartIndex(lines, sheetMonth);
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const label = String(c[0] || '').trim();
    if (!label || label.toUpperCase() === 'TOTAL') break;
    const date = parsePlanDateLabel(label, sheetMonth);
    const planRevenue = parseMoney(c[5]);
    if (!date || planRevenue == null) continue;
    rows.push({
      brand: 'NOBL',
      date,
      plan_revenue: planRevenue,
      plan_spend: parseMoney(c[3]),
      plan_meta_spend: parseMoney(c[4]),
      plan_mer: parseMer(c[6]),
      plan_usa: parseMoney(c[7]),
      plan_canada: parseMoney(c[8]),
      plan_australia: parseMoney(c[9]),
      plan_uk: parseMoney(c[10]),
      plan_eu: parseMoney(c[11]),
      promo: c[2] || null,
      drop_lift: parseDropLiftDollars(c[13]),
      source: `plan_tab:${sheetMonth}`,
    });
  }
  return rows;
}

async function importPlanFromSourceWorkbook() {
  const sourceId = FORECAST_PLAN_SOURCE.spreadsheetId;
  const tabs = FORECAST_PLAN_SOURCE.planTabs || [];
  const all = [];
  for (const tab of tabs) {
    if (!tab.gid) continue;
    try {
      const csv = await fetchImportCsv(sourceId, tab.gid);
      all.push(...parsePlanDropsCsv(csv, tab.name));
    } catch (e) {
      console.warn(`[forecastImport] Plan tab ${tab.name} skipped: ${e.message}`);
    }
  }
  return all;
}

function buildWeightedPlanRows() {
  return buildPlanDailyFromMonthly(NOBL_PLAN_2026, NOBL_MER_TARGETS_2026).map(r => ({
    brand: 'NOBL',
    date: r.date,
    plan_revenue: r.planRevenue,
    plan_spend: r.planSpend,
    plan_meta_spend: r.planMetaSpend,
    plan_mer: r.planMER,
    plan_eu: r.planEU,
    promo: r.promo || null,
    drop_lift: r.dropLift || null,
    source: 'monthly_weights',
  }));
}

async function upsertPlanRows(rows) {
  let n = 0;
  for (const r of rows) {
    try {
      await pgRun(`
        INSERT INTO forecast_plan_daily (
          brand, date, plan_revenue, plan_spend, plan_meta_spend, plan_mer,
          plan_usa, plan_canada, plan_australia, plan_uk, plan_eu,
          promo, drop_lift, source, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
        ON CONFLICT (brand, date) DO UPDATE SET
          plan_revenue = COALESCE(EXCLUDED.plan_revenue, forecast_plan_daily.plan_revenue),
          plan_spend = COALESCE(EXCLUDED.plan_spend, forecast_plan_daily.plan_spend),
          plan_meta_spend = COALESCE(EXCLUDED.plan_meta_spend, forecast_plan_daily.plan_meta_spend),
          plan_mer = COALESCE(EXCLUDED.plan_mer, forecast_plan_daily.plan_mer),
          plan_usa = COALESCE(EXCLUDED.plan_usa, forecast_plan_daily.plan_usa),
          plan_canada = COALESCE(EXCLUDED.plan_canada, forecast_plan_daily.plan_canada),
          plan_australia = COALESCE(EXCLUDED.plan_australia, forecast_plan_daily.plan_australia),
          plan_uk = COALESCE(EXCLUDED.plan_uk, forecast_plan_daily.plan_uk),
          plan_eu = COALESCE(EXCLUDED.plan_eu, forecast_plan_daily.plan_eu),
          promo = COALESCE(EXCLUDED.promo, forecast_plan_daily.promo),
          drop_lift = COALESCE(EXCLUDED.drop_lift, forecast_plan_daily.drop_lift),
          source = EXCLUDED.source,
          updated_at = NOW()
      `, [
        r.brand, r.date, r.plan_revenue, r.plan_spend || null, r.plan_meta_spend || null, r.plan_mer || null,
        r.plan_usa || null, r.plan_canada || null, r.plan_australia || null, r.plan_uk || null, r.plan_eu || null,
        r.promo || null, r.drop_lift || null, r.source || 'import',
      ]);
      n++;
    } catch (e) {
      throw new Error(`${r.date} (${r.source}): ${e.message}`);
    }
  }
  return n;
}

async function upsertForecastRows(rows) {
  let n = 0;
  for (const r of rows) {
    await pgRun(`
      INSERT INTO forecast_daily (
        brand, date, row_type, forecast_revenue, forecast_spend, forecast_eligible_orders,
        forecast_air_orders, forecast_activations, forecast_attach_rate, forecast_activation_rate,
        forecast_tag_rev, forecast_sub_rev, forecast_air_revenue, mer_target, target_status,
        forecast_note, source, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'import',NOW())
      ON CONFLICT (brand, date) DO UPDATE SET
        row_type = EXCLUDED.row_type,
        forecast_revenue = COALESCE(EXCLUDED.forecast_revenue, forecast_daily.forecast_revenue),
        forecast_spend = COALESCE(EXCLUDED.forecast_spend, forecast_daily.forecast_spend),
        forecast_eligible_orders = COALESCE(EXCLUDED.forecast_eligible_orders, forecast_daily.forecast_eligible_orders),
        forecast_air_orders = COALESCE(EXCLUDED.forecast_air_orders, forecast_daily.forecast_air_orders),
        forecast_activations = COALESCE(EXCLUDED.forecast_activations, forecast_daily.forecast_activations),
        forecast_attach_rate = COALESCE(EXCLUDED.forecast_attach_rate, forecast_daily.forecast_attach_rate),
        forecast_activation_rate = COALESCE(EXCLUDED.forecast_activation_rate, forecast_daily.forecast_activation_rate),
        forecast_tag_rev = COALESCE(EXCLUDED.forecast_tag_rev, forecast_daily.forecast_tag_rev),
        forecast_sub_rev = COALESCE(EXCLUDED.forecast_sub_rev, forecast_daily.forecast_sub_rev),
        forecast_air_revenue = COALESCE(EXCLUDED.forecast_air_revenue, forecast_daily.forecast_air_revenue),
        mer_target = COALESCE(EXCLUDED.mer_target, forecast_daily.mer_target),
        target_status = COALESCE(EXCLUDED.target_status, forecast_daily.target_status),
        forecast_note = COALESCE(EXCLUDED.forecast_note, forecast_daily.forecast_note),
        source = 'import',
        updated_at = NOW()
    `, [
      r.brand, r.date, r.row_type || null, r.forecast_revenue, r.forecast_spend || null,
      r.forecast_eligible_orders || null, r.forecast_air_orders || null, r.forecast_activations || null,
      r.forecast_attach_rate || null, r.forecast_activation_rate || null,
      r.forecast_tag_rev || null, r.forecast_sub_rev || null, r.forecast_air_revenue || null,
      r.mer_target || null, r.target_status || null, r.forecast_note || null,
    ]);
    n++;
  }
  return n;
}

/** Import plan calendar only — computed forecast is never imported from sheets. */
async function importForecastDaily() {
  await ensureForecastSchema();
  let sheetRows = [];
  try {
    sheetRows = await importPlanFromSourceWorkbook();
  } catch (e) {
    console.warn('[forecastImport]', e.message);
  }
  const weightedRows = buildWeightedPlanRows();
  const byDate = Object.fromEntries(weightedRows.map(r => [r.date, r]));
  sheetRows.forEach(r => { byDate[r.date] = r; });
  const all = Object.values(byDate);
  const count = await upsertPlanRows(all);
  clearResponseCache('forecast');
  const range = await pgQuery(
    `SELECT MIN(date)::text AS min_date, MAX(date)::text AS max_date, COUNT(*)::int AS n FROM forecast_plan_daily WHERE brand='NOBL'`,
    []
  );
  return { rows: count, brand: 'NOBL', type: 'plan_calendar', ...range.rows[0] };
}

module.exports = {
  ensureForecastSchema,
  importForecastDaily,
  parsePlanDropsCsv,
  buildWeightedPlanRows,
  upsertPlanRows,
  upsertForecastRows,
};

if (require.main === module) {
  importForecastDaily()
    .then(r => { console.log('[forecastImport] OK', r); process.exit(0); })
    .catch(e => { console.error('[forecastImport] FAILED', e.message); process.exit(1); });
}
