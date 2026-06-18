/** Shared date-range helpers for dashboard pages */

/** Reporting timezone — matches server ETL date keys (America/New_York). */
export const REPORT_TZ = 'America/New_York';

function datePartsInTz(date = new Date(), timeZone = REPORT_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** YYYY-MM-DD for a calendar day in the reporting timezone. */
export function toISO(d = new Date()) {
  const { year, month, day } = datePartsInTz(d);
  return `${year}-${month}-${day}`;
}

/** Shift a YYYY-MM-DD calendar date by N days (timezone-safe calendar math). */
export function addDaysISO(iso, delta) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

export function todayISO() {
  return toISO(new Date());
}

export function yesterdayISO() {
  return addDaysISO(todayISO(), -1);
}

/** First day of the current calendar month (reporting TZ). */
export function currentMonthStartISO() {
  const { year, month } = datePartsInTz();
  return `${year}-${month}-01`;
}

/** First day of Jan 1 for the current calendar year (reporting TZ). */
export function currentYearStartISO() {
  const { year } = datePartsInTz();
  return `${year}-01-01`;
}

/** First day of the month containing endISO (for custom end-date helpers). */
export function mtdStartFor(endISO) {
  if (!endISO) return currentMonthStartISO();
  const [y, m] = endISO.slice(0, 10).split('-');
  return `${y}-${m}-01`;
}

/** Jan 1 of the year containing endISO (for custom end-date helpers). */
export function ytdStartFor(endISO) {
  if (!endISO) return currentYearStartISO();
  return `${endISO.slice(0, 4)}-01-01`;
}

/** MTD end date for the given mode (clamped to month start on the 1st). */
export function mtdEndISO(throughYesterday = true) {
  const start = currentMonthStartISO();
  if (!throughYesterday) return todayISO();
  const y = yesterdayISO();
  return y < start ? start : y;
}

/** True when range is month-start through today or yesterday (MTD preset shapes). */
export function isMtdRange(start, end) {
  const monthStart = currentMonthStartISO();
  if (start !== monthStart) return false;
  return end === todayISO() || end === mtdEndISO(true);
}

/** Month-to-date: first day of the **current** month through today or yesterday. */
export function mtdRange({ throughYesterday = true } = {}) {
  const start = currentMonthStartISO();
  return { start, end: mtdEndISO(throughYesterday) };
}

/** YTD end date for the given mode (clamped to year start on Jan 1). */
export function ytdEndISO(throughYesterday = true) {
  const start = currentYearStartISO();
  if (!throughYesterday) return todayISO();
  const y = yesterdayISO();
  return y < start ? start : y;
}

/** True when range is year-start through today or yesterday (YTD preset shapes). */
export function isYtdRange(start, end) {
  const yearStart = currentYearStartISO();
  if (start !== yearStart) return false;
  return end === todayISO() || end === ytdEndISO(true);
}

/** Year-to-date: Jan 1 of the **current** year through today or yesterday. */
export function ytdRange({ throughYesterday = true } = {}) {
  return { start: currentYearStartISO(), end: ytdEndISO(throughYesterday) };
}

/**
 * Earliest date the "All" (all-time) preset reaches back to. Set well before any
 * real data — the read endpoints only return rows that actually exist, so an
 * early bound simply means "everything we have".
 */
export const ALL_TIME_START = '2020-01-01';

/** All-time: every past day through today or yesterday. */
export function allTimeRange({ throughYesterday = true } = {}) {
  return { start: ALL_TIME_START, end: throughYesterday ? yesterdayISO() : todayISO() };
}

/** True when range starts at the all-time bound (through today or yesterday). */
export function isAllTimeRange(start, end) {
  return start === ALL_TIME_START && (end === todayISO() || end === yesterdayISO());
}

export function yesterdayRange() {
  const y = yesterdayISO();
  return { start: y, end: y };
}

export function singleDayRange(dateISO) {
  return { start: dateISO, end: dateISO };
}

/** Sort named items by a numeric revenue map (descending). */
export function sortByRevenueDesc(names, revenueMap) {
  return [...names].sort((a, b) => (revenueMap[b] || 0) - (revenueMap[a] || 0));
}
