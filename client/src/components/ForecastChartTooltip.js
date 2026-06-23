import React from 'react';
import { FORECAST_STATUS_STYLE, dailyVarianceStatus } from '../hooks/useDailyForecast';

function fmt$(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const v = pct * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

const ACTUAL_KEYS = ['order_revenue', 'total_revenue', 'actual', 'nobl_revenue', 'flo_revenue', 'nobl_actual', 'flo_actual'];

/**
 * Recharts tooltip content — shows series values plus forecast / variance when available.
 */
export default function ForecastChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  fc,
  formatter,
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  const date = row.date || label;
  const fcRow = fc?.rowForDate?.(date);
  const forecast = fc?.forecastForDate?.(date) ?? (fcRow ? Number(fcRow.forecast_revenue) : null);
  const actualFromRow = ACTUAL_KEYS.map((k) => row[k]).find((v) => v != null && Number(v) > 0);
  const actual = actualFromRow != null ? Number(actualFromRow) : null;
  const variancePct = actual != null && forecast > 0 ? (actual - forecast) / forecast : null;
  const status = variancePct != null ? dailyVarianceStatus(variancePct) : 'model';
  const st = FORECAST_STATUS_STYLE[status] || FORECAST_STATUS_STYLE.model;
  const fmt = formatter || ((v) => fmt$(v));
  const title = labelFormatter ? labelFormatter(date) : date;

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 10,
      padding: '10px 12px', fontSize: 12, boxShadow: '0 8px 22px rgba(15,23,42,.10)', minWidth: 200,
    }}
    >
      <div style={{ fontWeight: 700, marginBottom: 8, color: 'var(--text)' }}>{title}</div>
      {payload.filter((p) => p.value != null).map((p) => (
        <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 4 }}>
          <span style={{ color: p.color || 'var(--text3)' }}>{p.name}</span>
          <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt(p.value)}</span>
        </div>
      ))}
      {forecast != null && forecast > 0 && (
        <>
          <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 4 }}>
            <span style={{ color: 'var(--text3)' }}>Forecast</span>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt$(forecast)}</span>
          </div>
          {fcRow?.forecast_air_revenue != null && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 4 }}>
              <span style={{ color: 'var(--text3)' }}>Air forecast</span>
              <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmt$(fcRow.forecast_air_revenue)}</span>
            </div>
          )}
          {variancePct != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, color: st.color, fontWeight: 800 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: st.color }} />
              {fmtPct(variancePct)} vs forecast
            </div>
          )}
          {fcRow?.target_status && (
            <div style={{ marginTop: 4, fontSize: 11, color: st.color, fontWeight: 600 }}>{fcRow.target_status}</div>
          )}
        </>
      )}
    </div>
  );
}
