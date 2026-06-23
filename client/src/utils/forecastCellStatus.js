import { fmtFull$ } from '../utils/api';
import { dailyVarianceStatus } from '../hooks/useDailyForecast';

/**
 * cellStatus builder for ANY metric on a daily table — date, key, value, row
 * are passed in; we look up the forecast row for the date and produce
 * { status, variancePct, forecast, actual, ... } when the key is one of the
 * configured metric columns. Returns null otherwise (cell renders normally).
 *
 * options.metrics: { [columnHeader]: 'revenue' | 'spend' | 'air_revenue' }
 * options.invertSpend: when true, higher-than-forecast spend reads as bad (red).
 */
export function buildForecastCellStatus(fc, options = {}) {
  const metrics = options.metrics || { 'order_revenue': 'revenue' };
  const invertSpend = options.invertSpend !== false;

  return (date, key, value, row) => {
    const kind = metrics[key];
    if (!kind) return null;
    const row0 = fc.rowForDate?.(date);
    if (!row0) return null;
    const actual = Number(value);
    if (!Number.isFinite(actual)) return null;

    let forecast = null;
    if (kind === 'revenue') forecast = Number(row0.forecast_revenue);
    else if (kind === 'spend') forecast = Number(row0.forecast_spend);
    else if (kind === 'air_revenue') forecast = Number(row0.forecast_air_revenue);

    if (!(forecast > 0)) return null;
    // Hide the pill when the comparison is meaningless — i.e. the server echoed
    // actual as the forecast (common for past-day spend where no plan_spend exists).
    if (Math.abs(actual - forecast) < 0.005) return null;

    const variancePct = (actual - forecast) / forecast;
    let status = dailyVarianceStatus(variancePct);
    // Spend going UP versus forecast is the bad direction — invert the colour.
    if (kind === 'spend' && invertSpend) {
      if (status === 'green' && variancePct > 0.05) status = 'red';
      else if (status === 'green') status = 'green';
      else if (status === 'amber' && variancePct > 0.05) status = 'red';
      else if (status === 'red' && variancePct < 0) status = 'green';
    }

    return {
      status,
      variancePct,
      forecast,
      actual,
      forecast_air_revenue: row0.forecast_air_revenue != null ? Number(row0.forecast_air_revenue) : null,
      actual_air_revenue: row0.actual_air_revenue != null ? Number(row0.actual_air_revenue) : null,
      forecast_spend: row0.forecast_spend != null ? Number(row0.forecast_spend) : null,
      actual_mer: row0.actual_mer,
      mer_target: row0.mer_target,
      target_status: row0.target_status,
      title: `Forecast ${fmtFull$(forecast)} · ${variancePct >= 0 ? '+' : ''}${(variancePct * 100).toFixed(1)}% vs forecast`,
    };
  };
}

/** Existing helper kept for backward compat — order-revenue specific. */
export function buildOrderRevenueCellStatus(fc, metricKey = 'order_revenue') {
  return buildForecastCellStatus(fc, { metrics: { [metricKey]: 'revenue' } });
}
