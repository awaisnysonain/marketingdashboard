import React from 'react';
import { toISO, mtdStartFor, ytdStartFor, yesterdayISO } from '../utils/dateRange';

/**
 * DateRangePicker — quick presets + custom date inputs.
 * MTD/YTD use start of month/year through the selected end date.
 */

const QUICK_BTNS = [
  {
    label: 'Yesterday',
    getRange: () => {
      const y = yesterdayISO();
      return { start: y, end: y };
    },
    match: (start, end) => {
      const y = yesterdayISO();
      return start === y && end === y;
    },
  },
  {
    label: 'MTD',
    getRange: (end) => ({ start: mtdStartFor(end), end: end || toISO(new Date()) }),
    match: (start, end) => start === mtdStartFor(end) && end.length === 10,
  },
  {
    label: 'YTD',
    getRange: (end) => ({ start: ytdStartFor(end), end: end || toISO(new Date()) }),
    match: (start, end) => start === ytdStartFor(end) && end.length === 10,
  },
];

function detectActivePreset(start, end) {
  for (const btn of QUICK_BTNS) {
    if (btn.match(start, end)) return btn.label;
  }
  if (start === end && start.length === 10) return 'Single day';
  return null;
}

export default function DateRangePicker({ start, end, onChange }) {
  const activeLabel = detectActivePreset(start, end);
  const isSingleDay = start === end && start.length === 10;

  function handleQuick(btn) {
    onChange(btn.getRange(end));
  }

  function handleStartChange(e) {
    const newStart = e.target.value;
    onChange({ start: newStart, end: newStart > end ? newStart : end });
  }

  function handleEndChange(e) {
    onChange({ start, end: e.target.value });
  }

  return (
    <div className="date-range-picker">
      <div className="date-range-picker__presets">
        {QUICK_BTNS.map(btn => {
          const isActive = activeLabel === btn.label;
          return (
            <button
              type="button"
              key={btn.label}
              onClick={() => handleQuick(btn)}
              className={`date-range-picker__btn${isActive ? ' date-range-picker__btn--active' : ''}`}
            >
              {btn.label}
            </button>
          );
        })}
        {isSingleDay && !QUICK_BTNS.some(b => b.label === activeLabel) && (
          <span className="date-range-picker__hint">Single day</span>
        )}
      </div>

      <div className="date-range-picker__inputs">
        <input
          type="date"
          value={start}
          onChange={handleStartChange}
          className="date-range-picker__input"
          aria-label="Start date"
        />
        <span className="date-range-picker__sep">→</span>
        <input
          type="date"
          value={end}
          onChange={handleEndChange}
          className="date-range-picker__input"
          aria-label="End date"
        />
      </div>
    </div>
  );
}
