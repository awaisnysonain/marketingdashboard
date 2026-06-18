import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { mtdRange } from '../utils/dateRange';
import {
  normalizeBrands,
  normalizeChannels,
  normalizeRegions,
  brandsParam,
  channelsParam,
  regionsParam,
  brandsToChannelApi,
  brandsToSubsApi,
  brandsToLiveKey,
  brandsToMetaApi,
  isAllBrands,
  isAllChannels,
  isAllRegions,
  filterByChannels,
  filterByRegions,
  filterByBrands,
} from '../constants/dashboardFilters';

/**
 * Per-page filter memory. Each route (pageKey) keeps its own Brand / Region /
 * Channel / Date selection, persisted under one localStorage object keyed by page.
 * Navigating to a page restores that page's last selection (or sensible defaults).
 */
const STORAGE_KEY = 'nobl-dashboard-filters-v2';

const DashboardFilterContext = createContext(null);

function defaultFilters() {
  return { dateRange: mtdRange(), brands: ['ALL'], regions: ['ALL'], channels: ['ALL'] };
}

function readStoredAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredAll(all) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

export function DashboardFilterProvider({ pageKey = 'global', children }) {
  const [all, setAll] = useState(readStoredAll);

  const cur = useMemo(() => all[pageKey] || defaultFilters(), [all, pageKey]);

  const dateRange = useMemo(() => cur.dateRange || mtdRange(), [cur.dateRange]);
  const brands = useMemo(() => normalizeBrands(cur.brands || ['ALL']), [cur.brands]);
  const regions = useMemo(() => normalizeRegions(cur.regions || ['ALL']), [cur.regions]);
  const channels = useMemo(() => normalizeChannels(cur.channels || ['ALL']), [cur.channels]);

  const patch = useCallback((p) => {
    setAll((prev) => {
      const base = prev[pageKey] || defaultFilters();
      const merged = { ...prev, [pageKey]: { ...base, ...p } };
      writeStoredAll(merged);
      return merged;
    });
  }, [pageKey]);

  const setBrands = useCallback((next) => patch({ brands: normalizeBrands(next) }), [patch]);
  const setRegions = useCallback((next) => patch({ regions: normalizeRegions(next) }), [patch]);
  const setChannels = useCallback((next) => patch({ channels: normalizeChannels(next) }), [patch]);
  const setDateRange = useCallback((next) => patch({ dateRange: next }), [patch]);

  const value = useMemo(() => ({
    pageKey,
    dateRange,
    setDateRange,
    brands,
    setBrands,
    regions,
    setRegions,
    channels,
    setChannels,
    brandsParam: brandsParam(brands),
    regionsParam: regionsParam(regions),
    channelsParam: channelsParam(channels),
    brandsApi: {
      channels: brandsToChannelApi(brands),
      subs: brandsToSubsApi(brands),
      live: brandsToLiveKey(brands),
      meta: brandsToMetaApi(brands),
    },
    isAllBrands: isAllBrands(brands),
    isAllRegions: isAllRegions(regions),
    isAllChannels: isAllChannels(channels),
    filterByChannels: (rows, field = 'channel') => filterByChannels(rows, field, channels),
    filterByRegions: (rows, field = 'region') => filterByRegions(rows, field, regions),
    filterByBrands: (rows, field = 'brand') => filterByBrands(rows, field, brands),
  }), [pageKey, dateRange, brands, regions, channels, setDateRange, setBrands, setRegions, setChannels]);

  return (
    <DashboardFilterContext.Provider value={value}>
      {children}
    </DashboardFilterContext.Provider>
  );
}

export function useDashboardFilters() {
  const ctx = useContext(DashboardFilterContext);
  if (!ctx) {
    throw new Error('useDashboardFilters must be used within DashboardFilterProvider');
  }
  return ctx;
}

/** Safe hook for pages that may render outside provider (shouldn't happen). */
export function useDashboardFiltersOptional() {
  return useContext(DashboardFilterContext);
}
