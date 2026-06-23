import { useEffect, useMemo, useRef, useState } from 'react';
import { getForecastDaily } from '../utils/api';

/** Directional variance status: hit/beat forecast = green, miss = amber/red. */
export function dailyVarianceStatus(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'model';
  if (pct >= -0.05) return 'green';
  if (pct >= -0.15) return 'amber';
  return 'red';
}

export const FORECAST_STATUS_STYLE = {
  green: { color: 'var(--success)', label: 'Hit / beat forecast' },
  amber: { color: 'var(--warn)', label: 'Slightly behind forecast' },
  red: { color: 'var(--danger)', label: 'Behind forecast' },
  model: { color: 'var(--text3)', label: 'No forecast comparison' },
};

/**
 * Loads the per-day forecast for a brand/date range and exposes helpers to
 * compare an actual revenue value for a given date against that day's forecast.
 *
 * brand: 'NOBL' | 'FLO' | 'ALL'
 */
export default function useDailyForecast(brand, start, end) {
  const [byDate, setByDate] = useState({});
  const [meta, setMeta] = useState({ loading: true, error: null, asOf: null });
  const lastKey = useRef(null);

  useEffect(() => {
    if (!brand || !start || !end) return undefined;
    const key = `${brand}:${start}:${end}`;
    if (lastKey.current === key) return undefined;
    lastKey.current = key;
    let alive = true;
    setMeta((m) => ({ ...m, loading: true, error: null }));
    getForecastDaily(brand, start, end)
      .then((d) => {
        if (!alive) return;
        const series = brand === 'ALL'
          ? (d?.combined || [])
          : (d?.brands?.find((b) => b.brand === brand)?.daily || d?.brands?.[0]?.daily || []);
        const map = {};
        for (const r of series) map[r.date] = r;
        setByDate(map);
        setMeta({ loading: false, error: null, asOf: d?.as_of || null });
      })
      .catch((e) => {
        if (!alive) return;
        setByDate({});
        setMeta({ loading: false, error: e.message || String(e), asOf: null });
      });
    return () => { alive = false; };
  }, [brand, start, end]);

  return useMemo(() => ({
    byDate,
    loading: meta.loading,
    error: meta.error,
    asOf: meta.asOf,
    /** Forecast revenue for a date, or null. */
    forecastForDate(date) {
      const r = byDate[date];
      return r ? Number(r.forecast_revenue) : null;
    },
    /** Full forecast row for a date (revenue, air, spend, status, etc.). */
    rowForDate(date) {
      return byDate[date] || null;
    },
    /** Status + variance comparing an actual revenue to that day's forecast. */
    statusForRevenue(date, actualRevenue) {
      const r = byDate[date];
      if (!r || actualRevenue == null || !(Number(r.forecast_revenue) > 0)) {
        return {
          status: 'model', variancePct: null, forecast: r ? Number(r.forecast_revenue) : null,
          actual: actualRevenue != null ? Number(actualRevenue) : null,
          forecast_air_revenue: r?.forecast_air_revenue != null ? Number(r.forecast_air_revenue) : null,
          forecast_spend: r?.forecast_spend != null ? Number(r.forecast_spend) : null,
          actual_mer: r?.actual_mer, mer_target: r?.mer_target, target_status: r?.target_status,
        };
      }
      const fc = Number(r.forecast_revenue);
      const actual = Number(actualRevenue);
      const variancePct = (actual - fc) / fc;
      return {
        status: dailyVarianceStatus(variancePct),
        variancePct,
        forecast: fc,
        actual,
        forecast_air_revenue: r.forecast_air_revenue != null ? Number(r.forecast_air_revenue) : null,
        forecast_spend: r.forecast_spend != null ? Number(r.forecast_spend) : null,
        actual_mer: r.actual_mer,
        mer_target: r.mer_target,
        target_status: r.target_status,
      };
    },
  }), [byDate, meta]);
}
