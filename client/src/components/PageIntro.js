import React from 'react';

/** Page title and plain-English subtitle */
export default function PageIntro({ title, desc, accent, children }) {
  return (
    <div style={{ marginBottom: children ? 0 : undefined }}>
      <h1 style={{
        fontSize: 22,
        fontWeight: 800,
        margin: 0,
        fontFamily: 'var(--font-head)',
        color: accent || 'var(--text)',
      }}>
        {title}
      </h1>
      {desc && (
        <p style={{ fontSize: 13, color: 'var(--text3)', margin: '4px 0 0', lineHeight: 1.5, maxWidth: 720 }}>
          {desc}
        </p>
      )}
      {children}
    </div>
  );
}
