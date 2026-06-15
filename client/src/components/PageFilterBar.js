import React from 'react';
import DateRangePicker from './DateRangePicker';

/**
 * Date filter bar — always placed at the top of analytics pages, before KPIs/tables.
 */
export default function PageFilterBar({ start, end, onChange, label = 'Date range', children }) {
  return (
    <div className="page-filter-bar">
      <div className="page-filter-bar__inner">
        {label && <span className="page-filter-bar__label">{label}</span>}
        <DateRangePicker start={start} end={end} onChange={onChange} />
        {children}
      </div>
    </div>
  );
}
