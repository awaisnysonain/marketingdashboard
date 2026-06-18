import {
  airRegionKeyFromSelection,
  isGeoOnlyRegionSelection,
  normalizeRegions,
} from '../constants/dashboardFilters';

const SUM_INT_FIELDS = [
  'total_orders', 'air_orders', 'zero_air_orders', 'paid_air_orders', 'rebill_orders',
  'same_day_cancels', 'mature_count', 'converted_count', 'cancelled_30d_count',
  'new_49', 'new_79', 'new_89', 'new_99', 'new_109', 'new_119', 'new_129', 'new_139', 'new_149', 'new_159',
  'rebill_49', 'rebill_79', 'rebill_89', 'rebill_99', 'rebill_109', 'rebill_119', 'rebill_129', 'rebill_139', 'rebill_149', 'rebill_159',
];

const SUM_FLOAT_FIELDS = [
  'tag_gross', 'tag_discounts', 'tag_net_sales', 'sub_gross', 'sub_discounts', 'sub_net_sales',
  'rebill_revenue', 'new_sub_revenue', 'combined_gross', 'combined_net_sales',
  'tag_refunds', 'sub_refunds', 'combined_net_revenue',
];

function toNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** Merge base-region daily rows (same logic as ETL combo aggregation). */
export function mergeAirDailyRows(dailyArrays) {
  const byDate = new Map();
  for (const rows of dailyArrays) {
    for (const row of rows || []) {
      const date = String(row.date).slice(0, 10);
      if (!byDate.has(date)) {
        byDate.set(date, { date });
      }
      const acc = byDate.get(date);
      for (const f of SUM_INT_FIELDS) {
        acc[f] = (acc[f] || 0) + (parseInt(row[f], 10) || 0);
      }
      for (const f of SUM_FLOAT_FIELDS) {
        acc[f] = (acc[f] || 0) + toNum(row[f]);
      }
    }
  }
  const daily = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  for (const row of daily) {
    row.attach_rate = row.total_orders > 0
      ? parseFloat((row.air_orders / row.total_orders).toFixed(4))
      : null;
    row.ttp_rate = row.mature_count > 0
      ? parseFloat((row.converted_count / row.mature_count).toFixed(4))
      : null;
    row.activation_rate = (row.attach_rate != null && row.ttp_rate != null)
      ? parseFloat((row.attach_rate * row.ttp_rate).toFixed(4))
      : null;
    row.cancel_rate_30d = row.mature_count > 0
      ? parseFloat((row.cancelled_30d_count / row.mature_count).toFixed(4))
      : null;
  }
  return daily;
}

function ttpFromDaily(daily, start, end) {
  let matureAsOf = 0;
  let convertedAsOf = 0;
  let cancelled30d = 0;
  let matureInPeriod = 0;
  let convertedInPeriod = 0;
  for (const r of daily || []) {
    const d = String(r.date).slice(0, 10);
    matureAsOf += parseInt(r.mature_count, 10) || 0;
    convertedAsOf += parseInt(r.converted_count, 10) || 0;
    cancelled30d += parseInt(r.cancelled_30d_count, 10) || 0;
    if (d >= start && d <= end) {
      matureInPeriod += parseInt(r.mature_count, 10) || 0;
      convertedInPeriod += parseInt(r.converted_count, 10) || 0;
    }
  }
  return {
    mature: matureAsOf,
    converted: convertedAsOf,
    cancelled_30d: cancelled30d,
    ttp_rate: matureAsOf > 0 ? Number((convertedAsOf / matureAsOf).toFixed(4)) : null,
    cancel_rate_30d: matureAsOf > 0 ? Number((cancelled30d / matureAsOf).toFixed(4)) : null,
    paid_conversions_in_period: convertedInPeriod,
    mature_in_period: matureInPeriod,
    ttp_rate_as_of: matureAsOf > 0 ? Number((convertedAsOf / matureAsOf).toFixed(4)) : null,
    ttp_rate_in_period: matureInPeriod > 0
      ? Number((convertedInPeriod / matureInPeriod).toFixed(4))
      : null,
  };
}

function buildTotals(daily) {
  const totals = (daily || []).reduce((acc, r) => ({
    total_orders: (acc.total_orders || 0) + (r.total_orders || 0),
    air_orders: (acc.air_orders || 0) + (r.air_orders || 0),
    zero_air_orders: (acc.zero_air_orders || 0) + (r.zero_air_orders || 0),
    paid_air_orders: (acc.paid_air_orders || 0) + (r.paid_air_orders || 0),
    rebill_orders: (acc.rebill_orders || 0) + (r.rebill_orders || 0),
    same_day_cancels: (acc.same_day_cancels || 0) + (r.same_day_cancels || 0),
    tag_net_sales: (acc.tag_net_sales || 0) + toNum(r.tag_net_sales),
    sub_net_sales: (acc.sub_net_sales || 0) + toNum(r.sub_net_sales),
    rebill_revenue: (acc.rebill_revenue || 0) + toNum(r.rebill_revenue),
    new_sub_revenue: (acc.new_sub_revenue || 0) + toNum(r.new_sub_revenue),
    combined_net_revenue: (acc.combined_net_revenue || 0) + toNum(r.combined_net_revenue),
  }), {});
  totals.attach_rate = totals.total_orders > 0
    ? parseFloat((totals.air_orders / totals.total_orders).toFixed(4))
    : null;
  return totals;
}

function buildAirPerfPayload({
  daily,
  ttpCohort,
  rollingDays = 14,
  forecastDays = 0,
  activeCount = null,
  activeArr = null,
  region = 'ALL',
  dataStart,
  dataEnd,
}) {
  const rowsDesc = [...(daily || [])].reverse();
  const totals = buildTotals(daily);
  totals.ttp_rate = ttpCohort?.ttp_rate ?? null;
  totals.activation_rate = (totals.attach_rate != null && totals.ttp_rate != null)
    ? parseFloat((totals.attach_rate * totals.ttp_rate).toFixed(4))
    : null;

  return {
    rows: rowsDesc,
    totals,
    forecast: [],
    revenue_forecast: null,
    rolling_days: rollingDays,
    forecast_days: forecastDays,
    ttp_cohort: ttpCohort || {},
    active_count: activeCount,
    active_arr: activeArr,
    region,
    data_start: dataStart,
    data_end: dataEnd,
  };
}

/**
 * Resolve air-performance shape from a bundle (fetched once per date range).
 * @param {object} bundle — from GET /nobl/air-performance-bundle
 * @param {string|string[]} regionSelection — regionsParam or regions array
 */
export function resolveAirPerfFromBundle(bundle, regionSelection, rollingDays = 14, forecastDays = 0) {
  if (!bundle) return null;

  const regionKey = airRegionKeyFromSelection(regionSelection);
  const regionLabel = Array.isArray(regionSelection)
    ? (normalizeRegions(regionSelection).join(',') || 'ALL')
    : String(regionSelection || 'ALL');

  if (!regionKey) {
    if (isGeoOnlyRegionSelection(regionSelection)) {
      return buildAirPerfPayload({
        daily: [],
        ttpCohort: { ttp_rate: null },
        rollingDays,
        forecastDays,
        activeCount: null,
        activeArr: null,
        region: regionLabel,
        dataStart: bundle.data_start,
        dataEnd: bundle.data_end,
      });
    }
    return buildAirPerfPayload({
      daily: bundle.global?.daily || [],
      ttpCohort: bundle.global?.ttp_cohort,
      rollingDays,
      forecastDays,
      activeCount: bundle.active_count ?? null,
      activeArr: bundle.active_arr ?? null,
      region: 'ALL',
      dataStart: bundle.data_start,
      dataEnd: bundle.data_end,
    });
  }

  const parts = regionKey.split('_');
  const partDailies = parts.map((p) => bundle.regions?.[p]?.daily || []);
  const daily = mergeAirDailyRows(partDailies);
  const ttpCohort = ttpFromDaily(daily, bundle.data_start, bundle.data_end);

  return buildAirPerfPayload({
    daily,
    ttpCohort,
    rollingDays,
    forecastDays,
    activeCount: null,
    activeArr: null,
    region: regionLabel,
    dataStart: bundle.data_start,
    dataEnd: bundle.data_end,
  });
}
