import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ToastContext = createContext(null);

let toastId = 0;

const COLORS = {
  info:    { bg: 'var(--accent-dim)',  border: 'var(--accent)',  text: 'var(--accent)'  },
  success: { bg: 'var(--success-dim)', border: 'var(--success)', text: 'var(--success)' },
  error:   { bg: 'var(--danger-dim)',  border: 'var(--danger)',  text: 'var(--danger)'  },
  warn:    { bg: 'var(--warn-dim)',    border: 'var(--warn)',    text: 'var(--warn)'    },
};

function ToastStack({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 10001,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 360,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => {
        const colors = COLORS[t.type] || COLORS.info;
        return (
          <div
            key={t.id}
            style={{
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              color: colors.text,
              padding: '10px 14px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 500,
              boxShadow: 'var(--shadow)',
              animation: 'fadein .2s ease',
            }}
          >
            {t.msg}
          </div>
        );
      })}
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((msg, type = 'info') => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, msg, type }]);
    window.setTimeout(() => dismiss(id), 2000);
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({
    show,
    success: (msg) => show(msg, 'success'),
    error: (msg) => show(msg, 'error'),
    info: (msg) => show(msg, 'info'),
    warn: (msg) => show(msg, 'warn'),
  }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} />
    </ToastContext.Provider>
  );
}

/** @returns {{ show, success, error, info, warn } | null} */
export function useToast() {
  return useContext(ToastContext);
}
