import React from 'react';
import { FORECAST_STATUS_STYLE, dailyVarianceStatus } from '../hooks/useDailyForecast';

export function forecastColor(status) {
  return (FORECAST_STATUS_STYLE[status] || FORECAST_STATUS_STYLE.model).color;
}

function fmtPctSigned(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const v = pct * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** Small colored dot for inline red/green forecast signalling. */
export function ForecastDot({ status, title }) {
  if (!status || status === 'model') return null;
  const st = FORECAST_STATUS_STYLE[status] || FORECAST_STATUS_STYLE.model;
  return (
    <span
      title={title || st.label}
      style={{
        display: 'inline-block', width: 7, height: 7, borderRadius: 999,
        background: st.color, flex: '0 0 auto', verticalAlign: 'middle',
      }}
    />
  );
}

/** Pill showing signed variance vs forecast with red/green styling. */
export function ForecastVariancePill({ pct, statusOverride }) {
  const status = statusOverride || dailyVarianceStatus(pct);
  const st = FORECAST_STATUS_STYLE[status] || FORECAST_STATUS_STYLE.model;
  return (
    <span
      title={st.label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999,
        fontWeight: 800, fontSize: 11.5, color: st.color, background: `${st.color}1a`,
        border: `1px solid ${st.color}33`, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: st.color }} />
      {fmtPctSigned(pct)}
    </span>
  );
}

/**
 * Compact "vs forecast" summary strip for a period: compares an actual total
 * against the summed daily forecast for the same window.
 */
export function ForecastVsBadge({ actual, forecast, label = 'vs forecast' }) {
  if (actual == null || !(Number(forecast) > 0)) return null;
  const pct = (Number(actual) - Number(forecast)) / Number(forecast);
  const status = dailyVarianceStatus(pct);
  const st = FORECAST_STATUS_STYLE[status] || FORECAST_STATUS_STYLE.model;
  return (
    <span
      title={`${st.label} · forecast ${forecast.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700,
        color: st.color, background: `${st.color}14`, border: `1px solid ${st.color}33`,
        borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: st.color }} />
      {fmtPctSigned(pct)} {label}
    </span>
  );
}
