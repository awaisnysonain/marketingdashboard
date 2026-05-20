import React, { useState, useCallback, useRef } from 'react';
import { setHighlight, removeHighlight, fmtCell } from '../utils/api';
import { useClientPagination } from '../hooks/useClientPagination';
import { TABLE_PAGE_SIZE } from '../constants/pagination';
import AnnotationModal from './AnnotationModal';
import TablePagination from './TablePagination';

const HL_BG = { yellow: 'var(--hl-yellow)', green: 'var(--hl-green)', red: 'var(--hl-red)', blue: 'var(--hl-blue)' };
const HL_CYCLE = ['yellow', 'green', 'red', 'blue', null];

function defaultColWidth(header) {
  const h = String(header).toLowerCase();
  if (h.includes('campaign')) return 240;
  if (h.includes('adset') || h.includes('ad set')) return 220;
  if (h === 'ad' || h.includes('ad name')) return 260;
  if (h.includes('revenue') || h.includes('spend') || h.includes('cac') || h.includes('cpc') || h.includes('cpm')) return 120;
  if (h.includes('roas') || h.includes('ctr') || h.includes('rate')) return 90;
  if (h.includes('orders') || h.includes('purchases') || h.includes('clicks') || h.includes('impressions')) return 120;
  if (h.includes('date')) return 110;
  return 160;
}

function isDateSortColumn(header) {
  const h = String(header || '').trim().toLowerCase();
  return h === 'date' || h === 'day' || h.endsWith(' date') || h.includes('created at') || h.includes('updated at');
}

export default function DataTable({
  tab, headers, rows, onRowsChange,
  maxHeight = '480px',
  searchable = true,
  paginated = true,
  pageSize = TABLE_PAGE_SIZE,
}) {
  const [search, setSearch]       = useState('');
  const [localRows, setLocalRows] = useState(rows);
  const [modal, setModal]         = useState(null);
  const [sortBy, setSortBy]       = useState(null);
  const [sortDir, setSortDir]     = useState('asc');
  const [colWidths, setColWidths] = useState({});

  // Selection
  const [selectedRows, setSelectedRows] = useState(new Set());
  const [selectedCols, setSelectedCols] = useState(new Set());
  const [anchorRow, setAnchorRow]       = useState(null);
  const [anchorCol, setAnchorCol]       = useState(null);
  const [selecting, setSelecting]       = useState(false);
  const selStartRef = useRef(null);
  const resizeRef = useRef(null);

  React.useEffect(() => { setLocalRows(rows); }, [rows]);

  const visibleHeaders = headers.filter(h => !h.startsWith('_'));

  React.useEffect(() => {
    setColWidths(prev => {
      const next = {};
      for (const h of visibleHeaders) next[h] = prev[h] || defaultColWidth(h);
      return next;
    });
  }, [headers]);

  React.useEffect(() => {
    function onMove(e) {
      const resize = resizeRef.current;
      if (!resize) return;
      const width = Math.max(70, resize.startWidth + e.clientX - resize.startX);
      setColWidths(prev => ({ ...prev, [resize.header]: width }));
    }
    function onUp() { resizeRef.current = null; }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  function startColumnResize(e, header) {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { header, startX: e.clientX, startWidth: colWidths[header] || defaultColWidth(header) };
  }

  // Filter
  const filtered = search
    ? localRows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(search.toLowerCase())))
    : localRows;

  // Sort
  const sorted = sortBy
    ? [...filtered].sort((a, b) => {
        const va = a[sortBy], vb = b[sortBy];
        if (va == null) return 1; if (vb == null) return -1;
        const na = parseFloat(va), nb = parseFloat(vb);
        if (!isNaN(na) && !isNaN(nb)) return sortDir === 'asc' ? na - nb : nb - na;
        return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
      })
    : filtered;

  const {
    page, setPage, pageItems, totalRows, rowOffset,
  } = useClientPagination(sorted, pageSize, [search, sortBy, sortDir, rows]);
  const displayRows = paginated ? pageItems : sorted;

  function handleSort(h) {
    if (!isDateSortColumn(h)) return;
    if (sortBy === h) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(h); setSortDir('asc'); }
  }

  // Row selection
  function selectRow(e, rowIdx) {
    e.preventDefault();
    if (e.shiftKey && anchorRow !== null) {
      const lo = Math.min(anchorRow, rowIdx), hi = Math.max(anchorRow, rowIdx);
      const next = new Set(selectedRows);
      for (let i = lo; i <= hi; i++) next.add(i);
      setSelectedRows(next);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedRows);
      next.has(rowIdx) ? next.delete(rowIdx) : next.add(rowIdx);
      setSelectedRows(next); setAnchorRow(rowIdx);
    } else {
      setSelectedRows(new Set([rowIdx])); setAnchorRow(rowIdx);
    }
    setSelectedCols(new Set());
  }

  function selectCol(e, colIdx) {
    e.stopPropagation();
    if (e.shiftKey && anchorCol !== null) {
      const lo = Math.min(anchorCol, colIdx), hi = Math.max(anchorCol, colIdx);
      const next = new Set(selectedCols);
      for (let i = lo; i <= hi; i++) next.add(i);
      setSelectedCols(next);
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedCols);
      next.has(colIdx) ? next.delete(colIdx) : next.add(colIdx);
      setSelectedCols(next); setAnchorCol(colIdx);
    } else {
      setSelectedCols(new Set([colIdx])); setAnchorCol(colIdx);
    }
    setSelectedRows(new Set());
  }

  // Drag
  function handleRowMouseDown(e, rowIdx) {
    if (e.button !== 0) return;
    setSelecting(true); selStartRef.current = rowIdx;
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      setSelectedRows(new Set([rowIdx])); setAnchorRow(rowIdx);
    }
  }
  function handleRowMouseEnter(rowIdx) {
    if (!selecting) return;
    const lo = Math.min(selStartRef.current, rowIdx), hi = Math.max(selStartRef.current, rowIdx);
    const next = new Set();
    for (let i = lo; i <= hi; i++) next.add(i);
    setSelectedRows(next);
  }
  function handleMouseUp() { setSelecting(false); }

  // Highlight
  const cycleHL = useCallback(async (row) => {
    const curr = row._highlighted;
    const next = HL_CYCLE[(HL_CYCLE.indexOf(curr) + 1) % HL_CYCLE.length];
    if (next === null) await removeHighlight({ tab, row_key: row._rowKey });
    else await setHighlight({ tab, row_key: row._rowKey, color: next });
    setLocalRows(prev => prev.map(r => r._rowKey === row._rowKey ? { ...r, _highlighted: next } : r));
    onRowsChange?.();
  }, [tab, onRowsChange]);

  function openAnnotate(e, row) {
    e.preventDefault();
    setModal({ tab, rowKey: row._rowKey, metric: '', existing: row._annotations?.[0] || null });
  }
  function onAnnotSaved(row, result) {
    setLocalRows(prev => prev.map(r => {
      if (r._rowKey !== row._rowKey) return r;
      if (!result) return { ...r, _annotations: [] };
      const anns = (r._annotations || []).filter(a => a.id !== result.id);
      return { ...r, _annotations: [result, ...anns] };
    }));
  }

  // Selection summary
  const selCount = selectedRows.size > 0 ? selectedRows.size : selectedCols.size;
  const selType  = selectedRows.size > 0 ? 'row' : selectedCols.size > 0 ? 'col' : null;
  let selSum = null;
  if (selectedRows.size > 0) {
    const nums = [...selectedRows].flatMap(ri => {
      const row = sorted[ri]; if (!row) return [];
      return visibleHeaders.map(h => parseFloat(row[h])).filter(n => !isNaN(n));
    });
    if (nums.length) selSum = nums.reduce((a, b) => a + b, 0);
  }

  function clearSelection() { setSelectedRows(new Set()); setSelectedCols(new Set()); }

  // Column first-header left-align detection
  function isNumCol(h) {
    const sample = sorted.slice(0, 10).map(r => r[h]).filter(v => v != null);
    return sample.length > 0 && sample.every(v => !isNaN(parseFloat(v)) && v !== '');
  }

  return (
    <div onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} style={{ userSelect: 'none' }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        {searchable && (
          <div style={{ position: 'relative' }}>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Filter rows..."
              style={{
                padding: '5px 8px 5px 26px', width: 200,
                background: 'var(--bg3)', border: '1px solid var(--border2)',
                borderRadius: 'var(--radius)', color: 'var(--text)',
                fontSize: 12, outline: 'none', fontFamily: 'var(--font-body)',
              }}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border2)'}
            />
            <svg style={{ position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)', opacity: .4 }}
              width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            {search && (
              <button onClick={() => setSearch('')}
                style={{ position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 14 }}>×</button>
            )}
          </div>
        )}

        <span style={{ fontSize: 11, color: 'var(--text4)', marginLeft: 'auto' }}>
          {sorted.length.toLocaleString()} rows{paginated ? ` · page ${page}` : ''}
        </span>

        {selType && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '3px 8px', background: 'var(--accent-dim)',
            border: '1px solid var(--accent)', borderRadius: 'var(--radius)',
            fontSize: 11, color: 'var(--accent)',
          }}>
            <span>{selCount} {selType}{selCount !== 1 ? 's' : ''}</span>
            {selSum !== null && (
              <span style={{ color: 'var(--text2)' }}>
                Σ {selSum.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            )}
            <button onClick={clearSelection}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
          </div>
        )}
      </div>

      {/* Table */}
      <div style={{
        overflowX: 'auto',
        overflowY: paginated ? 'visible' : 'auto',
        maxHeight: paginated ? 'none' : maxHeight,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--bg2)',
      }}>
        <table style={{
          width: 'max-content', minWidth: '100%',
          borderCollapse: 'collapse',
          fontSize: 12,
          tableLayout: 'fixed',
        }}>
          <colgroup>
            <col style={{ width: 32 }} />
            {visibleHeaders.map(h => <col key={h} style={{ width: colWidths[h] || defaultColWidth(h) }} />)}
            <col style={{ width: 28 }} />
          </colgroup>

          {/* HEAD */}
          <thead>
            <tr style={{ background: 'var(--bg3)', position: 'sticky', top: 0, zIndex: 2 }}>
              {/* Row # */}
              <th style={{
                width: 32, padding: '6px 0',
                borderBottom: '1px solid var(--border2)',
                borderRight: '1px solid var(--border2)',
                color: 'var(--text4)', fontSize: 10, fontWeight: 500,
                textAlign: 'center',
              }}>
                #
              </th>
              {/* Data columns */}
              {visibleHeaders.map((h, ci) => {
                const isNum = isNumCol(h);
                const isSelCol = selectedCols.has(ci);
                const isSort = sortBy === h;
                return (
                  <th
                    key={h}
                    onClick={e => { handleSort(h); selectCol(e, ci); }}
                    style={{
                      padding: '6px 10px',
                      borderBottom: '1px solid var(--border2)',
                      borderRight: ci < visibleHeaders.length - 1 ? '1px solid var(--col-sep)' : 'none',
                      textAlign: isNum ? 'right' : 'left',
                      fontSize: 11, fontWeight: 600,
                      color: isSelCol ? 'var(--accent)' : isSort ? 'var(--text)' : 'var(--text3)',
                      background: isSelCol ? 'var(--accent-soft)' : undefined,
                      whiteSpace: 'nowrap', cursor: 'pointer',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      width: colWidths[h] || defaultColWidth(h), maxWidth: colWidths[h] || defaultColWidth(h),
                      userSelect: 'none',
                      letterSpacing: '.01em',
                      position: 'relative',
                    }}
                  >
                    <span style={{ display:'block', overflow:'hidden', textOverflow:'ellipsis', paddingRight:10 }}>
                      {h}
                    </span>
                    <span
                      onMouseDown={e => startColumnResize(e, h)}
                      onClick={e => e.stopPropagation()}
                      title="Drag to resize column"
                      style={{ position:'absolute', top:0, right:-3, width:8, height:'100%', cursor:'col-resize', zIndex:5, borderRight:'1px solid transparent' }}
                      onMouseEnter={e => { e.currentTarget.style.borderRightColor = 'var(--accent)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderRightColor = 'transparent'; }}
                    />
                  </th>
                );
              })}
              {/* Actions placeholder */}
              <th style={{ width: 28, borderBottom: '1px solid var(--border2)' }} />
            </tr>
          </thead>

          {/* BODY */}
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={visibleHeaders.length + 2}
                  style={{ padding: '28px', textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
                  No rows match
                </td>
              </tr>
            )}
            {displayRows.map((row, ri) => {
              const rowIdx = paginated ? rowOffset + ri : ri;
              const isRowSel = selectedRows.has(rowIdx);
              const isHL = row._highlighted;
              const evenBg = ri % 2 === 1 ? 'var(--bg3)' : 'var(--bg2)';
              const rowBg = isRowSel ? 'var(--accent-dim)' : isHL ? HL_BG[isHL] : evenBg;

              return (
                <tr
                  key={row._rowKey || ri}
                  onMouseDown={e => handleRowMouseDown(e, rowIdx)}
                  onMouseEnter={() => handleRowMouseEnter(rowIdx)}
                  onContextMenu={e => openAnnotate(e, row)}
                  className={isRowSel ? 'row-selected' : ''}
                  style={{ background: rowBg }}
                >
                  {/* Row number */}
                  <td
                    onClick={e => selectRow(e, rowIdx)}
                    style={{
                      padding: '5px 6px',
                      textAlign: 'center',
                      fontSize: 10, color: 'var(--text4)',
                      fontFamily: 'var(--font-mono)',
                      borderBottom: '1px solid var(--row-sep)',
                      borderRight: '1px solid var(--border2)',
                      cursor: 'pointer',
                      background: isRowSel ? 'var(--accent-soft)' : undefined,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {rowIdx + 1}
                  </td>

                  {/* Data cells */}
                  {visibleHeaders.map((h, ci) => {
                    const isColSel = selectedCols.has(ci);
                    const val = row[h];
                    const isNum = typeof val === 'number' || (!isNaN(parseFloat(val)) && val !== '' && val != null);
                    const hasAnn = (row._annotations || []).length > 0;
                    return (
                      <td
                        key={h}
                        style={{
                          padding: '5px 10px',
                          borderBottom: '1px solid var(--row-sep)',
                          borderRight: ci < visibleHeaders.length - 1 ? '1px solid var(--col-sep)' : 'none',
                          color: isNum ? 'var(--text)' : 'var(--text2)',
                          textAlign: isNum ? 'right' : 'left',
                          fontFamily: isNum ? 'var(--font-mono)' : 'var(--font-body)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis',
                          width: colWidths[h] || defaultColWidth(h), maxWidth: colWidths[h] || defaultColWidth(h),
                          background: isColSel ? 'var(--accent-soft)' : undefined,
                          fontSize: 12,
                        }}
                      >
                        {fmtCell(val, h)}
                      </td>
                    );
                  })}

                  {/* Actions cell (HL + annotate on hover) */}
                  <td
                    style={{
                      padding: '0 4px',
                      borderBottom: '1px solid var(--row-sep)',
                      textAlign: 'center',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      {/* Highlight dot */}
                      <span
                        onClick={e => { e.stopPropagation(); cycleHL(row); }}
                        title="Highlight row"
                        style={{
                          display: 'inline-block',
                          width: 7, height: 7, borderRadius: '50%',
                          background: isHL ? HL_BG[isHL] : 'var(--border2)',
                          cursor: 'pointer',
                          opacity: isHL ? 1 : 0,
                          transition: 'opacity .1s',
                        }}
                        className="row-action-dot"
                      />
                      {/* Annotation dot */}
                      {(row._annotations || []).length > 0 && (
                        <span
                          onClick={e => openAnnotate(e, row)}
                          title={row._annotations[0].note}
                          style={{
                            display: 'inline-block',
                            width: 7, height: 7, borderRadius: '50%',
                            background: 'var(--accent)',
                            cursor: 'pointer',
                          }}
                        />
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {paginated && (
        <TablePagination
          page={page}
          pageSize={pageSize}
          totalRows={totalRows}
          onPageChange={setPage}
        />
      )}

      {/* Hint */}
      <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text4)' }}>
        Click # to select row · Click header to sort · Shift+Click range · Ctrl+Click multi-select
      </div>

      {modal && (
        <AnnotationModal
          tab={modal.tab} rowKey={modal.rowKey} metric={modal.metric} existing={modal.existing}
          onClose={() => setModal(null)}
          onSaved={result => {
            const row = sorted.find(r => r._rowKey === modal.rowKey);
            if (row) onAnnotSaved(row, result);
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
