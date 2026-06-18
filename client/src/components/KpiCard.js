import React from 'react';
import CopyableValue from './CopyableValue';
import CommentAnchor from './CommentAnchor';
import CommentHoverTooltip from './CommentHoverTooltip';
import { useComments } from './CommentProvider';

function fmtV(value, prefix, suffix) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' && /[$%,x]/.test(value)) return `${prefix || ''}${value}${suffix || ''}`;
  const s = typeof value === 'number'
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0, minimumFractionDigits: 0 })
    : String(value);
  return `${prefix || ''}${s}${suffix || ''}`;
}

/** Named accent colors (also accepts a raw color string). */
const ACCENT_MAP = {
  nobl: 'var(--nobl)',
  flo: 'var(--flo)',
  accent: 'var(--accent)',
  green: 'var(--success)',
  success: 'var(--success)',
  teal: '#0f9b8e',
  purple: '#8b5cf6',
  indigo: '#6366f1',
  amber: 'var(--warn)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  red: 'var(--danger)',
};

function resolveAccent(accent, color) {
  const key = accent || color;
  if (!key) return null;
  return ACCENT_MAP[key] || key; // raw color falls through
}

export default function KpiCard({
  label,
  value,
  fullValue,
  subValue,
  sub,
  trend,
  trendLabel,
  prefix,
  suffix,
  size = 'md',
  onClick,
  tooltip,
  commentTarget,
  copyValue,
  accent,
  color,
}) {
  const fs = size === 'lg' ? 27 : size === 'sm' ? 17 : 21;
  const trendNum = parseFloat(trend);
  const isPos = !isNaN(trendNum) && trendNum > 0;
  const isNeg = !isNaN(trendNum) && trendNum < 0;
  const [showTip, setShowTip] = React.useState(false);
  const [headerHovered, setHeaderHovered] = React.useState(false);
  const [commentHover, setCommentHover] = React.useState(null);
  const commentRef = React.useRef(null);
  const headerRef = React.useRef(null);
  const comments = useComments();

  const displayValue = fmtV(value, prefix, suffix);
  const textToCopy = copyValue != null ? String(copyValue) : (fullValue != null ? String(fullValue) : displayValue);
  const commentEnabled = commentTarget && comments;
  const cellComment = commentEnabled
    ? comments.getForTarget(commentTarget.targetType || 'kpi', commentTarget.targetKey)
    : null;
  const accentColor = resolveAccent(accent, color);

  const cls = ['kpi'];
  if (onClick) cls.push('kpi--clickable', 'kpi--hoverable');
  else if (tooltip) cls.push('kpi--hoverable');

  return (
    <div
      onClick={onClick}
      title={tooltip || undefined}
      className={cls.join(' ')}
      style={{
        paddingTop: accentColor ? 16 : undefined,
        cursor: onClick ? 'pointer' : tooltip ? 'help' : 'default',
      }}
      onMouseEnter={() => { if (tooltip) setShowTip(true); }}
      onMouseLeave={() => { if (tooltip) setShowTip(false); setHeaderHovered(false); }}
      onFocus={tooltip ? () => setShowTip(true) : undefined}
      onBlur={tooltip ? () => setShowTip(false) : undefined}
      tabIndex={tooltip ? 0 : undefined}
      onContextMenu={commentEnabled ? (e) => {
        e.preventDefault();
        commentRef.current?.open();
      } : undefined}
    >
      {accentColor && <div className="kpi__accent" style={{ background: accentColor }} />}

      <div
        ref={headerRef}
        className="kpi__head"
        onMouseEnter={() => {
          setHeaderHovered(true);
          if (cellComment && headerRef.current) {
            setCommentHover({ comment: cellComment, rect: headerRef.current.getBoundingClientRect() });
          }
        }}
        onMouseLeave={() => {
          setHeaderHovered(false);
          setCommentHover(null);
        }}
      >
        <div className="kpi__label">{label}</div>
        {commentEnabled && (
          <CommentAnchor
            ref={commentRef}
            placement="header"
            showIdleIcon={headerHovered}
            targetType={commentTarget.targetType || 'kpi'}
            targetKey={commentTarget.targetKey}
            targetLabel={commentTarget.targetLabel || `${label} KPI`}
          />
        )}
      </div>

      <CopyableValue
        copyValue={textToCopy}
        title={fullValue || undefined}
        className="kpi__value"
        style={{ fontSize: fs, paddingRight: commentEnabled ? 2 : 0 }}
      >
        {displayValue}
      </CopyableValue>

      {(subValue || sub) && (
        <div className="kpi__sub">
          <CopyableValue copyValue={subValue || sub} clickToCopy={!!(subValue || sub)}>
            {subValue || sub}
          </CopyableValue>
        </div>
      )}

      {trend !== undefined && !isNaN(trendNum) && (
        <div
          className="kpi__trend"
          style={{ color: isPos ? 'var(--success)' : isNeg ? 'var(--danger)' : 'var(--text3)' }}
        >
          <span style={{ fontSize: 8 }}>{isPos ? '▲' : isNeg ? '▼' : '—'}</span>
          <CopyableValue copyValue={`${Math.round(Math.abs(trendNum))}%`}>
            <span>{Math.round(Math.abs(trendNum))}%</span>
          </CopyableValue>
          {trendLabel && <span style={{ color: 'var(--text3)', fontWeight: 400 }}>{trendLabel}</span>}
        </div>
      )}

      {tooltip && showTip && (
        <div style={{
          position: 'absolute',
          left: 12,
          top: 'calc(100% + 8px)',
          zIndex: 1000,
          width: 300,
          maxWidth: 'min(300px, calc(100vw - 32px))',
          padding: '10px 12px',
          borderRadius: 10,
          background: 'var(--bg2)',
          border: '1px solid var(--border2)',
          boxShadow: 'var(--shadow)',
          color: 'var(--text2)',
          fontSize: 11,
          lineHeight: 1.45,
          whiteSpace: 'pre-line',
          pointerEvents: 'none',
          userSelect: 'text',
        }}>
          {tooltip}
        </div>
      )}
      <CommentHoverTooltip
        comment={commentHover?.comment}
        anchorRect={commentHover?.rect}
        visible={!!commentHover}
      />
    </div>
  );
}
