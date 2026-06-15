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

/** Month-to-date: first day of the **current** month through today. */
export function mtdRange() {
  return { start: currentMonthStartISO(), end: todayISO() };
}

/** Year-to-date: Jan 1 of the **current** year through today. */
export function ytdRange() {
  return { start: currentYearStartISO(), end: todayISO() };
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
