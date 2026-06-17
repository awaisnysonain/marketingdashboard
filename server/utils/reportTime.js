/** Reporting timezone — TW/Shopify date keys (America/New_York). */
const REPORT_TZ = process.env.SHOP_TIMEZONE || 'America/New_York';

function reportTodayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ }).format(new Date());
}

function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Yesterday in reporting timezone (YYYY-MM-DD). */
function reportYesterdayStr() {
  return addDaysStr(reportTodayStr(), -1);
}

/** Later of two YYYY-MM-DD strings. */
function maxDateStr(a, b) {
  if (!a) return b || '';
  if (!b) return a || '';
  return a > b ? a : b;
}

/** SQL fragment: row has meaningful TW metrics (not an empty placeholder). */
const SUMMARY_HAS_DATA_SQL = `(COALESCE(total_spend, 0) > 0
              OR COALESCE(order_revenue, total_revenue, 0) > 0
              OR COALESCE(total_orders, 0) > 0)`;

module.exports = {
  REPORT_TZ,
  reportTodayStr,
  reportYesterdayStr,
  addDaysStr,
  maxDateStr,
  SUMMARY_HAS_DATA_SQL,
};
