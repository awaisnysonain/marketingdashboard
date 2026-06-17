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

module.exports = { REPORT_TZ, reportTodayStr, reportYesterdayStr, addDaysStr };
