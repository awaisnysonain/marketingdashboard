import React, { useEffect, useState } from 'react';
import { multiFilterLabel } from '../constants/dashboardFilters';

/**
 * Reusable multi-select dropdown for dashboard filters (region, channel, brand).
 */
export default function FilterMultiSelect({
  label,
  value,
  onChange,
  options,
  normalize,
  minWidth = 160,
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const selected = normalize(value);
  const [draft, setDraft] = useState(selected);

  useEffect(() => {
    if (open) setDraft(normalize(value));
  }, [open, value, normalize]);

  function toggle(v) {
    const vv = String(v).toUpperCase();
    if (vv === 'ALL') {
      setDraft(['ALL']);
      return;
    }
    if (draft.includes('ALL')) {
      setDraft([vv]);
      return;
    }
    if (draft.includes(vv)) {
      const next = draft.filter(x => x !== vv);
      setDraft(next.length ? next : ['ALL']);
    } else {
      setDraft([...draft, vv]);
    }
  }

  const display = multiFilterLabel(selected, options);

  return (
    <div className="filter-multi-select" style={{ minWidth }}>
      {label && <span className="filter-multi-select__label">{label}</span>}
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className={`filter-multi-select__btn${compact ? ' filter-multi-select__btn--compact' : ''}`}
          onClick={() => setOpen(o => !o)}
          title={display}
        >
          {display}
        </button>
        <span className="filter-multi-select__caret">▼</span>

        {open && (
          <>
            <div className="filter-multi-select__backdrop" onClick={() => setOpen(false)} />
            <div className="filter-multi-select__menu">
              {options.map(opt => {
                const checked = opt.value === 'ALL'
                  ? (draft.length === 1 && draft[0] === 'ALL')
                  : draft.includes(opt.value);
                return (
                  <label key={opt.value} className="filter-multi-select__option">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(opt.value)}
                    />
                    <span className={opt.value === 'ALL' ? 'filter-multi-select__option-all' : ''}>
                      {opt.label}
                    </span>
                  </label>
                );
              })}
              <div className="filter-multi-select__actions">
                <button type="button" className="filter-multi-select__reset" onClick={() => setDraft(['ALL'])}>
                  Reset
                </button>
                <button
                  type="button"
                  className="filter-multi-select__apply"
                  onClick={() => { onChange(normalize(draft)); setOpen(false); }}
                >
                  Apply
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
