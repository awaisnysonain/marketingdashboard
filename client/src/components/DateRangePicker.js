import React from 'react';

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

function ytdStart() {
  return `${new Date().getFullYear()}-01-01`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toISO(d);
}

const QUICK_BTNS = [
  { label: '7D', getRange: () => ({ start: daysAgo(7), end: toISO(new Date()) }) },
  { label: '30D', getRange: () => ({ start: daysAgo(30), end: toISO(new Date()) }) },
  { label: '90D', getRange: () => ({ start: daysAgo(90), end: toISO(new Date()) }) },
  { label: 'YTD', getRange: () => ({ start: ytdStart(), end: toISO(new Date()) }) },
  { label: '2025', getRange: () => ({ start: '2025-01-01', end: '2025-12-31' }) },
  { label: '2026', getRange: () => ({ start: '2026-01-01', end: toISO(new Date()) }) },
];

export default function DateRangePicker({ start, end, onChange }) {
  function handleQuick(btn) {
    onChange(btn.getRange());
  }

  function handleStartChange(e) {
    onChange({ start: e.target.value, end });
  }

  function handleEndChange(e) {
    onChange({ start, end: e.target.value });
  }

  // Determine active quick button
  const todayISO = toISO(new Date());
  const activeLabel = QUICK_BTNS.find(b => {
    const r = b.getRange();
    return r.start === start && (r.end === end || (b.label !== '2025' && end === todayISO && r.end === todayISO));
  })?.label;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {QUICK_BTNS.map(btn => (
          <button
            key={btn.label}
            onClick={() => handleQuick(btn)}
            style={{
              padding: '5px 10px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: activeLabel === btn.label ? 'var(--accent)' : 'var(--bg2)',
              color: activeLabel === btn.label ? '#fff' : 'var(--text2)',
              cursor: 'pointer',
              transition: 'background .15s, color .15s',
              lineHeight: 1,
            }}
          >
            {btn.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="date"
          value={start}
          onChange={handleStartChange}
          style={{
            padding: '5px 8px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg2)',
            color: 'var(--text)',
            cursor: 'pointer',
            outline: 'none',
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>→</span>
        <input
          type="date"
          value={end}
          onChange={handleEndChange}
          style={{
            padding: '5px 8px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg2)',
            color: 'var(--text)',
            cursor: 'pointer',
            outline: 'none',
          }}
        />
      </div>
    </div>
  );
}
