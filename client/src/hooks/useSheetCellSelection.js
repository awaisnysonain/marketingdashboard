import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

export function cellKey(r, c) {
  return `${r}:${c}`;
}

export function expandRect(a, b) {
  return {
    r0: Math.min(a.r, b.r),
    r1: Math.max(a.r, b.r),
    c0: Math.min(a.c, b.c),
    c1: Math.max(a.c, b.c),
  };
}

export function rectCells(r0, r1, c0, c1) {
  const keys = new Set();
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      keys.add(cellKey(r, c));
    }
  }
  return keys;
}

export const SHEET_SEL_BG = 'rgba(59,130,246,0.18)';
export const SHEET_SEL_ROW_BG = 'rgba(59,130,246,0.07)';
export const SHEET_SEL_OUTLINE = '1px solid rgba(59,130,246,0.5)';

export function sheetCellStyle(isSel, rowAllSel, evenBg) {
  return {
    background: isSel ? SHEET_SEL_BG : rowAllSel ? SHEET_SEL_ROW_BG : evenBg,
    outline: isSel ? SHEET_SEL_OUTLINE : 'none',
    outlineOffset: '-1px',
  };
}

function isNumeric(v) {
  return v != null && v !== '' && !isNaN(parseFloat(v));
}

/**
 * Google Sheets-style cell selection shared by SheetTable and VerticalDataTable.
 */
export default function useSheetCellSelection({
  rowCount = 0,
  colCount = 0,
  getCopyValue,
  onCopy,
}) {
  const [sel, setSel] = useState(() => new Set());
  const [anchor, setAnchor] = useState(null);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef(null);

  const clearSelection = useCallback(() => {
    setSel(new Set());
    setAnchor(null);
  }, []);

  const setCellSelection = useCallback((ri, ci, e) => {
    const cell = { r: ri, c: ci };

    if (e.shiftKey && anchor) {
      const rect = expandRect(anchor, cell);
      setSel(rectCells(rect.r0, rect.r1, rect.c0, rect.c1));
    } else if (e.ctrlKey || e.metaKey) {
      const key = cellKey(ri, ci);
      setSel((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setAnchor(cell);
    } else {
      setSel(new Set([cellKey(ri, ci)]));
      setAnchor(cell);
    }
  }, [anchor]);

  const selectRow = useCallback((ri, e) => {
    e.stopPropagation();
    const lastCol = Math.max(0, colCount - 1);
    if (e.shiftKey && anchor) {
      const r0 = Math.min(anchor.r, ri);
      const r1 = Math.max(anchor.r, ri);
      setSel(rectCells(r0, r1, 0, lastCol));
    } else if (e.ctrlKey || e.metaKey) {
      const rowKeys = rectCells(ri, ri, 0, lastCol);
      setSel((prev) => {
        const next = new Set(prev);
        rowKeys.forEach((k) => next.add(k));
        return next;
      });
      setAnchor({ r: ri, c: 0 });
    } else {
      setSel(rectCells(ri, ri, 0, lastCol));
      setAnchor({ r: ri, c: 0 });
    }
  }, [anchor, colCount]);

  const selectCol = useCallback((ci, e, onSort) => {
    e.stopPropagation();
    onSort?.();
    const lastRow = Math.max(0, rowCount - 1);
    if (e.shiftKey && anchor) {
      const c0 = Math.min(anchor.c, ci);
      const c1 = Math.max(anchor.c, ci);
      setSel(rectCells(0, lastRow, c0, c1));
    } else {
      setSel(rectCells(0, lastRow, ci, ci));
      setAnchor({ r: 0, c: ci });
    }
  }, [anchor, rowCount]);

  const handleCellMouseDown = useCallback((ri, ci, e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(true);
    dragStart.current = { r: ri, c: ci };
    setCellSelection(ri, ci, e);
  }, [setCellSelection]);

  const handleCellMouseEnter = useCallback((ri, ci) => {
    if (!dragging || !dragStart.current) return;
    const rect = expandRect(dragStart.current, { r: ri, c: ci });
    setSel(rectCells(rect.r0, rect.r1, rect.c0, rect.c1));
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const isSelected = useCallback((ri, ci) => sel.has(cellKey(ri, ci)), [sel]);

  const selectionStats = useMemo(() => {
    if (!getCopyValue || sel.size === 0) {
      return { selNums: [], selSum: null, selAvg: null };
    }
    const selNums = [...sel].map((k) => {
      const [ri, ci] = k.split(':').map(Number);
      const raw = getCopyValue(ri, ci);
      return parseFloat(raw);
    }).filter((n) => !isNaN(n));

    const selSum = selNums.length ? selNums.reduce((a, b) => a + b, 0) : null;
    const selAvg = selNums.length ? selSum / selNums.length : null;
    return { selNums, selSum, selAvg };
  }, [sel, getCopyValue]);

  const buildTsv = useCallback(() => {
    if (!getCopyValue || sel.size === 0) return '';
    const selRows = new Set([...sel].map((k) => parseInt(k.split(':')[0], 10)));
    const selCols = new Set([...sel].map((k) => parseInt(k.split(':')[1], 10)));
    const sortedR = [...selRows].sort((a, b) => a - b);
    const sortedC = [...selCols].sort((a, b) => a - b);
    return sortedR.map((ri) =>
      sortedC.map((ci) => {
        if (!sel.has(cellKey(ri, ci))) return '';
        return getCopyValue(ri, ci) ?? '';
      }).join('\t'),
    ).join('\n');
  }, [sel, getCopyValue]);

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && sel.size > 0) {
        const tsv = buildTsv();
        if (!tsv) return;
        navigator.clipboard.writeText(tsv).then(() => {
          onCopy?.(sel.size);
        }).catch(() => {});
      }
      if (e.key === 'Escape') clearSelection();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sel, buildTsv, clearSelection, onCopy]);

  return {
    sel,
    anchor,
    dragging,
    clearSelection,
    setCellSelection,
    selectRow,
    selectCol,
    handleCellMouseDown,
    handleCellMouseEnter,
    handleMouseUp,
    isSelected,
    buildTsv,
    ...selectionStats,
  };
}
