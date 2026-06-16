import React, { useCallback } from 'react';
import { useToast } from './ToastProvider';

/**
 * Wraps a display value with selectable text and optional click-to-copy.
 * Skips copy when the user has an active text selection (native copy still works).
 */
export default function CopyableValue({
  children,
  copyValue,
  clickToCopy = true,
  className,
  style,
  title,
  as: Tag = 'span',
  onCopy,
}) {
  const toast = useToast();

  const textToCopy = copyValue != null ? String(copyValue) : (typeof children === 'string' || typeof children === 'number' ? String(children) : '');

  const doCopy = useCallback(async () => {
    if (!textToCopy) return;
    if (onCopy) {
      onCopy(textToCopy);
      return;
    }
    try {
      await navigator.clipboard.writeText(textToCopy);
      toast?.success('Copied!');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = textToCopy;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        toast?.success('Copied!');
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, [textToCopy, toast, onCopy]);

  function handleClick(e) {
    if (!clickToCopy || !textToCopy) return;
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    e.stopPropagation();
    doCopy();
  }

  return (
    <Tag
      className={className}
      title={title || (clickToCopy ? 'Click to copy' : undefined)}
      onClick={clickToCopy ? handleClick : undefined}
      style={{
        userSelect: 'text',
        WebkitUserSelect: 'text',
        cursor: clickToCopy ? 'copy' : 'text',
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
