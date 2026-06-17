import React, { useEffect, useState } from 'react';
import {
  isMtdRange,
  mtdEndISO,
  mtdRange,
  todayISO,
  ytdRange,
  yesterdayRange,
} from '../utils/dateRange';

/**
 * DateRangePicker — quick presets + custom date inputs.
 * MTD defaults through yesterday (toggleable); YTD through today.
 */

const MTD_THROUGH_YESTERDAY_KEY = 'nobl:mtdThroughYesterday';

function readMtdThroughYesterdayPref() {
  try {
    const raw = sessionStorage.getItem(MTD_THROUGH_YESTERDAY_KEY);
    if (raw === '0' || raw === 'false') return false;
    if (raw === '1' || raw === 'true') return true;
  } catch {
    /* ignore */
  }
  return true;
}

function writeMtdThroughYesterdayPref(value) {
  try {
    sessionStorage.setItem(MTD_THROUGH_YESTERDAY_KEY, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

const QUICK_BTNS = [
  {
    label: 'Yesterday',
    getRange: () => yesterdayRange(),
    match: (start, end) => {
      const y = yesterdayRange();
      return start === y.start && end === y.end;
    },
  },
  {
    label: 'MTD',
    match: (start, end) => isMtdRange(start, end),
  },
  {
    label: 'YTD',
    getRange: () => ytdRange(),
    match: (start, end) => {
      const y = ytdRange();
      return start === y.start && end === y.end;
    },
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
  const [mtdThroughYesterday, setMtdThroughYesterday] = useState(readMtdThroughYesterdayPref);
  const activeLabel = detectActivePreset(start, end);
  const isSingleDay = start === end && start.length === 10;
  const isMtdActive = activeLabel === 'MTD';

  useEffect(() => {
    if (!isMtdActive) return;
    const todayEnd = todayISO();
    const yesterdayEnd = mtdEndISO(true);
    if (end === todayEnd && end !== yesterdayEnd) setMtdThroughYesterday(false);
    else if (end === yesterdayEnd && end !== todayEnd) setMtdThroughYesterday(true);
  }, [isMtdActive, end]);

  function handleQuick(btn) {
    if (btn.label === 'MTD') {
      onChange(mtdRange({ throughYesterday: mtdThroughYesterday }));
      return;
    }
    onChange(btn.getRange());
  }

  function handleMtdThroughYesterdayChange(e) {
    const next = e.target.checked;
    setMtdThroughYesterday(next);
    writeMtdThroughYesterdayPref(next);
    if (isMtdActive) {
      onChange({ start, end: mtdEndISO(next) });
    }
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
        {isMtdActive && (
          <label className="date-range-picker__mtd-opt">
            <input
              type="checkbox"
              checked={mtdThroughYesterday}
              onChange={handleMtdThroughYesterdayChange}
            />
            Through yesterday
          </label>
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
