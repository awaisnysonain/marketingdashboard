/** Pakistan Standard Time (UTC+5) — used for daily cron schedule and date windows. */
const CRON_TZ = 'Asia/Karachi';

function pakistanTodayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CRON_TZ }).format(new Date());
}

function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Yesterday in Pakistan time (YYYY-MM-DD). */
function pakistanYesterdayStr() {
  return addDaysStr(pakistanTodayStr(), -1);
}

module.exports = { CRON_TZ, pakistanTodayStr, pakistanYesterdayStr, addDaysStr };
