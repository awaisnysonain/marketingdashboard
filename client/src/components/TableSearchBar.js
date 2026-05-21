import React from 'react';

export default function TableSearchBar({ value, onChange, placeholder = 'Filter rows…' }) {
  return (
    <div style={{ position: 'relative' }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          padding: '5px 8px 5px 26px',
          width: 200,
          background: 'var(--bg3)',
          border: '1px solid var(--border2)',
          borderRadius: 6,
          color: 'var(--text)',
          fontSize: 12,
          outline: 'none',
          fontFamily: 'var(--font-body)',
        }}
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
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
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
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
