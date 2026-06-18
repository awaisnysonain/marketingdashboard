import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function fmtWhen(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function CommentPopover({
  anchorRect,
  targetLabel,
  existing,
  onSave,
  onDelete,
  onClose,
}) {
  const [text, setText] = useState(existing?.comment_text || '');
  const [visibility, setVisibility] = useState(existing?.visibility || 'team');
  const [saving, setSaving] = useState(false);
  const popRef = useRef(null);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    function onDocClick(e) {
      if (popRef.current && !popRef.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);

  const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 280);
  const left = Math.min(anchorRect.left, window.innerWidth - 320);

  async function handleSave() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await onSave(trimmed, visibility);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!existing?.id || !onDelete) return;
    setSaving(true);
    try {
      await onDelete(existing.id);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  const canEdit = !existing || existing.can_edit !== false;

  return createPortal((
    <div
      ref={popRef}
      style={{
        position: 'fixed',
        top,
        left: Math.max(8, left),
        zIndex: 10000,
        width: 300,
        maxWidth: 'calc(100vw - 16px)',
        background: 'var(--bg3)',
        border: '1px solid var(--border2)',
        borderRadius: 10,
        boxShadow: '0 16px 48px rgba(0,0,0,.45)',
        padding: '12px 14px',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8, fontFamily: 'var(--font-mono)', lineHeight: 1.4 }}>
        {targetLabel}
      </div>

      {existing && (
        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: 'var(--text2)' }}>{existing.author_name || 'Unknown'}</span>
          {existing.visibility === 'private' && (
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(99,102,241,.15)', color: 'var(--accent)' }}>
              Private
            </span>
          )}
          {existing.updated_at && <span>· {fmtWhen(existing.updated_at)}</span>}
        </div>
      )}

      {existing && !canEdit ? (
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
          {existing.comment_text}
        </div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a comment…"
            autoFocus
            rows={4}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: 'var(--bg4)',
              border: '1px solid var(--border2)',
              borderRadius: 8,
              color: 'var(--text)',
              padding: '8px 10px',
              fontSize: 13,
              resize: 'vertical',
              outline: 'none',
              lineHeight: 1.45,
            }}
          />
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              Visibility
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[
                { id: 'team', label: 'Show to everyone', hint: 'All users can see this note' },
                { id: 'private', label: 'Only yourself', hint: 'Only you can see this note' },
              ].map((opt) => (
                <label
                  key={opt.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: visibility === opt.id ? 'rgba(99,102,241,.1)' : 'transparent',
                    border: `1px solid ${visibility === opt.id ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  <input
                    type="radio"
                    name="comment-visibility"
                    checked={visibility === opt.id}
                    onChange={() => setVisibility(opt.id)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{opt.label}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{opt.hint}</div>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        {existing?.id && canEdit && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={saving}
            style={{ marginRight: 'auto', background: 'none', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }}
          >
            Delete
          </button>
        )}
        <button type="button" onClick={onClose} style={{ background: 'none', border: '1px solid var(--border2)', color: 'var(--text2)', borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer' }}>
          Close
        </button>
        {canEdit && (
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !text.trim()}
            style={{ background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: 6, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: saving || !text.trim() ? 0.5 : 1 }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </div>
  ), document.body);
}
