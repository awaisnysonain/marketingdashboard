import React, { useEffect, useState } from 'react';
import {
  isMtdRange,
  isYtdRange,
  mtdEndISO,
  mtdRange,
  todayISO,
  yesterdayISO,
  ytdEndISO,
  ytdRange,
  yesterdayRange,
  ALL_TIME_START,
} from '../utils/dateRange';
import { getDataBounds } from '../utils/api';

/**
 * DateRangePicker — quick presets + custom date inputs + readable range label.
 * "Through yesterday" controls whether MTD / YTD / All / custom ranges end
 * yesterday (complete data) or today (partial). "All" reaches back to the real
 * earliest date that has data.
 */

const THROUGH_YESTERDAY_KEY = 'nobl:throughYesterday';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function readThroughYesterdayPref() {
  try {
    const raw = sessionStorage.getItem(THROUGH_YESTERDAY_KEY)
      ?? sessionStorage.getItem('nobl:mtdThroughYesterday');
    if (raw === '0' || raw === 'false') return false;
    if (raw === '1' || raw === 'true') return true;
  } catch { /* ignore */ }
  return true;
}

function writeThroughYesterdayPref(value) {
  try { sessionStorage.setItem(THROUGH_YESTERDAY_KEY, value ? '1' : '0'); } catch { /* ignore */ }
}

function niceDate(iso, withYear = true) {
  if (!iso || iso.length < 10) return iso || '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${MONTHS[parseInt(m, 10) - 1]} ${parseInt(d, 10)}${withYear ? `, ${y}` : ''}`;
}

const PRESETS = [
  { label: 'Yesterday', getRange: () => yesterdayRange(), match: (s, e) => { const y = yesterdayRange(); return s === y.start && e === y.end; } },
  { label: 'MTD', getRange: (ty) => mtdRange({ throughYesterday: ty }), match: (s, e) => isMtdRange(s, e) },
  { label: 'YTD', getRange: (ty) => ytdRange({ throughYesterday: ty }), match: (s, e) => isYtdRange(s, e) },
];

export default function DateRangePicker({ start, end, onChange }) {
  const [throughYesterday, setThroughYesterday] = useState(readThroughYesterdayPref);
  const [earliest, setEarliest] = useState(ALL_TIME_START);

  useEffect(() => {
    let alive = true;
    getDataBounds().then((b) => { if (alive && b?.earliest) setEarliest(b.earliest.slice(0, 10)); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const isAll = start === earliest && (end === todayISO() || end === yesterdayISO());
  let activeLabel = PRESETS.find(p => p.match(start, end))?.label || null;
  if (!activeLabel && isAll) activeLabel = 'All';
  const isSingleDay = start === end && start.length === 10;
  if (!activeLabel && isSingleDay) activeLabel = 'Single day';

  useEffect(() => {
    if (!['MTD', 'YTD', 'All'].includes(activeLabel)) return;
    if (end === todayISO()) setThroughYesterday(false);
    else if (end === yesterdayISO() || end === mtdEndISO(true) || end === ytdEndISO(true)) setThroughYesterday(true);
  }, [activeLabel, end]);

  function handlePreset(p) { onChange(p.getRange(throughYesterday)); }
  function handleAll() { onChange({ start: earliest, end: throughYesterday ? yesterdayISO() : todayISO() }); }

  function handleThroughYesterdayChange(e) {
    const next = e.target.checked;
    setThroughYesterday(next);
    writeThroughYesterdayPref(next);
    if (activeLabel === 'MTD') onChange({ start, end: mtdEndISO(next) });
    else if (activeLabel === 'YTD') onChange({ start, end: ytdEndISO(next) });
    else {
      const snapEnd = next ? yesterdayISO() : todayISO();
      onChange({ start: start > snapEnd ? snapEnd : start, end: snapEnd });
    }
  }

  function handleStartChange(e) {
    const newStart = e.target.value;
    onChange({ start: newStart, end: newStart > end ? newStart : end });
  }
  function handleEndChange(e) { onChange({ start, end: e.target.value }); }

  let rangeLabel;
  if (activeLabel === 'All') rangeLabel = `All time → ${niceDate(end)}`;
  else if (isSingleDay) rangeLabel = niceDate(start);
  else {
    const sameYear = start.slice(0, 4) === end.slice(0, 4);
    rangeLabel = `${niceDate(start, !sameYear)} – ${niceDate(end)}`;
  }

  return (
    <div className="date-range-picker">
      <div className="date-range-picker__presets">
        {PRESETS.map(p => (
          <button
            type="button"
            key={p.label}
            onClick={() => handlePreset(p)}
            className={`date-range-picker__btn${activeLabel === p.label ? ' date-range-picker__btn--active' : ''}`}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={handleAll}
          title="All available history"
          className={`date-range-picker__btn${activeLabel === 'All' ? ' date-range-picker__btn--active' : ''}`}
        >
          All
        </button>
        {activeLabel === 'Single day' && <span className="date-range-picker__hint">Single day</span>}
        {!isSingleDay && (
          <label className="date-range-picker__mtd-opt" title="End the range yesterday (complete data) instead of today (partial)">
            <input type="checkbox" checked={throughYesterday} onChange={handleThroughYesterdayChange} />
            Through yesterday
          </label>
        )}
      </div>

      <div className="date-range-picker__inputs">
        <input type="date" value={start} onChange={handleStartChange} className="date-range-picker__input" aria-label="Start date" />
        <span className="date-range-picker__sep">→</span>
        <input type="date" value={end} onChange={handleEndChange} className="date-range-picker__input" aria-label="End date" />
      </div>

      <span className="date-range-picker__label" title="Active date range">{rangeLabel}</span>
    </div>
  );
}
