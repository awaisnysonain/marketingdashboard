/**
 * Quick verification for dateRange MTD/YTD helpers (America/New_York).
 * Run: node client/scripts/testDateRange.js
 *
 * Keep logic aligned with client/src/utils/dateRange.js
 */
const REPORT_TZ = 'America/New_York';

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

function toISO(d = new Date()) {
  const { year, month, day } = datePartsInTz(d);
  return `${year}-${month}-${day}`;
}

function addDaysISO(iso, delta) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function currentMonthStartISO(date) {
  const { year, month } = datePartsInTz(date);
  return `${year}-${month}-01`;
}

function currentYearStartISO(date) {
  const { year } = datePartsInTz(date);
  return `${year}-01-01`;
}

function mtdRange(date) {
  return { start: currentMonthStartISO(date), end: toISO(date) };
}

function ytdRange(date) {
  return { start: currentYearStartISO(date), end: toISO(date) };
}

function mtdStartFor(endISO) {
  if (!endISO) return currentMonthStartISO();
  const [y, m] = endISO.slice(0, 10).split('-');
  return `${y}-${m}-01`;
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
}

// Fixed instant: June 15 2026 18:00 UTC (= 14:00 EDT)
const jun15 = new Date('2026-06-15T18:00:00Z');
const mtd = mtdRange(jun15);
assert(mtd.start === '2026-06-01', `mtdRange start on Jun 15 NY → ${mtd.start}`);
assert(mtd.end === '2026-06-15', `mtdRange end on Jun 15 NY → ${mtd.end}`);
assert(mtd.start !== '2026-05-31', 'mtdRange start must never be May 31 for June MTD');

const ytd = ytdRange(jun15);
assert(ytd.start === '2026-01-01', `ytdRange start → ${ytd.start}`);
assert(ytd.end === '2026-06-15', `ytdRange end → ${ytd.end}`);

assert(mtdStartFor('2026-06-15') === '2026-06-01', 'mtdStartFor string slice');
assert(mtdStartFor('2026-06-01') === '2026-06-01', 'mtdStartFor month boundary');

// Regression: old toISOString-on-local-midnight bug (UTC+ timezones)
function oldBuggyMtdStart(endISO) {
  const toISOOld = (d) => d.toISOString().slice(0, 10);
  const end = endISO ? new Date(endISO + 'T12:00:00') : new Date();
  return toISOOld(new Date(end.getFullYear(), end.getMonth(), 1));
}
assert(
  oldBuggyMtdStart('2026-06-15') === '2026-05-31',
  'old bug reproduces May 31 in positive-offset TZ (sanity check)'
);

// Live "today" check
const live = mtdRange();
assert(/^\d{4}-\d{2}-01$/.test(live.start), `live mtd start is 1st of month → ${live.start}`);
assert(live.start.slice(0, 7) === live.end.slice(0, 7), 'live mtd start/end share month');

console.log('\nAll dateRange checks passed.');
