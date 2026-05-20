import React from 'react';

/**
 * Server-driven table pagination — shows full dataset size while only one page is loaded.
 */
export default function TablePagination({
  page = 1,
  pageSize = 50,
  totalRows = 0,
  onPageChange,
  loading = false,
}) {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startRow = totalRows === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endRow = totalRows === 0 ? 0 : Math.min(safePage * pageSize, totalRows);

  const go = (p) => {
    const next = Math.min(Math.max(1, p), totalPages);
    if (next !== safePage && onPageChange) onPageChange(next);
  };

  const window = [];
  const maxButtons = 7;
  let lo = Math.max(1, safePage - 3);
  let hi = Math.min(totalPages, lo + maxButtons - 1);
  lo = Math.max(1, hi - maxButtons + 1);
  for (let i = lo; i <= hi; i++) window.push(i);

  if (totalRows <= pageSize && totalPages <= 1) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg3)',
        fontSize: 12, color: 'var(--text3)',
      }}>
        <span>{totalRows.toLocaleString()} {totalRows === 1 ? 'row' : 'rows'}</span>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10,
      padding: '10px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg3)',
    }}>
      <span style={{ fontSize: 12, color: 'var(--text3)' }}>
        {totalRows === 0
          ? 'No rows'
          : `Showing ${startRow.toLocaleString()}–${endRow.toLocaleString()} of ${totalRows.toLocaleString()} rows`}
        {' · '}
        Page {safePage} of {totalPages}
        {loading ? ' · loading…' : ''}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <PagerBtn label="«" disabled={safePage <= 1 || loading} onClick={() => go(1)} />
        <PagerBtn label="‹" disabled={safePage <= 1 || loading} onClick={() => go(safePage - 1)} />
        {lo > 1 && (
          <>
            <PagerBtn label="1" active={safePage === 1} disabled={loading} onClick={() => go(1)} />
            {lo > 2 && <span style={{ color: 'var(--text3)', fontSize: 12, padding: '0 4px' }}>…</span>}
          </>
        )}
        {window.map((n) => (
          <PagerBtn key={n} label={String(n)} active={n === safePage} disabled={loading} onClick={() => go(n)} />
        ))}
        {hi < totalPages && (
          <>
            {hi < totalPages - 1 && <span style={{ color: 'var(--text3)', fontSize: 12, padding: '0 4px' }}>…</span>}
            <PagerBtn label={String(totalPages)} active={safePage === totalPages} disabled={loading} onClick={() => go(totalPages)} />
          </>
        )}
        <PagerBtn label="›" disabled={safePage >= totalPages || loading} onClick={() => go(safePage + 1)} />
        <PagerBtn label="»" disabled={safePage >= totalPages || loading} onClick={() => go(totalPages)} />
      </div>
    </div>
  );
}

function PagerBtn({ label, onClick, disabled, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: 32, padding: '4px 10px', borderRadius: 6,
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border2)'}`,
        background: active ? 'var(--accent-dim)' : 'transparent',
        color: disabled ? 'var(--text3)' : active ? 'var(--accent)' : 'var(--text2)',
        fontSize: 13, fontWeight: active ? 600 : 400,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  );
}
