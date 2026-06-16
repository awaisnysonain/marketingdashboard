import React, { useCallback, useMemo, useRef, useState } from 'react';
import CommentAnchor from './CommentAnchor';
import CommentHoverTooltip from './CommentHoverTooltip';
import SheetSelectionBar from './SheetSelectionBar';
import { commentTargetKey } from '../utils/commentKeys';
import { useComments } from './CommentProvider';
import useSheetCellSelection, { sheetCellStyle } from '../hooks/useSheetCellSelection';
import { formatMetricValue, rawMetricValue } from '../utils/formatMetric';

function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(mo, 10) - 1]} ${parseInt(dy, 10)}`;
}

function fmtVal(v, type, metricKey, label) {
  return formatMetricValue(v, type, { metricKey, label });
}

function rawVal(v, type, metricKey, label) {
  return rawMetricValue(v, type, { metricKey, label });
}

/**
 * Vertical metrics-by-date table with Overview-style cell selection and comments.
 */
export default function VerticalDataTable({ dates, getRow, metrics, tableScope = 'summary', commentsEnabled = true }) {
  const comments = useComments();
  const tableRef = useRef(null);
  const [commentHover, setCommentHover] = useState(null);

  const reversedDates = useMemo(() => [...dates].reverse(), [dates]);

  const cellMeta = useMemo(() => (
    reversedDates.map((d) => metrics.map((m) => ({
      key: commentTargetKey(tableScope, m.key, d),
      label: `${tableScope} · ${m.label} · ${d}`,
      date: d,
      metric: m,
      copyStr: rawVal(getRow(d)?.[m.key], m.type, m.key, m.label) || fmtVal(getRow(d)?.[m.key], m.type, m.key, m.label),
    })))
  ), [reversedDates, metrics, tableScope, getRow]);

  const getCopyValue = useCallback((ri, ci) => cellMeta[ri]?.[ci]?.copyStr ?? '', [cellMeta]);

  const selection = useSheetCellSelection({
    rowCount: reversedDates.length,
    colCount: metrics.length,
    getCopyValue,
  });

  const commentTargets = useMemo(() => {
    if (!commentsEnabled || !comments) return [];
    const targets = [];
    for (const k of selection.sel) {
      const [ri, ci] = k.split(':').map(Number);
      const meta = cellMeta[ri]?.[ci];
      if (meta) targets.push({ key: meta.key, label: meta.label });
    }
    return targets;
  }, [selection.sel, cellMeta, commentsEnabled, comments]);

  return (
    <div style={{ position: 'relative' }} ref={tableRef}>
      <SheetSelectionBar
        selSize={selection.sel.size}
        selNums={selection.selNums}
        selSum={selection.selSum}
        selAvg={selection.selAvg}
        onClear={selection.clearSelection}
        commentTargets={commentTargets}
        commentLabel={`${tableScope} · ${selection.sel.size} cells`}
        anchorRect={() => {
          const rect = tableRef.current?.getBoundingClientRect();
          return rect
            ? { top: rect.top + 40, bottom: rect.top + 46, left: rect.left + 20, right: rect.left + 320 }
            : { top: 80, bottom: 86, left: 20, right: 320 };
        }}
      />

      <div
        onMouseUp={selection.handleMouseUp}
        onMouseLeave={selection.handleMouseUp}
        style={{ overflowX: 'auto' }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, userSelect: 'none' }}>
          <thead>
            <tr style={{ background: 'var(--bg3)' }}>
              <th style={{
                padding: '9px 12px', textAlign: 'left', borderBottom: '2px solid var(--border)',
                color: 'var(--text3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '.05em', whiteSpace: 'nowrap', position: 'sticky', left: 0,
                background: 'var(--bg3)', zIndex: 2, minWidth: 90,
              }}
              >
                Date
              </th>
              {metrics.map((m) => (
                <th
                  key={m.key}
                  title={m.tip || undefined}
                  style={{
                    padding: '9px 12px', textAlign: 'right', borderBottom: '2px solid var(--border)',
                    color: 'var(--text3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '.05em', whiteSpace: 'nowrap', cursor: m.tip ? 'help' : undefined,
                  }}
                >
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reversedDates.map((d, di) => {
              const row = getRow(d);
              const evenBg = di % 2 === 1 ? 'var(--bg3)' : 'var(--bg2)';
              const rowAllSel = metrics.every((_, ci) => selection.isSelected(di, ci));

              return (
                <tr key={d} style={{ background: evenBg }}>
                  <td style={{
                    padding: '8px 12px', fontWeight: 600, color: 'var(--text)',
                    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
                    position: 'sticky', left: 0, background: evenBg, zIndex: 1, fontSize: 11,
                  }}
                  >
                    {fmtDateLabel(d)}
                  </td>
                  {metrics.map((m, colIdx) => {
                    const display = fmtVal(row?.[m.key], m.type, m.key, m.label);
                    const meta = cellMeta[di][colIdx];
                    const isSel = selection.isSelected(di, colIdx);
                    const cellComment = commentsEnabled ? comments?.getForTarget('cell', meta.key) : null;
                    const hasComment = !!cellComment;

                    const cellContent = (
                      <span style={{ fontVariantNumeric: 'tabular-nums', display: 'block', width: '100%', textAlign: 'right', userSelect: 'text' }}>
                        {display}
                      </span>
                    );

                    return (
                      <td
                        key={m.key}
                        onMouseDown={(e) => selection.handleCellMouseDown(di, colIdx, e)}
                        onMouseEnter={(e) => {
                          selection.handleCellMouseEnter(di, colIdx);
                          if (cellComment) {
                            setCommentHover({ comment: cellComment, rect: e.currentTarget.getBoundingClientRect() });
                          }
                        }}
                        onMouseLeave={() => setCommentHover(null)}
                        style={{
                          padding: `8px ${hasComment ? 20 : 12}px 8px 12px`,
                          textAlign: 'right', borderBottom: '1px solid var(--border)',
                          color: 'var(--text)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                          position: 'relative', cursor: 'cell',
                          ...sheetCellStyle(isSel, rowAllSel, evenBg),
                        }}
                      >
                        {commentsEnabled ? (
                          <CommentAnchor
                            targetType="cell"
                            targetKey={meta.key}
                            targetLabel={meta.label}
                          >
                            {cellContent}
                          </CommentAnchor>
                        ) : cellContent}
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

      <div style={{ fontSize: 10, color: 'var(--text4)', marginTop: 8 }}>
        Click to select · Shift+click range · Ctrl+click multi · Drag to paint · Ctrl+C copy · Right-click for comment
      </div>
    </div>
  );
}
