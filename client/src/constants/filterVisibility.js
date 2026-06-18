/**
 * Per-route visibility for the global Brand / Region / Channel / Date filters.
 *
 * Each routed page only *consumes* the filters that are meaningful for its data
 * (verified against each page's useDashboardFilters() usage). Showing a filter a
 * page ignores is confusing, so the GlobalFilterBar renders only the applicable
 * controls per route — and hides itself entirely when none apply.
 *
 *   brand   — page can show more than one brand (NOBL / FLO / FLO EU)
 *   region  — page has geo/region breakdowns
 *   channel — page has paid-channel (Meta / Google / …) breakdowns
 *   date    — page honors the global date range (vs. its own date control)
 */

const HIDDEN = { brand: false, region: false, channel: false, date: false };

const RULES = [
  // path matcher (prefix) → which filters apply
  [(p) => p === '/' || p.startsWith('/overview'),        { brand: true,  region: true,  channel: false, date: true }],
  [(p) => p.startsWith('/channels'),                     { brand: true,  region: false, channel: true,  date: true }],
  [(p) => p.startsWith('/meta-ads'),                     { brand: true,  region: false, channel: false, date: true }],
  [(p) => p.startsWith('/subscriptions'),                { brand: true,  region: false, channel: false, date: true }],
  // Live has its own "latest / pick a date" control, so the global date range is hidden there.
  [(p) => p.startsWith('/live'),                         { brand: true,  region: true,  channel: true,  date: false }],
  [(p) => p.startsWith('/nobl-topline'),                 { brand: false, region: true,  channel: true,  date: true }],
  [(p) => p.startsWith('/nobl-channel-daily'),           { brand: false, region: false, channel: true,  date: true }],
  [(p) => p.startsWith('/flo-topline'),                  { brand: false, region: true,  channel: true,  date: true }],
  [(p) => p.startsWith('/flo-channel-daily'),            { brand: false, region: false, channel: true,  date: true }],
  [(p) => p.startsWith('/nobl-air-performance'),         { brand: false, region: true,  channel: false, date: true }],
  [(p) => p.startsWith('/store/nobl'),                   { brand: false, region: true,  channel: true,  date: true }],
  [(p) => p.startsWith('/store/flo'),                    { brand: false, region: true,  channel: true,  date: true }],
  // Forecast Engine, AI Builder, Sync, App pages, and custom dashboards/sheets
  // have their own controls (or none) → no global filters.
];

/** Returns { brand, region, channel, date } booleans for the given pathname. */
export function filtersForPath(pathname = '') {
  const p = pathname || '/';
  const hit = RULES.find(([test]) => test(p));
  return hit ? hit[1] : HIDDEN;
}

/** True when at least one global filter applies to the route. */
export function anyFilterVisible(pathname) {
  const f = filtersForPath(pathname);
  return f.brand || f.region || f.channel || f.date;
}
