import React from 'react';
import { FORECAST_STATUS_STYLE } from '../hooks/useDailyForecast';

function fmt$(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const v = pct * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function Row({ label, value, accent }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, lineHeight: 1.5 }}>
      <span style={{ color: 'var(--text3)' }}>{label}</span>
      <span style={{ fontWeight: 700, color: accent || 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

/**
 * Rich hover card for forecast vs actual cells — forecast $, actual $, variance %, air metrics.
 */
export default function ForecastHoverTooltip({ data, anchorRect, visible }) {
  if (!visible || !data || !anchorRect) return null;
  const st = FORECAST_STATUS_STYLE[data.status] || FORECAST_STATUS_STYLE.model;
  const top = Math.min(anchorRect.bottom + 8, window.innerHeight - 220);
  const left = Math.min(anchorRect.left, window.innerWidth - 300);

  return (
    <div
      style={{
        position: 'fixed', top, left, zIndex: 1200, width: 280,
        background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 12,
        boxShadow: '0 12px 32px rgba(15,23,42,.14)', padding: '12px 14px', pointerEvents: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: st.color }} />
        <span style={{ fontSize: 12, fontWeight: 800, color: st.color }}>{st.label}</span>
        {data.date && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text4)' }}>{data.date}</span>}
      </div>
      <div style={{ fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {data.forecast != null && <Row label="Forecast" value={fmt$(data.forecast)} />}
        {data.actual != null && <Row label="Actual" value={fmt$(data.actual)} />}
        {data.variancePct != null && (
          <Row label="Variance" value={fmtPct(data.variancePct)} accent={st.color} />
        )}
        {data.forecast_air_revenue != null && (
          <Row label="Air forecast" value={fmt$(data.forecast_air_revenue)} />
        )}
        {data.actual_air_revenue != null && (
          <Row label="Air actual" value={fmt$(data.actual_air_revenue)} />
        )}
        {data.forecast_spend != null && <Row label="Spend (fcst)" value={fmt$(data.forecast_spend)} />}
        {data.actual_mer != null && (
          <Row label="MER (actual)" value={`${Number(data.actual_mer).toFixed(2)}x`} />
        )}
        {data.mer_target != null && (
          <Row label="MER target" value={`${Number(data.mer_target).toFixed(2)}x`} />
        )}
        {data.target_status && (
          <Row label="Target status" value={data.target_status} accent={st.color} />
        )}
        {data.meta_cpmr != null && (
          <Row label="Meta CPMR" value={`$${Number(data.meta_cpmr).toFixed(2)}`} />
        )}
      </div>
    </div>
  );
}
