/**
 * Performance dashboard workbook — imported to DB via ETL only.
 * https://docs.google.com/spreadsheets/d/1qPQTdmhx4yudt1h3qlqDpWAIyiBFVII1R6XTB6pfuh4
 */
const PERFORMANCE_DASHBOARD = {
  spreadsheetId: process.env.PERFORMANCE_DASHBOARD_SHEET_ID || '1qPQTdmhx4yudt1h3qlqDpWAIyiBFVII1R6XTB6pfuh4',
  gid: process.env.PERFORMANCE_DASHBOARD_GID || '1601841795',
  tab: 'Copy of Nobl + Flo Performance Dashboard',
};

module.exports = { PERFORMANCE_DASHBOARD };
