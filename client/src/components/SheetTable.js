/**
 * SheetTable — Google Sheets-style data table
 *
 * Features:
 *  - Click a cell to select it (highlighted blue, like Google Sheets)
 *  - Shift+click to extend selection to a range
 *  - Ctrl/Meta+click to toggle individual cells
 *  - Click-and-drag to paint a selection rectangle
 *  - Click row-number to select entire row
 *  - Click column header to sort (and optionally select entire column)
 *  - Selection info bar: count, sum, avg for numeric selections
 *  - Ctrl+C copies selected cells as TSV
 *  - Sticky header, row numbers, zebra rows, full date/number formatting
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { fmt$, fmtCell } from '../utils/api';

// ─── helpers ─────────────────────────────────────────────────────────────────
function fmtVal(v, header) {
  if (v == null || v === '') return '—';
  if (typeof fmtCell === 'function') return fmtCell(v, header);
  const n = parseFloat(v);
  const h = String(header).toLowerCase();
  if (!isNaN(n)) {
    if (h.includes('revenue') || h.includes('spend') || h.includes('rev') || h.includes('cac') || h.includes('sub'))
      return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    if (h.includes('roas') || h.includes('mer')) return n.toFixed(2) + 'x';
    if (h.includes('rate') || h.includes('pct') || h.includes('%')) return n.toFixed(1) + '%';
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(v);
}

function isNumeric(v) {
  return v != null && v !== '' && !isNaN(parseFloat(v));
}

function cellKey(r, c) { return `${r}:${c}`; }

function expandRect(a, b) {
  return {
    r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r),
    c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c),
  };
}

function defaultColWidth(header) {
  const h = String(header).toLowerCase();
  if (h.includes('campaign')) return 240;
  if (h.includes('ad set')) return 220;
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

// ─── component ───────────────────────────────────────────────────────────────
export default function SheetTable({
  headers = [],            // string[] — visible column names
  rows = [],               // object[] — data rows
  keyField = null,         // string — unique field for row key (falls back to index)
  maxHeight = '480px',
  searchable = true,
  defaultSortField = null,
  defaultSortDir = 'desc',
  onRowClick = null,       // (row) => void — optional row click handler
  stickyFirstCol = false,  // freeze first column
  compact = false,
}) {
  // ── search & sort
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState(() => isDateSortColumn(defaultSortField) ? defaultSortField : null);
  const [sortDir, setSortDir] = useState(defaultSortDir);

  // ── cell selection state
  const [sel, setSel] = useState(new Set());        // Set of "r:c" keys
  const [anchor, setAnchor] = useState(null);       // { r, c }
  const [dragging, setDragging] = useState(false);
  const [colWidths, setColWidths] = useState({});
  const dragStart = useRef(null);
  const resizeRef = useRef(null);

  // ref to table div for copy-to-clipboard
  const tableRef = useRef(null);

  useEffect(() => {
    setColWidths(prev => {
      const next = {};
      for (const h of headers) next[h] = prev[h] || defaultColWidth(h);
      return next;
    });
  }, [headers]);

  useEffect(() => {
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

  // ── filter
  const filtered = search
    ? rows.filter(row => headers.some(h => String(row[h] ?? '').toLowerCase().includes(search.toLowerCase())))
    : rows;

  // ── sort
  const sorted = sortBy
    ? [...filtered].sort((a, b) => {
        const va = a[sortBy], vb = b[sortBy];
        if (va == null) return 1; if (vb == null) return -1;
        const na = parseFloat(va), nb = parseFloat(vb);
        if (!isNaN(na) && !isNaN(nb)) return sortDir === 'asc' ? na - nb : nb - na;
        return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
      })
    : filtered;

  function handleSort(h) {
    if (!isDateSortColumn(h)) return;
    if (sortBy === h) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(h); setSortDir('asc'); }
  }

  // ── selection helpers
  function rectCells(r0, r1, c0, c1) {
    const keys = new Set();
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        keys.add(cellKey(r, c));
    return keys;
  }

  function setCellSelection(ri, ci, e) {
    const cell = { r: ri, c: ci };

    if (e.shiftKey && anchor) {
      // extend range from anchor
      const rect = expandRect(anchor, cell);
      setSel(rectCells(rect.r0, rect.r1, rect.c0, rect.c1));
    } else if (e.ctrlKey || e.metaKey) {
      // toggle single cell
      const key = cellKey(ri, ci);
      setSel(prev => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
      });
      setAnchor(cell);
    } else {
      // single cell
      setSel(new Set([cellKey(ri, ci)]));
      setAnchor(cell);
    }
  }

  function selectRow(ri, e) {
    e.stopPropagation();
    if (e.shiftKey && anchor) {
      const r0 = Math.min(anchor.r, ri), r1 = Math.max(anchor.r, ri);
      setSel(rectCells(r0, r1, 0, headers.length - 1));
    } else if (e.ctrlKey || e.metaKey) {
      const rowKeys = rectCells(ri, ri, 0, headers.length - 1);
      setSel(prev => {
        const next = new Set(prev);
        rowKeys.forEach(k => next.add(k));
        return next;
      });
      setAnchor({ r: ri, c: 0 });
    } else {
      setSel(rectCells(ri, ri, 0, headers.length - 1));
      setAnchor({ r: ri, c: 0 });
    }
  }

  function selectCol(ci, e) {
    e.stopPropagation();
    handleSort(headers[ci]);
    if (e.shiftKey && anchor) {
      const c0 = Math.min(anchor.c, ci), c1 = Math.max(anchor.c, ci);
      setSel(rectCells(0, sorted.length - 1, c0, c1));
    } else {
      setSel(rectCells(0, sorted.length - 1, ci, ci));
      setAnchor({ r: 0, c: ci });
    }
  }

  // ── drag selection
  function handleCellMouseDown(ri, ci, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(true);
    dragStart.current = { r: ri, c: ci };
    setCellSelection(ri, ci, e);
  }

  function handleCellMouseEnter(ri, ci) {
    if (!dragging || !dragStart.current) return;
    const rect = expandRect(dragStart.current, { r: ri, c: ci });
    setSel(rectCells(rect.r0, rect.r1, rect.c0, rect.c1));
  }

  function handleMouseUp() { setDragging(false); }

  function startColumnResize(e, header) {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      header,
      startX: e.clientX,
      startWidth: colWidths[header] || defaultColWidth(header),
    };
  }

  // ── Ctrl+C copy
  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && sel.size > 0) {
        // build TSV from selected cells
        const selRows = new Set([...sel].map(k => parseInt(k.split(':')[0])));
        const selCols = new Set([...sel].map(k => parseInt(k.split(':')[1])));
        const sortedR = [...selRows].sort((a,b) => a - b);
        const sortedC = [...selCols].sort((a,b) => a - b);
        const tsv = sortedR.map(ri =>
          sortedC.map(ci => {
            if (!sel.has(cellKey(ri, ci))) return '';
            const row = sorted[ri];
            return row ? (row[headers[ci]] ?? '') : '';
          }).join('\t')
        ).join('\n');
        navigator.clipboard.writeText(tsv).catch(() => {});
      }
      if (e.key === 'Escape') setSel(new Set());
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sel, sorted, headers]);

  // ── selection stats
  const selNums = [...sel].map(k => {
    const [ri, ci] = k.split(':').map(Number);
    const row = sorted[ri];
    return row ? parseFloat(row[headers[ci]]) : NaN;
  }).filter(n => !isNaN(n));

  const selSum  = selNums.length ? selNums.reduce((a,b)=>a+b,0) : null;
  const selAvg  = selNums.length ? selSum / selNums.length : null;

  // ── detect numeric columns for alignment
  function isNumCol(h) {
    const sample = sorted.slice(0,8).map(r=>r[h]).filter(v=>v!=null&&v!=='');
    return sample.length > 0 && sample.every(v => !isNaN(parseFloat(v)));
  }

  const cellPad = compact ? '4px 8px' : '6px 10px';

  return (
    <div
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ userSelect: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      {/* ── toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {searchable && (
          <div style={{ position: 'relative' }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter rows…"
              style={{
                padding: '5px 8px 5px 26px', width: 200,
                background: 'var(--bg3)', border: '1px solid var(--border2)',
                borderRadius: 6, color: 'var(--text)',
                fontSize: 12, outline: 'none', fontFamily: 'var(--font-body)',
              }}
              onFocus={e => (e.target.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.target.style.borderColor = 'var(--border2)')}
            />
            <svg style={{ position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)', opacity: .4, pointerEvents: 'none' }}
              width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            {search && (
              <button onClick={() => setSearch('')}
                style={{ position:'absolute', right:5, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:'var(--text3)', cursor:'pointer', fontSize:14, padding:0, lineHeight:1 }}>
                ×
              </button>
            )}
          </div>
        )}

        {/* row count */}
        <span style={{ fontSize: 11, color: 'var(--text4)', marginLeft: searchable ? 'auto' : 0 }}>
          {sorted.length.toLocaleString()} row{sorted.length !== 1 ? 's' : ''}
        </span>

        {/* selection summary */}
        {sel.size > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '3px 10px', background: 'var(--accent-dim)',
            border: '1px solid var(--accent)', borderRadius: 20,
            fontSize: 11,
          }}>
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{sel.size} cell{sel.size !== 1 ? 's' : ''}</span>
            {selNums.length > 0 && <>
              <span style={{ color: 'var(--text3)' }}>|</span>
              <span style={{ color: 'var(--text2)' }}>
                Sum: <strong>{selSum < 1000 ? selSum.toFixed(2) : selSum >= 1000000 ? '$' + (selSum/1000000).toFixed(2)+'M' : '$' + Math.round(selSum).toLocaleString()}</strong>
              </span>
              <span style={{ color: 'var(--text3)' }}>|</span>
              <span style={{ color: 'var(--text2)' }}>
                Avg: <strong>{selAvg < 1000 ? selAvg.toFixed(2) : '$' + Math.round(selAvg).toLocaleString()}</strong>
              </span>
            </>}
            <button
              onClick={() => setSel(new Set())}
              style={{ background:'none', border:'none', color:'var(--accent)', cursor:'pointer', fontSize:14, lineHeight:1, padding:0 }}
              title="Clear selection (Esc)"
            >×</button>
          </div>
        )}
      </div>

      {/* ── table ── */}
      <div
        ref={tableRef}
        style={{
          overflowX: 'auto', overflowY: 'auto', maxHeight,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg2)',
        }}
      >
        <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 36 }} />
            {headers.map(h => <col key={h} style={{ width: colWidths[h] || defaultColWidth(h) }} />)}
          </colgroup>
          {/* HEAD */}
          <thead>
            <tr style={{ background: 'var(--bg3)', position: 'sticky', top: 0, zIndex: 3 }}>
              {/* row-number gutter */}
              <th style={{
                width: 36, minWidth: 36,
                padding: '6px 0',
                borderBottom: '2px solid var(--border)',
                borderRight: '1px solid var(--border2)',
                textAlign: 'center',
                fontSize: 10, color: 'var(--text4)', fontWeight: 500,
                position: 'sticky', left: 0, background: 'var(--bg3)', zIndex: 4,
              }}>#</th>

              {headers.map((h, ci) => {
                const allColSel = sorted.length > 0 && sorted.every((_, ri) => sel.has(cellKey(ri, ci)));
                const someColSel = !allColSel && sorted.some((_, ri) => sel.has(cellKey(ri, ci)));
                const isSort = sortBy === h;
                const num = isNumCol(h);
                return (
                  <th
                    key={h}
                    onClick={e => selectCol(ci, e)}
                    style={{
                      padding: '6px 10px',
                      borderBottom: '2px solid var(--border)',
                      borderRight: ci < headers.length - 1 ? '1px solid var(--border2)' : 'none',
                      textAlign: num ? 'right' : 'left',
                      fontSize: 11, fontWeight: 600,
                      color: allColSel ? '#fff' : isSort ? 'var(--text)' : 'var(--text3)',
                      background: allColSel ? 'var(--accent)' : someColSel ? 'var(--accent-soft)' : undefined,
                      whiteSpace: 'nowrap', cursor: 'pointer',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      letterSpacing: '.01em',
                      width: colWidths[h] || defaultColWidth(h),
                      maxWidth: colWidths[h] || defaultColWidth(h),
                      position: stickyFirstCol && ci === 0 ? 'sticky' : undefined,
                      left: stickyFirstCol && ci === 0 ? 36 : undefined,
                      zIndex: stickyFirstCol && ci === 0 ? 3 : undefined,
                    }}
                  >
                    <span style={{ display:'block', overflow:'hidden', textOverflow:'ellipsis', paddingRight:10 }}>
                      {h}
                    </span>
                    <span
                      onMouseDown={e => startColumnResize(e, h)}
                      onClick={e => e.stopPropagation()}
                      title="Drag to resize column"
                      style={{
                        position:'absolute', top:0, right:-3, width:8, height:'100%', cursor:'col-resize', zIndex:5,
                        borderRight:'1px solid transparent',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderRightColor = 'var(--accent)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderRightColor = 'transparent'; }}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>

          {/* BODY */}
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={headers.length + 1}
                  style={{ padding: '32px', textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
                  No rows match
                </td>
              </tr>
            )}
            {sorted.map((row, ri) => {
              const rowAllSel = headers.every((_, ci) => sel.has(cellKey(ri, ci)));
              const rowAnySel = !rowAllSel && headers.some((_, ci) => sel.has(cellKey(ri, ci)));
              const evenBg = ri % 2 === 1 ? 'var(--bg3)' : 'var(--bg2)';

              return (
                <tr
                  key={keyField ? row[keyField] : ri}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={{ cursor: onRowClick ? 'pointer' : 'default' }}
                >
                  {/* row number */}
                  <td
                    onMouseDown={e => selectRow(ri, e)}
                    style={{
                      padding: compact ? '4px 0' : '5px 0',
                      textAlign: 'center',
                      fontSize: 10, color: 'var(--text4)',
                      fontFamily: 'var(--font-mono)',
                      borderBottom: '1px solid var(--row-sep)',
                      borderRight: '1px solid var(--border2)',
                      cursor: 'pointer',
                      background: rowAllSel ? 'var(--accent-soft)' : evenBg,
                      userSelect: 'none',
                      position: 'sticky', left: 0, zIndex: 1,
                      minWidth: 36,
                    }}
                  >
                    {ri + 1}
                  </td>

                  {/* data cells */}
                  {headers.map((h, ci) => {
                    const isSel = sel.has(cellKey(ri, ci));
                    const val = row[h];
                    const num = typeof val === 'number' || (!isNaN(parseFloat(val)) && val != null && val !== '');

                    return (
                      <td
                        key={h}
                        onMouseDown={e => handleCellMouseDown(ri, ci, e)}
                        onMouseEnter={() => handleCellMouseEnter(ri, ci)}
                        style={{
                          padding: cellPad,
                          borderBottom: '1px solid var(--row-sep)',
                          borderRight: ci < headers.length - 1 ? '1px solid var(--col-sep)' : 'none',
                          textAlign: num ? 'right' : 'left',
                          fontFamily: num ? 'var(--font-mono)' : 'var(--font-body)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          width: colWidths[h] || defaultColWidth(h),
                          maxWidth: colWidths[h] || defaultColWidth(h),
                          fontSize: compact ? 11 : 12,
                          cursor: 'cell',
                          position: 'relative',
                          // selection style
                          background: isSel
                            ? 'rgba(59,130,246,0.18)'
                            : rowAllSel
                            ? 'rgba(59,130,246,0.07)'
                            : evenBg,
                          color: isSel ? 'var(--text)' : num ? 'var(--text)' : 'var(--text2)',
                          outline: isSel ? '1px solid rgba(59,130,246,0.5)' : 'none',
                          outlineOffset: '-1px',
                          // sticky first col
                          ...(stickyFirstCol && ci === 0 ? { position: 'sticky', left: 36, zIndex: 1, background: isSel ? 'rgba(59,130,246,0.18)' : evenBg } : {}),
                        }}
                      >
                        {fmtVal(val, h)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── keyboard hint ── */}
      <div style={{ fontSize: 10, color: 'var(--text4)' }}>
        Click to select · Shift+click range · Ctrl+click multi · Drag column edge to resize · Ctrl+C copy
      </div>
    </div>
  );
}
