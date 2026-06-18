import React from 'react';

/**
 * Table pagination — page window + readable "showing X–Y of Z" info.
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

  const win = [];
  const maxButtons = 7;
  let lo = Math.max(1, safePage - 3);
  const hi = Math.min(totalPages, lo + maxButtons - 1);
  lo = Math.max(1, hi - maxButtons + 1);
  for (let i = lo; i <= hi; i++) win.push(i);

  if (totalRows <= pageSize && totalPages <= 1) {
    return (
      <div className="pager">
        <span className="pager__info">{totalRows.toLocaleString()} {totalRows === 1 ? 'row' : 'rows'}</span>
      </div>
    );
  }

  return (
    <div className="pager">
      <span className="pager__info">
        {totalRows === 0
          ? 'No rows'
          : `Showing ${startRow.toLocaleString()}–${endRow.toLocaleString()} of ${totalRows.toLocaleString()} rows`}
        {' · '}Page {safePage} of {totalPages}{loading ? ' · loading…' : ''}
      </span>
      <div className="pager__btns">
        <PagerBtn label="«" disabled={safePage <= 1 || loading} onClick={() => go(1)} />
        <PagerBtn label="‹" disabled={safePage <= 1 || loading} onClick={() => go(safePage - 1)} />
        {lo > 1 && (
          <>
            <PagerBtn label="1" active={safePage === 1} disabled={loading} onClick={() => go(1)} />
            {lo > 2 && <span className="pager__dots">…</span>}
          </>
        )}
        {win.map((n) => (
          <PagerBtn key={n} label={String(n)} active={n === safePage} disabled={loading} onClick={() => go(n)} />
        ))}
        {hi < totalPages && (
          <>
            {hi < totalPages - 1 && <span className="pager__dots">…</span>}
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
      className={`pager__btn${active ? ' pager__btn--active' : ''}`}
    >
      {label}
    </button>
  );
}
