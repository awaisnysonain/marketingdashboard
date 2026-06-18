import React from 'react';

/**
 * Legacy chart wrapper — now renders the same look as ChartPanel so older
 * pages (topline, channel-daily) match the rest of the dashboard.
 * Keeps its original API (title, subtitle, style) plus a default bottom margin.
 */
export default function ChartCard({ title, subtitle, children, style = {} }) {
  return (
    <div className="chart-panel" style={{ marginBottom: 18, ...style }}>
      {(title || subtitle) && (
        <div className="chart-panel__head">
          {title && <div className="chart-panel__title">{title}</div>}
          {subtitle && <div className="chart-panel__subtitle">{subtitle}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
