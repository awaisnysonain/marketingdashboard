import React from 'react';
import { SEARCH_ALL_COLUMNS } from '../constants/tableSearch';

const selectStyle = {
  padding: '5px 8px',
  minWidth: 140,
  maxWidth: 220,
  background: 'var(--bg3)',
  border: '1px solid var(--border2)',
  borderRadius: 6,
  color: 'var(--text)',
  fontSize: 12,
  outline: 'none',
  fontFamily: 'var(--font-body)',
  cursor: 'pointer',
};

const inputStyle = {
  padding: '5px 8px 5px 26px',
  width: 220,
  background: 'var(--bg3)',
  border: '1px solid var(--border2)',
  borderRadius: 6,
  color: 'var(--text)',
  fontSize: 12,
  outline: 'none',
  fontFamily: 'var(--font-body)',
};

/**
 * Column picker + search box for tables.
 */
export default function TableFilterBar({
  headers = [],
  searchColumn = SEARCH_ALL_COLUMNS,
  onSearchColumnChange,
  search = '',
  onSearchChange,
  placeholder,
  showColumnPicker = true,
}) {
  const cols = (headers || []).filter((h) => h && !String(h).startsWith('_'));
  const hint = searchColumn === SEARCH_ALL_COLUMNS
    ? 'Search all columns (dates, numbers, text)…'
    : `Search in “${searchColumn}”…`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {showColumnPicker && cols.length > 0 && onSearchColumnChange ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text3)' }}>
          <span style={{ whiteSpace: 'nowrap' }}>Column</span>
          <select
            value={searchColumn}
            onChange={(e) => onSearchColumnChange(e.target.value)}
            style={selectStyle}
            aria-label="Column to search"
          >
            <option value={SEARCH_ALL_COLUMNS}>All columns</option>
            {cols.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
      ) : null}
      <div style={{ position: 'relative' }}>
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={placeholder || hint}
          style={inputStyle}
          onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
          onBlur={(e) => { e.target.style.borderColor = 'var(--border2)'; }}
        />
        <svg
          style={{
            position: 'absolute',
            left: 7,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: 0.4,
            pointerEvents: 'none',
          }}
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        {search ? (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            style={{
              position: 'absolute',
              right: 5,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              color: 'var(--text3)',
              cursor: 'pointer',
              fontSize: 14,
              padding: 0,
              lineHeight: 1,
            }}
            title="Clear search"
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}
