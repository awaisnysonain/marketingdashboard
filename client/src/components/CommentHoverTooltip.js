import React from 'react';
import { createPortal } from 'react-dom';

const MAX_LEN = 200;

function truncateText(text, max = MAX_LEN) {
  const s = text || '';
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max).trimEnd()}…`, truncated: true };
}

/**
 * Styled hover preview for cell/KPI comments.
 * Only render when `comment` is non-null (API already filters private notes for non-authors).
 */
export default function CommentHoverTooltip({ comment, anchorRect, visible }) {
  if (!visible || !comment || !anchorRect) return null;

  const { text, truncated } = truncateText(comment.comment_text);
  const isPrivate = comment.visibility === 'private';
  const canEdit = comment.can_edit !== false;

  const maxWidth = 300;
  const left = Math.min(
    Math.max(8, anchorRect.left),
    window.innerWidth - maxWidth - 12,
  );
  const belowTop = anchorRect.bottom + 8;
  const showAbove = belowTop + 140 > window.innerHeight - 12;
  const top = showAbove ? anchorRect.top - 8 : belowTop;

  return createPortal(
    <div
      role="tooltip"
      style={{
        position: 'fixed',
        left,
        top,
        transform: showAbove ? 'translateY(-100%)' : undefined,
        zIndex: 10001,
        maxWidth,
        minWidth: 180,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--border2)',
        background: 'var(--bg3)',
        color: 'var(--text)',
        boxShadow: '0 16px 48px rgba(0,0,0,.45)',
        pointerEvents: 'none',
        userSelect: 'text',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>
          {comment.author_name || 'Unknown'}
        </span>
        {isPrivate && (
          <span style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 4,
            background: 'rgba(99,102,241,.15)', color: 'var(--accent)', fontWeight: 600,
          }}
          >
            Private
          </span>
        )}
      </div>
      <div style={{
        fontSize: 12,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text)',
        maxHeight: 120,
        overflowY: truncated ? 'auto' : 'visible',
      }}
      >
        {text}
      </div>
      {canEdit && (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text4)' }}>
          Click dot or right-click to edit
        </div>
      )}
    </div>,
    document.body,
  );
}
