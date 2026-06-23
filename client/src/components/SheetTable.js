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
import { fmtCell } from '../utils/api';
import { COLUMN_TIP } from '../copy/plainLanguage';
import TableFilterBar from './TableFilterBar';
import CommentAnchor from './CommentAnchor';
import CommentHoverTooltip from './CommentHoverTooltip';
import SheetSelectionBar from './SheetSelectionBar';
import ForecastHoverTooltip from './ForecastHoverTooltip';
import { ForecastVariancePill } from './ForecastIndicator';
import { FORECAST_STATUS_STYLE } from '../hooks/useDailyForecast';
import { useComments } from './CommentProvider';
import { SEARCH_ALL_COLUMNS } from '../constants/tableSearch';
import { filterTableRows } from '../utils/tableFilterSort';
import useSheetCellSelection, { sheetCellStyle } from '../hooks/useSheetCellSelection';

// ─── helpers ─────────────────────────────────────────────────────────────────
function fmtVal(v, header) {
  if (v == null || v === '') return '—';
  return fmtCell(v, header);
}

function isNumeric(v) {
  return v != null && v !== '' && !isNaN(parseFloat(v));
}

/** Classify a daily row as past/today/tomorrow/future for rolling forecast highlighting. */
function rowDayRole(dateStr) {
  if (!dateStr || typeof dateStr !== 'string' || dateStr.length < 10) return 'past';
  const today = new Date();
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const tom = new Date(today.getTime() + 86400000);
  const m = `${tom.getFullYear()}-${String(tom.getMonth() + 1).padStart(2, '0')}-${String(tom.getDate()).padStart(2, '0')}`;
  const d = dateStr.slice(0, 10);
  if (d === t) return 'today';
  if (d === m) return 'tomorrow';
  if (d > t) return 'future';
  return 'past';
}

const ROW_DAY_BG = {
  today:    'rgba(53,28,117,0.08)',  // matches Apps Script "today projected" purple
  tomorrow: 'rgba(53,28,117,0.05)',
  future:   'rgba(31,78,120,0.04)',
};

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

// ─── component ───────────────────────────────────────────────────────────────
export default function SheetTable({
  headers = [],            // string[] — visible column names
  rows = [],               // object[] — data rows
  keyField = null,         // string — unique field for row key (falls back to index)
  maxHeight = '480px',
  scrollable = true,
  searchable = true,
  hideRowCount = false,
  defaultSortField = null,
  defaultSortDir = 'desc',
  sortBy: controlledSortBy = null,
  sortDir: controlledSortDir = null,
  onSort: controlledOnSort = null,
  onRowClick = null,       // (row) => void — optional row click handler
  stickyFirstCol = false,  // freeze first column
  compact = false,
  getCellCommentKey = null,   // (row, header, ri, ci) => string | null
  getCellCommentLabel = null, // (row, header) => string
  commentsEnabled = null,     // default: true when getCellCommentKey + CommentProvider
  cellStatus = null,          // (date, header, value, row) => { status, variancePct, forecast, ... } | null
  dateField = '_date',        // row field that yields the date for forecast lookup
}) {
  // ── search & sort
  const [search, setSearch] = useState('');
  const [searchColumn, setSearchColumn] = useState(SEARCH_ALL_COLUMNS);
  const [internalSortBy, setInternalSortBy] = useState(defaultSortField || null);
  const [internalSortDir, setInternalSortDir] = useState(defaultSortDir);
  const sortControlled = controlledOnSort != null;
  const sortBy = sortControlled ? controlledSortBy : internalSortBy;
  const sortDir = sortControlled ? (controlledSortDir || 'desc') : internalSortDir;

  const [colWidths, setColWidths] = useState({});
  const [hoverCell, setHoverCell] = useState(null);
  const [commentHover, setCommentHover] = useState(null);
  const [forecastHover, setForecastHover] = useState(null);
  const resizeRef = useRef(null);
  const tableRef = useRef(null);
  const comments = useComments();
  const commentsOn = commentsEnabled ?? (!!getCellCommentKey && !!comments);

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

  // ── filter (skipped when parent pre-filters, e.g. PaginatedSheetTable)
  const filtered = searchable && search
    ? filterTableRows(rows, headers, search, searchColumn)
    : rows;

  // ── sort (skipped when parent pre-sorts)
  const sorted = sortControlled
    ? filtered
    : sortBy
      ? [...filtered].sort((a, b) => {
          const va = a[sortBy], vb = b[sortBy];
          if (va == null) return 1; if (vb == null) return -1;
          const textColumn = ['brand', 'campaign', 'ad set', 'ad'].includes(String(sortBy).toLowerCase()) || /(^|\s)id($|\s)/.test(String(sortBy).toLowerCase());
          const na = typeof va === 'number' ? va : Number(String(va).trim());
          const nb = typeof vb === 'number' ? vb : Number(String(vb).trim());
          if (!textColumn && Number.isFinite(na) && Number.isFinite(nb)) return sortDir === 'asc' ? na - nb : nb - na;
          return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
        })
      : filtered;

  function handleSort(h) {
    if (sortControlled) {
      controlledOnSort(h);
      return;
    }
    if (sortBy === h) setInternalSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setInternalSortBy(h); setInternalSortDir('asc'); }
  }

  const getCopyValue = useCallback((ri, ci) => {
    const row = sorted[ri];
    return row ? (row[headers[ci]] ?? '') : '';
  }, [sorted, headers]);

  const selection = useSheetCellSelection({
    rowCount: sorted.length,
    colCount: headers.length,
    getCopyValue,
  });

  const commentTargets = React.useMemo(() => {
    if (!commentsOn) return [];
    const targets = [];
    for (const k of selection.sel) {
      const [ri, ci] = k.split(':').map(Number);
      const row = sorted[ri];
      const header = headers[ci];
      if (!row || !header) continue;
      const key = getCellCommentKey?.(row, header, ri, ci);
      if (!key) continue;
      const label = getCellCommentLabel?.(row, header) || `${header} · ${row._date || row.Date || row.date || ri + 1}`;
      targets.push({ key, label });
    }
    return targets;
  }, [selection.sel, sorted, headers, getCellCommentKey, getCellCommentLabel, commentsOn]);

  function selectCol(ci, e) {
    selection.selectCol(ci, e, () => handleSort(headers[ci]));
  }

  function positionHover(e) {
    const maxWidth = 520;
    const left = Math.min(e.clientX + 14, Math.max(12, window.innerWidth - maxWidth - 12));
    const top = Math.min(e.clientY + 16, Math.max(12, window.innerHeight - 220));
    return { left, top };
  }

  function showCellHover(e, row, header, rowIndex) {
    if (selection.dragging || resizeRef.current) return;
    const raw = row?.[header];
    setHoverCell({
      ...positionHover(e),
      header,
      rowIndex: rowIndex + 1,
      formatted: fmtVal(raw, header),
      raw: raw == null || raw === '' ? '—' : String(raw),
    });
  }

  function moveCellHover(e) {
    if (!hoverCell || selection.dragging || resizeRef.current) return;
    setHoverCell(prev => prev ? { ...prev, ...positionHover(e) } : prev);
  }

  function hideCellHover() { setHoverCell(null); }

  function hideCommentHover() { setCommentHover(null); }

  function startColumnResize(e, header) {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      header,
      startX: e.clientX,
      startWidth: colWidths[header] || defaultColWidth(header),
    };
  }

  // ── detect numeric columns for alignment
  function isNumCol(h) {
    const sample = sorted.slice(0,8).map(r=>r[h]).filter(v=>v!=null&&v!=='');
    return sample.length > 0 && sample.every(v => !isNaN(parseFloat(v)));
  }

  const cellPad = compact ? '4px 8px' : '6px 10px';

  return (
      <div
        onMouseUp={selection.handleMouseUp}
        onMouseLeave={() => { selection.handleMouseUp(); hideCellHover(); hideCommentHover(); }}
        style={{ userSelect: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}
      >
      {/* ── toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {searchable && (
          <TableFilterBar
            headers={headers}
            searchColumn={searchColumn}
            onSearchColumnChange={setSearchColumn}
            search={search}
            onSearchChange={setSearch}
          />
        )}

        {/* row count */}
        {!hideRowCount && (
          <span style={{ fontSize: 11, color: 'var(--text4)', marginLeft: searchable ? 'auto' : 0 }}>
            {sorted.length.toLocaleString()} row{sorted.length !== 1 ? 's' : ''}
          </span>
        )}

        <SheetSelectionBar
          selSize={selection.sel.size}
          selNums={selection.selNums}
          selSum={selection.selSum}
          selAvg={selection.selAvg}
          onClear={selection.clearSelection}
          commentTargets={commentTargets}
          commentLabel={`${selection.sel.size} cells`}
          anchorRect={() => {
            const rect = tableRef.current?.getBoundingClientRect();
            return rect
              ? { top: rect.top + 8, bottom: rect.top + 14, left: rect.left + 12, right: rect.left + 312 }
              : { top: 80, bottom: 86, left: 20, right: 320 };
          }}
          inline
        />
      </div>

      {/* ── table ── */}
      <div
        ref={tableRef}
        style={{
          overflowX: 'auto',
          overflowY: scrollable ? 'auto' : 'visible',
          maxHeight: scrollable ? maxHeight : 'none',
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
                const allColSel = sorted.length > 0 && sorted.every((_, ri) => selection.isSelected(ri, ci));
                const someColSel = !allColSel && sorted.some((_, ri) => selection.isSelected(ri, ci));
                const isSort = sortBy === h;
                const num = isNumCol(h);
                return (
                  <th
                    key={h}
                    title={COLUMN_TIP[h] || undefined}
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
              const rowAllSel = headers.every((_, ci) => selection.isSelected(ri, ci));
              const rowDate = String(row?.[dateField] ?? row?._date ?? row?.Date ?? row?.date ?? '').slice(0, 10);
              const dayRole = cellStatus ? rowDayRole(rowDate) : 'past';
              const dayTint = ROW_DAY_BG[dayRole] || null;
              const evenBg = ri % 2 === 1 ? 'var(--bg3)' : 'var(--bg2)';

              return (
                <tr
                  key={keyField ? row[keyField] : ri}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={{ cursor: onRowClick ? 'pointer' : 'default', background: dayTint || undefined }}
                >
                  {/* row number */}
                  <td
                    onMouseDown={e => selection.selectRow(ri, e)}
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
                    const isSel = selection.isSelected(ri, ci);
                    const val = row[h];
                    const num = typeof val === 'number' || (!isNaN(parseFloat(val)) && val != null && val !== '');
                    const commentKey = commentsOn ? getCellCommentKey?.(row, h, ri, ci) : null;
                    const commentLabel = commentKey
                      ? (getCellCommentLabel?.(row, h) || `${h} · ${row._date || row.Date || row.date || ri + 1}`)
                      : null;
                    const cellComment = commentKey ? comments?.getForTarget('cell', commentKey) : null;
                    const hasComment = !!cellComment;

                    const fcStatus = cellStatus ? cellStatus(rowDate, h, val, row) : null;
                    const fcStyle = fcStatus ? FORECAST_STATUS_STYLE[fcStatus.status] : null;
                    const fcColor = fcStyle && fcStatus.status !== 'model' ? fcStyle.color : null;
                    const showFcDot = fcColor != null;
                    const showFcPill = fcStatus && fcStatus.variancePct != null && Number.isFinite(fcStatus.variancePct);

                    const cellInner = (
                      <span style={{ userSelect: 'text', WebkitUserSelect: 'text', display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: num ? 'flex-end' : 'flex-start', width: '100%' }}>
                        {showFcDot && (
                          <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: fcColor, flex: '0 0 auto' }} />
                        )}
                        <span>{fmtVal(val, h)}</span>
                        {showFcPill && <ForecastVariancePill pct={fcStatus.variancePct} statusOverride={fcStatus.status} />}
                      </span>
                    );

                    return (
                      <td
                        key={h}
                        onMouseDown={e => selection.handleCellMouseDown(ri, ci, e)}
                        onMouseEnter={(e) => {
                          selection.handleCellMouseEnter(ri, ci);
                          if (cellComment) {
                            hideCellHover();
                            setCommentHover({ comment: cellComment, rect: e.currentTarget.getBoundingClientRect() });
                          } else if (fcStatus && (fcStatus.forecast != null || fcStatus.variancePct != null)) {
                            hideCellHover();
                            hideCommentHover();
                            setForecastHover({ data: { date: rowDate, ...fcStatus }, rect: e.currentTarget.getBoundingClientRect() });
                          } else {
                            hideCommentHover();
                            showCellHover(e, row, h, ri);
                          }
                        }}
                        onMouseMove={(e) => {
                          if (commentHover) return;
                          moveCellHover(e);
                        }}
                        onMouseLeave={() => { hideCellHover(); hideCommentHover(); setForecastHover(null); }}
                        style={{
                          padding: cellPad,
                          paddingRight: hasComment ? 18 : undefined,
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
                          color: isSel ? 'var(--text)' : num ? 'var(--text)' : 'var(--text2)',
                          ...sheetCellStyle(isSel, rowAllSel, evenBg),
                          ...(stickyFirstCol && ci === 0 ? {
                            position: 'sticky', left: 36, zIndex: 1,
                            background: isSel ? 'rgba(59,130,246,0.18)' : evenBg,
                          } : {}),
                        }}
                      >
                        {commentKey ? (
                          <CommentAnchor
                            targetType="cell"
                            targetKey={commentKey}
                            targetLabel={commentLabel}
                          >
                            {cellInner}
                          </CommentAnchor>
                        ) : cellInner}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <CommentHoverTooltip
        comment={commentHover?.comment}
        anchorRect={commentHover?.rect}
        visible={!!commentHover}
      />

      <ForecastHoverTooltip
        data={forecastHover?.data}
        anchorRect={forecastHover?.rect}
        visible={!!forecastHover}
      />

      {hoverCell && (
        <div
          style={{
            position: 'fixed',
            left: hoverCell.left,
            top: hoverCell.top,
            zIndex: 9999,
            maxWidth: 520,
            minWidth: 220,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid var(--border2)',
            background: 'var(--bg)',
            color: 'var(--text)',
            boxShadow: '0 18px 48px rgba(0,0,0,.35)',
            pointerEvents: 'none',
            userSelect: 'text',
          }}
        >
          <div style={{ display:'flex', justifyContent:'space-between', gap:12, marginBottom:8, color:'var(--text3)', fontSize:10, textTransform:'uppercase', letterSpacing:'.06em' }}>
            <span>{hoverCell.header}</span>
            <span>Row {hoverCell.rowIndex}</span>
          </div>
          <div style={{ fontSize:13, lineHeight:1.45, whiteSpace:'pre-wrap', wordBreak:'break-word' }}>
            {hoverCell.raw}
          </div>
          {hoverCell.formatted !== hoverCell.raw && (
            <div style={{ marginTop:8, paddingTop:8, borderTop:'1px solid var(--border)', color:'var(--text3)', fontSize:11 }}>
              Formatted: <span style={{ color:'var(--text2)' }}>{hoverCell.formatted}</span>
            </div>
          )}
        </div>
      )}

      {/* ── keyboard hint ── */}
      <div style={{ fontSize: 10, color: 'var(--text4)' }}>
        Hover cell for full value · Click to select · Shift+click range · Ctrl+click multi · Drag to paint · Ctrl+C copy · Right-click for comment
      </div>
    </div>
  );
}
