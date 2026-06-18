import React from 'react';

/**
 * Consistent chart card wrapper for analytics pages.
 */
export default function ChartPanel({ title, subtitle, children, className = '', style }) {
  return (
    <div className={`chart-panel ${className}`.trim()} style={style}>
      <div className="chart-panel__head">
        <div className="chart-panel__title">{title}</div>
        {subtitle && <div className="chart-panel__subtitle">{subtitle}</div>}
      </div>
      <div className="chart-panel__body">
        {children}
      </div>
    </div>
  );
}
