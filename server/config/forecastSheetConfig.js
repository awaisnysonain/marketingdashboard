/**
 * NOBL forecast configuration + monthly plan/MER.
 * Plan calendar may be imported via ETL into forecast_plan_daily.
 * Forecast/projected values are computed at runtime by noblForecastEngine.js.
 *
 * Source-of-truth plan workbook (May+ Drops tabs):
 * https://docs.google.com/spreadsheets/d/1EaXjXyKcNE8Zbrrzy9niC1NFWDGiZNqhD4_Ip-dGjsI
 */

const FORECAST_PLAN_SOURCE = {
  spreadsheetId: process.env.NOBL_FORECAST_SOURCE_SPREADSHEET_ID || '1EaXjXyKcNE8Zbrrzy9niC1NFWDGiZNqhD4_Ip-dGjsI',
  /** Set gids via env when source workbook is publicly readable (FORECAST_PLAN_MAY_GID, etc.) */
  planTabs: [
    { name: 'May', gid: process.env.FORECAST_PLAN_MAY_GID || '' },
    { name: 'Jun', gid: process.env.FORECAST_PLAN_JUN_GID || '' },
    { name: 'Jul', gid: process.env.FORECAST_PLAN_JUL_GID || '' },
    { name: 'Aug', gid: process.env.FORECAST_PLAN_AUG_GID || '' },
    { name: 'Sep', gid: process.env.FORECAST_PLAN_SEP_GID || '' },
    { name: 'Oct', gid: process.env.FORECAST_PLAN_OCT_GID || '' },
    { name: 'Nov', gid: process.env.FORECAST_PLAN_NOV_GID || '' },
    { name: 'Dec', gid: process.env.FORECAST_PLAN_DEC_GID || '' },
  ].map(t => ({ ...t, gid: String(t.gid || '').trim() })).filter(t => t.gid),
};

/** @deprecated Legacy sheet used only if plan gids are not configured */
const FORECAST_SHEET = {
  spreadsheetId: process.env.FORECAST_SHEET_ID || '1XaMLQ_tqJYC7kOPm2Av4-CtZaX5Q1LBb6XYqBrSuIP4',
  airDailyGid: process.env.FORECAST_AIR_DAILY_GID || '1219449413',
  airDailyTab: 'Nobl Air Forecast Daily',
};

/** Monthly revenue plan (2026) from the NOBL forecast workbook Summary tab. */
const NOBL_PLAN_2026 = {
  '2026-01': 18940000,
  '2026-02': 18900000,
  '2026-03': 22100000,
  '2026-04': 18960000,
  '2026-05': 22985801,
  '2026-06': 28388853,
  '2026-07': 38275302,
  '2026-08': 36554315,
  '2026-09': 29624311,
  '2026-10': 23369709,
  '2026-11': 83874341,
  '2026-12': 80833907,
};

const NOBL_MER_TARGETS_2026 = {
  '2026-01': 2.82,
  '2026-02': 2.80,
  '2026-03': 2.79,
  '2026-04': 3.00,
  '2026-05': 3.30,
  '2026-06': 3.25,
  '2026-07': 3.20,
  '2026-08': 3.30,
  '2026-09': 3.20,
  '2026-10': 3.10,
  '2026-11': 2.85,
  '2026-12': 3.00,
};

module.exports = {
  FORECAST_PLAN_SOURCE,
  FORECAST_SHEET,
  NOBL_PLAN_2026,
  NOBL_MER_TARGETS_2026,
};
