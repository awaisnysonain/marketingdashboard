import React from 'react';

function fmtV(value, prefix, suffix) {
  if (value === null || value === undefined || value === '') return '—';
  const s = typeof value === 'number'
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : String(value);
  return `${prefix || ''}${s}${suffix || ''}`;
}

export default function KpiCard({ label, value, subValue, sub, trend, trendLabel, prefix, suffix, size = 'md', onClick }) {
  const fs = size === 'lg' ? 24 : size === 'sm' ? 16 : 20;
  const trendNum = parseFloat(trend);
  const isPos = !isNaN(trendNum) && trendNum > 0;
  const isNeg = !isNaN(trendNum) && trendNum < 0;

  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--card-bg)',
        border: '1px solid var(--card-border)',
        borderRadius: 'var(--radius-lg)',
        padding: size === 'sm' ? '11px 14px' : '15px 18px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color .15s',
      }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.borderColor = 'var(--border3)'; }}
      onMouseLeave={e => { if (onClick) e.currentTarget.style.borderColor = 'var(--card-border)'; }}
    >
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text3)', letterSpacing: '.2px', marginBottom: 7 }}>
        {label}
      </div>
      <div style={{
        fontSize: fs, fontWeight: 600, lineHeight: 1.15,
        color: 'var(--text)', fontVariantNumeric: 'tabular-nums',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {fmtV(value, prefix, suffix)}
      </div>
      {(subValue || sub) && (
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 5, fontFamily: 'var(--font-mono)' }}>
          {subValue || sub}
        </div>
      )}
      {trend !== undefined && !isNaN(trendNum) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 3, marginTop: 7,
          fontSize: 11, fontWeight: 500,
          color: isPos ? 'var(--success)' : isNeg ? 'var(--danger)' : 'var(--text3)',
        }}>
          <span style={{ fontSize: 8 }}>{isPos ? '▲' : isNeg ? '▼' : '—'}</span>
          <span>{Math.abs(trendNum).toFixed(1)}%</span>
          {trendLabel && <span style={{ color: 'var(--text3)', fontWeight: 400 }}>{trendLabel}</span>}
        </div>
      )}
    </div>
  );
}
