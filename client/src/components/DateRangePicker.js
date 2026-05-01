import React from 'react';

/**
 * DateRangePicker
 * --------------------------------------------------------
 * Quick MTD/YTD buttons + manual custom date inputs.
 */

function toISO(d) { return d.toISOString().slice(0, 10); }
function ytdStart() { return `${new Date().getFullYear()}-01-01`; }
function mtdStart() {
  const d = new Date();
  d.setDate(1);
  return toISO(d);
}

const QUICK_BTNS = [
  { label: 'MTD',   getRange: () => ({ start: mtdStart(),         end: toISO(new Date()) }) },
  { label: 'YTD',   getRange: () => ({ start: ytdStart(),         end: toISO(new Date()) }) },
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
    return r.start === start && (r.end === end || (end === todayISO && r.end === todayISO));
  })?.label;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {/* Quick range buttons */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {QUICK_BTNS.map(btn => {
          const isActive = activeLabel === btn.label;
          return (
            <button
              key={btn.label}
              onClick={() => handleQuick(btn)}
              style={{
                padding: '5px 10px',
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: isActive ? 'var(--accent)' : 'var(--bg2)',
                color: isActive ? '#fff' : 'var(--text2)',
                cursor: 'pointer',
                transition: 'background .15s, color .15s, border-color .15s',
                lineHeight: 1,
                position: 'relative',
              }}
            >
              {btn.label}
            </button>
          );
        })}
      </div>

      {/* Custom date inputs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="date" value={start}
          onChange={handleStartChange}
          style={{
            padding: '5px 8px', fontSize: 12, borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg2)',
            color: 'var(--text)',
            cursor: 'pointer',
            outline: 'none',
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>→</span>
        <input
          type="date" value={end}
          onChange={handleEndChange}
          style={{
            padding: '5px 8px', fontSize: 12, borderRadius: 6,
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
