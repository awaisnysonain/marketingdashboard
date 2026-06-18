import React from 'react';

/**
 * Page toolbar. The page NAME now lives only in the TopBar header, so this no
 * longer renders a title / eyebrow / description in the body — it only hosts
 * page-level actions (right-aligned), and renders nothing when there are none.
 * This frees vertical space for actual content.
 *
 * title / desc / eyebrow / accent props are still accepted (and ignored) so the
 * many existing call sites keep working unchanged.
 */
export default function PageIntro({ actions, children }) {
  if (!actions && !children) return null;
  return (
    <div className="page-toolbar">
      {children}
      {actions && <div className="page-toolbar__actions">{actions}</div>}
    </div>
  );
}
