import React from 'react';
import DateRangePicker from './DateRangePicker';
import FilterMultiSelect from './FilterMultiSelect';
import { useDashboardFilters } from '../context/DashboardFilterContext';
import { filtersForPath, anyFilterVisible } from '../constants/filterVisibility';
import {
  BRAND_OPTIONS,
  REGION_OPTIONS,
  CHANNEL_OPTIONS,
  normalizeBrands,
  normalizeRegions,
  normalizeChannels,
  multiFilterLabel,
} from '../constants/dashboardFilters';

export default function GlobalFilterBar({ pathname }) {
  const {
    dateRange,
    setDateRange,
    brands,
    setBrands,
    regions,
    setRegions,
    channels,
    setChannels,
  } = useDashboardFilters();

  const vis = filtersForPath(pathname);
  if (!anyFilterVisible(pathname)) return null;

  // Only summarize filters that actually apply to this page.
  const summaryParts = [
    vis.brand && !brands.includes('ALL') && multiFilterLabel(brands, BRAND_OPTIONS),
    vis.region && !regions.includes('ALL') && multiFilterLabel(regions, REGION_OPTIONS),
    vis.channel && !channels.includes('ALL') && multiFilterLabel(channels, CHANNEL_OPTIONS),
  ].filter(Boolean);

  return (
    <div className="global-filter-bar">
      <div className="global-filter-bar__head">
        <span className="global-filter-bar__lead">Filters</span>
        <span className="global-filter-bar__active-inline">
          {summaryParts.length > 0 ? summaryParts.join(' · ') : 'All data in range'}
        </span>
      </div>
      <div className="global-filter-bar__inner">
        {vis.brand && (
          <FilterMultiSelect
            label="Brand"
            value={brands}
            onChange={setBrands}
            options={BRAND_OPTIONS}
            normalize={normalizeBrands}
            minWidth={140}
            compact
          />
        )}
        {vis.region && (
          <FilterMultiSelect
            label="Region"
            value={regions}
            onChange={setRegions}
            options={REGION_OPTIONS}
            normalize={normalizeRegions}
            minWidth={150}
            compact
          />
        )}
        {vis.channel && (
          <FilterMultiSelect
            label="Channel"
            value={channels}
            onChange={setChannels}
            options={CHANNEL_OPTIONS}
            normalize={normalizeChannels}
            minWidth={150}
            compact
          />
        )}

        {vis.date && (vis.brand || vis.region || vis.channel) && (
          <div className="global-filter-bar__divider" />
        )}

        {vis.date && (
          <DateRangePicker
            start={dateRange.start}
            end={dateRange.end}
            onChange={setDateRange}
          />
        )}
      </div>
    </div>
  );
}
