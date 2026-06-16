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
}) {
  const fs = size === 'lg' ? 24 : size === 'sm' ? 16 : 20;
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

  return (
    <div
      onClick={onClick}
      title={tooltip || undefined}
      style={{
        background: 'var(--card-bg)',
        border: '1px solid var(--card-border)',
        borderRadius: 'var(--radius-lg)',
        padding: size === 'sm' ? '11px 14px' : '15px 18px',
        cursor: onClick ? 'pointer' : tooltip ? 'help' : 'default',
        transition: 'border-color .15s',
        position: 'relative',
      }}
      onMouseEnter={e => { if (onClick || tooltip) e.currentTarget.style.borderColor = 'var(--border3)'; if (tooltip) setShowTip(true); }}
      onMouseLeave={e => { if (onClick || tooltip) e.currentTarget.style.borderColor = 'var(--card-border)'; if (tooltip) setShowTip(false); setHeaderHovered(false); }}
      onFocus={tooltip ? () => setShowTip(true) : undefined}
      onBlur={tooltip ? () => setShowTip(false) : undefined}
      tabIndex={tooltip ? 0 : undefined}
      onContextMenu={commentEnabled ? (e) => {
        e.preventDefault();
        commentRef.current?.open();
      } : undefined}
    >
      <div
        ref={headerRef}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 7,
          minHeight: 16,
        }}
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
        <div style={{ flex: 1, fontSize: 11, fontWeight: 500, color: 'var(--text3)', letterSpacing: '.2px', userSelect: 'text' }}>
          {label}
        </div>
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
        style={{
          fontSize: fs, fontWeight: 600, lineHeight: 1.15,
          color: 'var(--text)', fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          display: 'block',
          paddingRight: commentEnabled ? 2 : 0,
        }}
      >
        {displayValue}
      </CopyableValue>
      {(subValue || sub) && (
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 5, fontFamily: 'var(--font-mono)', userSelect: 'text' }}>
          <CopyableValue copyValue={subValue || sub} clickToCopy={!!(subValue || sub)}>
            {subValue || sub}
          </CopyableValue>
        </div>
      )}
      {trend !== undefined && !isNaN(trendNum) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 3, marginTop: 7,
          fontSize: 11, fontWeight: 500,
          color: isPos ? 'var(--success)' : isNeg ? 'var(--danger)' : 'var(--text3)',
          userSelect: 'text',
        }}>
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
