import React from 'react';

function fmtV(value, prefix, suffix) {
  if (value === null || value === undefined || value === '') return '—';
  const s = typeof value === 'number'
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : String(value);
  return `${prefix || ''}${s}${suffix || ''}`;
}

export default function KpiCard({ label, value, fullValue, subValue, sub, trend, trendLabel, prefix, suffix, size = 'md', onClick, tooltip }) {
  const fs = size === 'lg' ? 24 : size === 'sm' ? 16 : 20;
  const trendNum = parseFloat(trend);
  const isPos = !isNaN(trendNum) && trendNum > 0;
  const isNeg = !isNaN(trendNum) && trendNum < 0;
  const [showTip, setShowTip] = React.useState(false);

  return (
    <div
      onClick={onClick}
      title={tooltip || undefined}
      style={{
        background: 'var(--card-bg)',
        border: '1px solid var(--card-border)',
        borderRadius: 'var(--radius-lg)',
        padding: size === 'sm' ? '11px 14px' : '15px 18px',
        cursor: onClick ? 'pointer' : tooltip ? 'help' : 'default',
        transition: 'border-color .15s',
        position: 'relative',
      }}
      onMouseEnter={e => { if (onClick || tooltip) e.currentTarget.style.borderColor = 'var(--border3)'; if (tooltip) setShowTip(true); }}
      onMouseLeave={e => { if (onClick || tooltip) e.currentTarget.style.borderColor = 'var(--card-border)'; if (tooltip) setShowTip(false); }}
      onFocus={tooltip ? () => setShowTip(true) : undefined}
      onBlur={tooltip ? () => setShowTip(false) : undefined}
      tabIndex={tooltip ? 0 : undefined}
    >
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text3)', letterSpacing: '.2px', marginBottom: 7 }}>
        {label}
      </div>
      <div
        title={fullValue || undefined}
        style={{
          fontSize: fs, fontWeight: 600, lineHeight: 1.15,
          color: 'var(--text)', fontVariantNumeric: 'tabular-nums',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
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
      {tooltip && showTip && (
        <div style={{
          position: 'absolute',
          left: 12,
          top: 'calc(100% + 8px)',
          zIndex: 1000,
          width: 300,
          maxWidth: 'min(300px, calc(100vw - 32px))',
          padding: '10px 12px',
          borderRadius: 10,
          background: 'var(--bg2)',
          border: '1px solid var(--border2)',
          boxShadow: 'var(--shadow)',
          color: 'var(--text2)',
          fontSize: 11,
          lineHeight: 1.45,
          whiteSpace: 'pre-line',
          pointerEvents: 'none',
        }}>
          {tooltip}
        </div>
      )}
    </div>
  );
}
