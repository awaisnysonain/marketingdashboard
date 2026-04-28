import React, { useState, useRef, useEffect } from 'react';

/**
 * EditableCell — inline editable table cell.
 *
 * Props:
 *   value    — current display value
 *   onSave   — callback(newValue: string) called on Enter / blur
 *   format   — 'text' | 'currency' | 'number' (default: 'text')
 *   style    — extra style for the outer container span
 */
export default function EditableCell({ value, onSave, format = 'text', style }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef(null);

  // When entering edit mode, seed the draft with a "raw" version of value
  function startEdit() {
    let raw = String(value ?? '');
    if (format === 'currency') {
      // Strip leading $, commas, spaces
      raw = raw.replace(/[$,\s]/g, '');
    } else if (format === 'number') {
      raw = raw.replace(/,/g, '');
    }
    setDraft(raw);
    setEditing(true);
  }

  // Focus input after entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function commit() {
    setEditing(false);
    setHovered(false);
    let val = draft;
    if (format === 'currency') val = val.replace(/[$,\s]/g, '');
    if (format === 'number') val = val.replace(/,/g, '');
    if (val !== String(value ?? '').replace(/[$,\s]/g, '')) {
      onSave && onSave(val);
    }
  }

  function cancel() {
    setEditing(false);
    setDraft('');
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') cancel();
  }

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', ...style }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          style={{
            padding: '2px 6px',
            background: 'var(--bg)',
            border: '1px solid var(--accent)',
            borderRadius: 5,
            color: 'var(--text)',
            fontSize: 'inherit',
            fontFamily: format === 'number' || format === 'currency' ? 'var(--font-mono)' : 'var(--font-body)',
            outline: 'none',
            minWidth: 60,
            width: Math.max(60, (draft.length + 2) * 8) + 'px',
            boxShadow: '0 0 0 2px rgba(59,130,246,.2)',
          }}
        />
      </span>
    );
  }

  return (
    <span
      onClick={startEdit}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Click to edit"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        cursor: 'text', borderRadius: 5, padding: '2px 4px',
        transition: 'background .12s',
        background: hovered ? 'rgba(59,130,246,.08)' : 'transparent',
        outline: hovered ? '1px dashed rgba(59,130,246,.35)' : '1px dashed transparent',
        ...style,
      }}
    >
      {value != null && value !== '' ? value : <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}>—</span>}

      {/* Pencil icon — only visible on hover */}
      {hovered && (
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, opacity: .7 }}
        >
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      )}
    </span>
  );
}
