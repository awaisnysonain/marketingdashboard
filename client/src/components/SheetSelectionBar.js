import React, { useState } from 'react';
import CommentPopover from './CommentPopover';
import { useComments } from './CommentProvider';
import { useToast } from './ToastProvider';
import { formatAggValue, aggShowsSum } from '../utils/formatMetric';

/**
 * Floating selection toolbar — count, sum/avg, Comment, clear.
 */
export default function SheetSelectionBar({
  selSize,
  selNums,
  selSum,
  selAvg,
  onClear,
  commentTargets,
  commentLabel,
  anchorRect,
  inline = false,
  aggKind = null,
}) {
  const comments = useComments();
  const toast = useToast();
  const [popover, setPopover] = useState(null);

  const commentsEnabled = comments && commentTargets?.length > 0;

  function openComment() {
    if (!commentsEnabled) return;
    const rect = anchorRect?.() || { top: 80, bottom: 86, left: 20, right: 320 };
    setPopover({
      anchorRect: rect,
      label: commentLabel || `${commentTargets.length} cells`,
      targets: commentTargets,
    });
  }

  const barStyle = inline ? {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '3px 10px', background: 'var(--accent-dim)',
    border: '1px solid var(--accent)', borderRadius: 20,
    fontSize: 11,
  } : {
    position: 'sticky',
    top: 0,
    zIndex: 5,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
    padding: '8px 12px',
    background: 'var(--bg3)',
    border: '1px solid var(--accent)',
    borderRadius: 8,
    fontSize: 12,
  };

  if (selSize === 0) return null;

  return (
    <>
      <div style={barStyle}>
        <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
          {selSize} cell{selSize !== 1 ? 's' : ''}
        </span>
        {selNums?.length > 0 && (
          <>
            {aggShowsSum(aggKind) && selSum != null && (
              <>
                <span style={{ color: 'var(--text3)' }}>|</span>
                <span style={{ color: 'var(--text2)' }}>
                  Sum: <strong>{formatAggValue(selSum, aggKind)}</strong>
                </span>
              </>
            )}
            {selAvg != null && (
              <>
                <span style={{ color: 'var(--text3)' }}>|</span>
                <span style={{ color: 'var(--text2)' }}>
                  Avg: <strong>{formatAggValue(selAvg, aggKind)}</strong>
                </span>
              </>
            )}
          </>
        )}
        {commentsEnabled && (
          <button
            type="button"
            onClick={openComment}
            style={{
              background: 'var(--accent)', border: 'none', borderRadius: 6,
              padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: '#fff', fontWeight: 600,
            }}
          >
            Comment
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            color: inline ? 'var(--accent)' : 'var(--text3)',
            cursor: 'pointer',
            fontSize: inline ? 14 : 11,
            lineHeight: 1,
            padding: 0,
          }}
          title="Clear selection (Esc)"
        >
          {inline ? '×' : 'Clear'}
        </button>
      </div>

      {popover && comments && (
        <CommentPopover
          anchorRect={popover.anchorRect}
          targetLabel={popover.label}
          existing={null}
          onSave={async (text, visibility) => {
            for (const t of popover.targets) {
              const existing = comments.getForTarget('cell', t.key);
              await comments.saveComment('cell', t.key, text, existing, { visibility });
            }
            toast?.success(
              popover.targets.length === 1 ? 'Comment added' : `Comment added to ${popover.targets.length} cells`,
            );
            setPopover(null);
            onClear();
          }}
          onClose={() => setPopover(null)}
        />
      )}
    </>
  );
}
