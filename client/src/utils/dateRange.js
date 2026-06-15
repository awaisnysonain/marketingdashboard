/** Shared date-range helpers for dashboard pages */

export function toISO(d) {
  return d.toISOString().slice(0, 10);
}

export function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toISO(d);
}

export function mtdStartFor(endISO) {
  const end = endISO ? new Date(endISO + 'T12:00:00') : new Date();
  return toISO(new Date(end.getFullYear(), end.getMonth(), 1));
}

export function ytdStartFor(endISO) {
  const end = endISO ? new Date(endISO + 'T12:00:00') : new Date();
  return `${end.getFullYear()}-01-01`;
}

export function mtdRange(endISO) {
  const end = endISO || toISO(new Date());
  return { start: mtdStartFor(end), end };
}

export function ytdRange(endISO) {
  const end = endISO || toISO(new Date());
  return { start: ytdStartFor(end), end };
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
