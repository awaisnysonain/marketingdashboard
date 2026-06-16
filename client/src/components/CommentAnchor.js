import React, { useState } from 'react';
import CommentPopover from './CommentPopover';
import { useComments } from './CommentProvider';
import { useToast } from './ToastProvider';

const dotStyle = {
  display: 'block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#f59e0b',
  boxShadow: '0 0 0 1px var(--bg2)',
};

const iconBtnBase = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  lineHeight: 1,
};

function mergeRefs(...refs) {
  return (node) => {
    refs.forEach((ref) => {
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    });
  };
}

function CommentIcon({ size = 14, color = 'var(--text4)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 3.5A1.5 1.5 0 0 1 4 2h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 10H6.5L3.5 12.5V10A1.5 1.5 0 0 1 2.5 8.5v-5Z"
        stroke={color}
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Comment affordance — orange dot when a comment exists; right-click or icon to add/view.
 * placement="header": inline icon next to labels (KPI cards).
 * placement="corner": wraps cell content; dot in padding corner, never on the value.
 */
const CommentAnchor = React.forwardRef(function CommentAnchor({
  targetType,
  targetKey,
  targetLabel,
  children,
  style,
  className,
  forceOpen,
  onForceOpenHandled,
  placement = 'corner',
  showIdleIcon = false,
  showIndicator = true,
}, ref) {
  const comments = useComments();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [anchorRect, setAnchorRect] = useState(null);
  const wrapRef = React.useRef(null);

  React.useEffect(() => {
    if (forceOpen && wrapRef.current) {
      setAnchorRect(wrapRef.current.getBoundingClientRect());
      setOpen(true);
      onForceOpenHandled?.();
    }
  }, [forceOpen, onForceOpenHandled]);

  if (!targetType || !targetKey || !comments) {
    if (placement === 'header') return null;
    return <span className={className} style={style}>{children}</span>;
  }

  const existing = comments.getForTarget(targetType, targetKey);
  const hasComment = !!existing;

  function openPopover(e) {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setAnchorRect(rect);
    setOpen(true);
  }

  React.useImperativeHandle(ref, () => ({ open: () => openPopover() }), []);

  function handleContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    openPopover(e);
  }

  const affordance = (
    <button
      type="button"
      onClick={openPopover}
      title={placement === 'header' ? (hasComment ? existing.comment_text : 'Add comment (right-click)') : undefined}
      aria-label={hasComment ? 'View comment' : 'Add comment'}
      style={{
        ...iconBtnBase,
        width: placement === 'header' ? 18 : 14,
        height: placement === 'header' ? 18 : 14,
        opacity: placement === 'header'
          ? (hasComment || hovered || showIdleIcon ? 1 : 0.35)
          : (hasComment ? 1 : 0),
      }}
    >
      {hasComment ? <span style={dotStyle} /> : <CommentIcon size={placement === 'header' ? 14 : 12} />}
    </button>
  );

  const popover = open && anchorRect && (
    <CommentPopover
      anchorRect={anchorRect}
      targetLabel={targetLabel || `${targetType} · ${targetKey}`}
      existing={existing}
      onSave={async (text, visibility) => {
        await comments.saveComment(targetType, targetKey, text, existing, { visibility });
        toast?.success(existing?.id ? 'Comment saved' : 'Comment added');
      }}
      onDelete={async (id) => {
        await comments.removeComment(id);
        toast?.success('Comment removed');
      }}
      onClose={() => setOpen(false)}
    />
  );

  if (placement === 'header') {
    return (
      <>
        <span
          ref={wrapRef}
          className={className}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onContextMenu={handleContextMenu}
          style={{ display: 'inline-flex', alignItems: 'center', ...style }}
        >
          {affordance}
        </span>
        {popover}
      </>
    );
  }

  const cornerDot = showIndicator && hasComment ? (
    <button
      type="button"
      onClick={openPopover}
      aria-label="View comment"
      style={{
        ...iconBtnBase,
        position: 'absolute',
        top: 4,
        right: 4,
        width: 14,
        height: 14,
        zIndex: 2,
      }}
    >
      <span style={dotStyle} />
    </button>
  ) : null;

  if (children) {
    const child = React.Children.only(children);
    return (
      <>
        {React.cloneElement(child, {
          ref: mergeRefs(wrapRef, child.ref),
          className: [child.props.className, className].filter(Boolean).join(' ') || undefined,
          onContextMenu: (e) => {
            child.props.onContextMenu?.(e);
            handleContextMenu(e);
          },
          style: { ...child.props.style, ...style },
        })}
        {cornerDot}
        {popover}
      </>
    );
  }

  return (
    <>
      <span
        ref={wrapRef}
        className={className}
        onContextMenu={handleContextMenu}
        aria-hidden
        style={{ position: 'absolute', inset: 0, zIndex: 0, ...style }}
      />
      {cornerDot}
      {popover}
    </>
  );
});

export default CommentAnchor;
