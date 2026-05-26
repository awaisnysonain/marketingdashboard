import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  AreaChart, Area, ComposedChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  LineChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  getNoblAirPerformance,
  getNoblAirSubscribers,
  getNoblAirAttribution,
  getNoblAirForecast,
  getNoblAirDataVersion,
  fmt$,
  fmtFull$,
  fmtNum,
  fmtFullNum,
  fmtPct,
} from '../utils/api';
import {
  getAnalyticsCache,
  setAnalyticsCache,
  getCachedNoblAirDataVersion,
} from '../utils/analyticsCache';
import DateRangePicker from '../components/DateRangePicker';
import KpiCard from '../components/KpiCard';
import PaginatedSheetTable from '../components/PaginatedSheetTable';
import ServerPaginatedSheetTable from '../components/ServerPaginatedSheetTable';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { SEARCH_ALL_COLUMNS } from '../constants/tableSearch';
import TablePagination from '../components/TablePagination';
import { useClientPagination } from '../hooks/useClientPagination';
import { TABLE_PAGE_SIZE } from '../constants/pagination';
import PageIntro from '../components/PageIntro';
import { L, TIP, PAGE } from '../copy/plainLanguage';

/* ────────────── helpers ────────────── */
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function startOfMonthISO() {
  const d = new Date();
  return toISO(new Date(d.getFullYear(), d.getMonth(), 1));
}
function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo,10)-1]} ${parseInt(dy,10)}`;
}

const TIER_COLORS = {
  49:  '#94a3b8',
  79:  '#60a5fa',
  89:  '#3b82f6',
  99:  '#6366f1',
  109: '#8b5cf6',
  119: '#a855f7',
  129: '#ec4899',
  139: '#f43f5e',
  149: '#f97316',
  159: '#eab308',
};
const STATUS_COLORS = {
  active:    '#22c55e',
  cancelled: '#ef4444',
  paused:    '#f59e0b',
  trialing:  '#3b82f6',
  expired:   '#64748b',
  unknown:   '#94a3b8',
};

const FORECAST_STATUS_STYLES = {
  actual: { label: 'Actual', bg: 'rgba(34,197,94,.14)', color: '#22c55e' },
  current_projection: { label: 'MTD + Projection', bg: 'rgba(245,158,11,.16)', color: '#f59e0b' },
  target: { label: 'Target', bg: 'rgba(99,102,241,.16)', color: '#818cf8' },
  no_data: { label: 'No Data', bg: 'rgba(239,68,68,.14)', color: '#ef4444' },
  total: { label: 'Full Year Total', bg: 'rgba(20,184,166,.16)', color: '#14b8a6' },
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function forecastMonthLabel(row) {
  if (!row?.month_key) return row?.month || '—';
  const [year, mo] = String(row.month_key).split('-');
  const month = MONTH_LABELS[(parseInt(mo, 10) || 1) - 1] || row.month || mo;
  return `${month} ${year}`;
}

function forecastSourceLabel(row) {
  if (!row) return '—';
  if (row.row_type === 'actual') return `Actual · ${fmtNum(row.actual_orders)} orders incl. rebills`;
  if (row.row_type === 'current_projection') {
    return `MTD actuals · projected ${row.days_in_month || '—'}/${row.elapsed_days || '—'} days`;
  }
  if (row.row_type === 'target') return `Target ${fmt$(row.target_store_revenue)} ÷ ${fmt$(row.aov)}/order`;
  if (row.row_type === 'total') return 'Actuals through latest ETL; forecast columns include projected/target full year';
  return row.order_source || '—';
}

const KPI_TOOLTIPS = {
  airOrders: `${L.airOrders}\n${TIP.airOrders}`,
  attachRate: `${L.attachRate}\n${TIP.attachRate}`,
  ttpRateAsOf: `${L.ttpRateAsOf}\n${TIP.ttpRateAsOf}`,
  ttpRateInPeriod: `${L.ttpRateInPeriod}\n${TIP.ttpRateInPeriod}`,
  activationRateAsOf: `${L.activationRateAsOf}\n${TIP.activationRateAsOf}`,
  activationRateInPeriod: `${L.activationRateInPeriod}\n${TIP.activationRateInPeriod}`,
  matureInPeriod: `${L.matureInPeriod}\n${TIP.matureInPeriod}`,
  combinedNetRevenue: `${L.combinedNetRevenue}\n${TIP.combinedNetRevenue}`,
  rebillRevenue: `${L.rebillRevenue}\n${TIP.rebillRevenue}`,
  activeSubscribers: `${L.activeSubs}\n${TIP.activeSubs}`,
  activeArr: `Estimated yearly subscription value\n${TIP.activeArr}`,
  eligibleOrders: `${L.eligibleOrders}\n${TIP.eligibleOrders}`,
  paidAirOrders: `${L.paidAir}\n${TIP.paidAir}`,
  zeroAirOrders: `${L.zeroAir}\n${TIP.zeroAir}`,
  matureSubs: `${L.matureSubsAsOf}\n${TIP.matureSubs}`,
  paidConversions: `${L.paidConversions}\n${TIP.paidConversions}\nCount in selected date range (trial ended in range and started paying).`,
  cancels30d: `${L.cancels30d}\n${TIP.cancels30d}`,
  cancelRate30d: `${L.cancelRate30d}\n${TIP.cancelRate30d}`,
  newSubRevenue: `${L.newSubRevenue}\n${TIP.newSubRevenue}`,
};
const REGION_OPTIONS = [
  { value: 'ALL', label: 'All Regions' },
  { value: 'US',    label: 'US — United States' },
  { value: 'CA',    label: 'CA — Canada' },
  { value: 'AUS',   label: 'AUS — Australia' },
  { value: 'DUBAI', label: 'DUBAI — United Arab Emirates' },
  { value: 'HK',    label: 'HK — Hong Kong' },
  { value: 'INTL',  label: 'INTL — International / Unknown' },
];

function normalizeRegions(next) {
  const vals = Array.from(new Set((next || []).map(v => String(v).toUpperCase()))).filter(Boolean);
  if (vals.length === 0) return ['ALL'];
  if (vals.includes('ALL')) return ['ALL'];
  // Only allow known values
  const allowed = new Set(REGION_OPTIONS.filter(o => o.value !== 'ALL').map(o => o.value));
  const cleaned = vals.filter(v => allowed.has(v));
  return cleaned.length ? cleaned : ['ALL'];
}

function regionsLabel(selected) {
  const s = normalizeRegions(selected);
  if (s.length === 1 && s[0] === 'ALL') return 'All Regions';
  const map = Object.fromEntries(REGION_OPTIONS.map(o => [o.value, o.label]));
  return s.map(v => map[v] || v).join(' + ');
}

function regionsParam(selected) {
  const s = normalizeRegions(selected);
  return (s.length === 1 && s[0] === 'ALL') ? 'ALL' : s.join(',');
}

function RegionMultiSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const selected = normalizeRegions(value);
  const [draft, setDraft] = useState(selected);

  // When opening, take a snapshot so toggles don't immediately trigger reloads.
  useEffect(() => {
    if (open) setDraft(normalizeRegions(value));
  }, [open, value]);

  function toggle(v) {
    const vv = String(v).toUpperCase();
    if (vv === 'ALL') {
      setDraft(['ALL']);
      return;
    }
    if (draft.includes('ALL')) {
      setDraft([vv]);
      return;
    }
    if (draft.includes(vv)) {
      setDraft(draft.filter(x => x !== vv));
    } else {
      setDraft([...draft, vv]);
    }
  }

  return (
    <div style={{ position:'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          appearance:'none',
          minWidth: 180,
          height: 34,
          padding: '0 34px 0 12px',
          fontSize: 13,
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--bg2)',
          color: 'var(--text)',
          cursor: 'pointer',
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
          fontWeight: 500,
          textAlign: 'left',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={regionsLabel(selected)}
      >
        {regionsLabel(selected)}
      </button>
      <span style={{ position:'absolute', right:11, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', color:'var(--text3)', fontSize:11 }}>▼</span>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position:'fixed', inset:0, zIndex: 500 }}
          />
          <div
            style={{
              position:'absolute',
              top: 38,
              left: 0,
              zIndex: 600,
              minWidth: 220,
              background:'var(--bg2)',
              border:'1px solid var(--border2)',
              borderRadius: 10,
              boxShadow:'var(--shadow)',
              padding: '8px 8px',
            }}
          >
            {REGION_OPTIONS.map(opt => {
              const checked = opt.value === 'ALL'
                ? (draft.length === 1 && draft[0] === 'ALL')
                : draft.includes(opt.value);
              return (
                <label
                  key={opt.value}
                  style={{
                    display:'flex',
                    alignItems:'center',
                    gap: 8,
                    padding: '7px 8px',
                    borderRadius: 8,
                    cursor:'pointer',
                    userSelect:'none',
                    color:'var(--text2)',
                    fontSize: 12,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(opt.value)}
                    style={{ width: 14, height: 14 }}
                  />
                  <span style={{ fontWeight: opt.value === 'ALL' ? 600 : 500, color:'var(--text)' }}>{opt.label}</span>
                </label>
              );
            })}

            <div style={{ height: 1, background:'var(--border)', margin:'6px 6px' }} />
            <div style={{ display:'flex', justifyContent:'space-between', gap: 8, padding:'0 6px 4px' }}>
              <button
                type="button"
                onClick={() => setDraft(['ALL'])}
                style={{
                  padding:'6px 10px',
                  fontSize: 11,
                  background:'var(--bg3)',
                  border:'1px solid var(--border2)',
                  borderRadius: 8,
                  color:'var(--text2)',
                  cursor:'pointer',
                  fontFamily: 'var(--font-body)',
                }}
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => { onChange(normalizeRegions(draft)); setOpen(false); }}
                style={{
                  padding:'6px 10px',
                  fontSize: 11,
                  background:'var(--accent)',
                  border:'1px solid var(--accent)',
                  borderRadius: 8,
                  color:'#fff',
                  cursor:'pointer',
                  fontFamily: 'var(--font-body)',
                  fontWeight: 600,
                }}
              >
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ────────────── headers (full table) ────────────── */
const HEADERS = [
  L.date, L.eligibleOrders, L.airOrders, L.attachRate, L.ttpRate, L.activationRate,
  L.zeroAir, L.paidAir, 'Renewal orders', 'Cancelled same day',
  'Luggage sales (net)', 'New sub sales (net)', L.rebillRevenue, L.newSubRevenue, L.combinedNetRevenue,
  'New $79', 'New $99', 'New $119', 'New $129', 'New $139', 'New $149',
  'Renewal $79', 'Renewal $99', 'Renewal $119', 'Renewal $129', 'Renewal $139', 'Renewal $149',
];

const AIR_ATTR_HEADERS = [
  'Ad', 'Ad ID', 'Ad set', 'Campaign', L.spend, L.day1Revenue, L.aov,
  L.totalAttributedOrders, L.airOrders, L.attributedAirOrders,
  L.attachRate, 'Trial-ended Air orders', 'Trial-ended → paid Air orders', L.ttpRate, L.activationRate,
  L.attributedAirRevenue,
];

function toTableRow(r) {
  return {
    [L.date]: r.date,
    [L.eligibleOrders]: r.total_orders,
    [L.airOrders]: r.air_orders,
    [L.attachRate]: r.attach_rate,
    [L.ttpRate]: r.ttp_rate,
    [L.activationRate]: r.activation_rate,
    [L.zeroAir]: r.zero_air_orders,
    [L.paidAir]: r.paid_air_orders,
    'Renewal orders': r.rebill_orders,
    'Cancelled same day': r.same_day_cancels,
    'Luggage sales (net)': r.tag_net_sales,
    'New sub sales (net)': r.sub_net_sales,
    [L.rebillRevenue]: r.rebill_revenue,
    [L.newSubRevenue]: r.new_sub_revenue,
    [L.combinedNetRevenue]: r.combined_net_revenue,
    'New $79':   r.new_79,
    'New $99':   r.new_99,
    'New $119':  r.new_119,
    'New $129':  r.new_129,
    'New $139':  r.new_139,
    'New $149':  r.new_149,
    'Renewal $79':  r.rebill_79,
    'Renewal $99':  r.rebill_99,
    'Renewal $119': r.rebill_119,
    'Renewal $129': r.rebill_129,
    'Renewal $139': r.rebill_139,
    'Renewal $149': r.rebill_149,
    _date: r.date,
  };
}

function shortName(s, max = 28) {
  const name = String(s || 'Unknown');
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function toAirAttributionTableRow(r) {
  return {
    'Ad': r.ad_name || 'Unknown ad',
    'Ad ID': r.ad_id || 'Unknown ad ID',
    'Ad set': r.adset_name || 'Unknown ad set',
    'Campaign': r.campaign_name,
    [L.spend]: r.spend,
    [L.day1Revenue]: r.day_1_revenue,
    [L.aov]: r.aov,
    [L.totalAttributedOrders]: r.total_attributed_orders,
    [L.airOrders]: r.air_orders,
    [L.attributedAirOrders]: r.attributed_air_orders,
    [L.attachRate]: r.attach_rate,
    'Trial-ended Air orders': r.ttp_mature_air_orders,
    'Trial-ended → paid Air orders': r.ttp_paid_air_orders,
    [L.ttpRate]: r.ttp_rate,
    [L.activationRate]: r.activation_rate,
    [L.attributedAirRevenue]: r.attributed_air_revenue,
    _ad: [r.campaign_id, r.adset_id, r.ad_id, r.ad_name].map(v => v || '').join('|'),
  };
}

/* ────────────── PAGE ────────────── */
export default function NoblAirPerformancePage() {
  // Default range: current month-to-date.
  const [range, setRange] = useState({ start: startOfMonthISO(), end: toISO(new Date()) });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ rows: [], totals: {}, active_count: null, active_arr: null });
  const [subData, setSubData] = useState(null);
  const [airAttr, setAirAttr] = useState({ rows: [], totals: {}, pagination: {}, chart_rows: [], error: null });
  const [airAttrPage, setAirAttrPage] = useState(1);
  const [airAttrSearch, setAirAttrSearch] = useState('');
  const [airAttrSearchColumn, setAirAttrSearchColumn] = useState(SEARCH_ALL_COLUMNS);
  const [airAttrSortBy, setAirAttrSortBy] = useState(L.spend);
  const [airAttrSortDir, setAirAttrSortDir] = useState('desc');
  const debouncedAirAttrSearch = useDebouncedValue(airAttrSearch, 350);
  const debouncedAirAttrSearchColumn = useDebouncedValue(airAttrSearchColumn, 0);
  const [airAttrLoading, setAirAttrLoading] = useState(false);
  const [airAttrTableLoading, setAirAttrTableLoading] = useState(false);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [revenueForecast, setRevenueForecast] = useState(null);
  const [regions, setRegions] = useState(['ALL']);
  const [activeTab, setActiveTab] = useState('performance');

  const regionParam = useMemo(() => regionsParam(regions), [regions]);
  const regionScoped = regionParam !== 'ALL';

  const applyPerf = useCallback((perf) => {
    setData({
      rows: perf?.rows || [],
      totals: perf?.totals || {},
      ttpCohort: perf?.ttp_cohort || {},
      active_count: perf?.active_count ?? null,
      active_arr: perf?.active_arr ?? null,
    });
  }, []);

  const applyAirAttr = useCallback((attr, pageNum = 1) => {
    setAirAttr({
      rows: attr?.rows || [],
      totals: attr?.totals || {},
      pagination: attr?.pagination || {},
      chart_rows: attr?.chart_rows || [],
      error: attr?.error || null,
      cache_hint: attr?.cache_hint || null,
      source: attr?.source || null,
    });
    setAirAttrPage(pageNum);
  }, []);

  const loadAirAttrPage = useCallback(async (pageNum = 1, opts = { full: false }) => {
    if (regionScoped) return;
    if (opts.full) setAirAttrLoading(true);
    else setAirAttrTableLoading(true);
    try {
      await getNoblAirDataVersion();
      const attr = await getNoblAirAttribution(
        range.start, range.end, 'ad', pageNum, TABLE_PAGE_SIZE,
        debouncedAirAttrSearch, debouncedAirAttrSearchColumn, airAttrSortBy, airAttrSortDir,
      );
      applyAirAttr(attr, pageNum);
    } catch (e) {
      applyAirAttr({ rows: [], totals: {}, pagination: {}, chart_rows: [], error: e.message }, pageNum);
    } finally {
      setAirAttrLoading(false);
      setAirAttrTableLoading(false);
    }
  }, [range, regionScoped, applyAirAttr, debouncedAirAttrSearch, debouncedAirAttrSearchColumn, airAttrSortBy, airAttrSortDir]);

  const handleAirAttrSort = useCallback((field) => {
    setAirAttrPage(1);
    if (field === airAttrSortBy) {
      setAirAttrSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setAirAttrSortBy(field);
      setAirAttrSortDir('asc');
    }
  }, [airAttrSortBy]);

  const prevAirAttrFilter = useRef({
    q: debouncedAirAttrSearch, col: debouncedAirAttrSearchColumn, sortBy: airAttrSortBy, sortDir: airAttrSortDir,
  });
  useEffect(() => {
    if (regionScoped || activeTab !== 'performance') return;
    const prev = prevAirAttrFilter.current;
    if (
      prev.q === debouncedAirAttrSearch
      && prev.col === debouncedAirAttrSearchColumn
      && prev.sortBy === airAttrSortBy
      && prev.sortDir === airAttrSortDir
    ) return;
    prevAirAttrFilter.current = {
      q: debouncedAirAttrSearch, col: debouncedAirAttrSearchColumn, sortBy: airAttrSortBy, sortDir: airAttrSortDir,
    };
    setAirAttrPage(1);
    loadAirAttrPage(1, { full: false });
  }, [debouncedAirAttrSearch, debouncedAirAttrSearchColumn, airAttrSortBy, airAttrSortDir, regionScoped, activeTab, loadAirAttrPage]);

  const loadSecondary = useCallback(async (background = false) => {
    if (regionScoped) {
      setSubData(null);
      setAirAttr({ rows: [], totals: {}, pagination: {}, chart_rows: [], error: null });
      setAirAttrLoading(false);
      return;
    }
    const subsKey = `subs:${range.start}:${range.end}`;
    const cachedSubs = getAnalyticsCache(subsKey);
    if (!background) {
      setAirAttrLoading(true);
      setAirAttr({ rows: [], totals: {}, pagination: {}, chart_rows: [], error: null });
      setAirAttrPage(1);
    }
    try {
      await getNoblAirDataVersion();
      const [subs, attr] = await Promise.all([
        cachedSubs ? Promise.resolve(cachedSubs) : getNoblAirSubscribers(range.start, range.end).catch(() => null),
        getNoblAirAttribution(
          range.start, range.end, 'ad', 1, TABLE_PAGE_SIZE,
          debouncedAirAttrSearch, debouncedAirAttrSearchColumn, airAttrSortBy, airAttrSortDir,
        ).catch((e) => ({
          rows: [], totals: {}, pagination: {}, chart_rows: [], error: e.message,
        })),
      ]);
      setSubData(subs || null);
      applyAirAttr(attr, 1);
      if (!cachedSubs && subs) setAnalyticsCache(subsKey, subs);
    } finally {
      setAirAttrLoading(false);
    }
  }, [range, regionScoped, applyAirAttr, debouncedAirAttrSearch, debouncedAirAttrSearchColumn, airAttrSortBy, airAttrSortDir]);

  const load = useCallback(async () => {
    setError(null);
    const perfKey = `perf:${range.start}:${range.end}:${regionParam}:14:0`;
    const cachedPerf = getCachedNoblAirDataVersion() ? getAnalyticsCache(perfKey) : null;

    if (cachedPerf) {
      applyPerf(cachedPerf);
      setLoading(false);
      loadSecondary(false);
      return;
    }

    setLoading(true);
    setRevenueForecast(null);
    try {
      await getNoblAirDataVersion();
      const perf = await getNoblAirPerformance(range.start, range.end, 14, 0, regionParam);
      applyPerf(perf);
      setAnalyticsCache(perfKey, perf);
      setLoading(false);
      loadSecondary(true);
    } catch (e) {
      setError(e.message || 'Failed to load');
      setLoading(false);
    }
  }, [range, regionParam, regionScoped, loadSecondary, applyPerf]);

  const loadForecast = useCallback(async () => {
    if (regionScoped) return;
    const forecastKey = `forecast:${range.end}`;
    const cached = getAnalyticsCache(forecastKey);
    if (cached) {
      setRevenueForecast(cached?.revenue_forecast || cached);
      return;
    }
    setForecastLoading(true);
    try {
      await getNoblAirDataVersion();
      const res = await getNoblAirForecast(range.end);
      setRevenueForecast(res?.revenue_forecast || null);
      setAnalyticsCache(forecastKey, res);
    } catch {
      setRevenueForecast(null);
    } finally {
      setForecastLoading(false);
    }
  }, [range.end, regionScoped]);

  useEffect(() => {
    if (activeTab === 'forecast' && !regionScoped) loadForecast();
  }, [activeTab, range.end, regionScoped, loadForecast]);

  useEffect(() => {
    getNoblAirDataVersion().catch(() => null);
    load();
  }, [load]);

  /* ── chart-friendly rows (asc date) ── */
  const chartRows = useMemo(
    () => [...(data.rows || [])].reverse(),
    [data.rows]
  );

  const tableRows = useMemo(
    () => (data.rows || []).map(toTableRow),
    [data.rows]
  );

  const airAttrRows = useMemo(
    () => (airAttr?.rows || []).map(toAirAttributionTableRow),
    [airAttr]
  );
  const airAttrChartRows = useMemo(
    () => (airAttr?.chart_rows || []).slice(0, 10).map(r => ({ ...r, chart_label: shortName(r.ad_name || r.adset_name, 24) })),
    [airAttr?.chart_rows]
  );
  const airAttrTotalRows = airAttr?.pagination?.total_rows ?? 0;

  /* ── KPIs from performance totals: range attach × cohort TTP ── */
  const kpi = useMemo(() => {
    const t = data.totals || {};
    const attach = t.attach_rate;
    const ttpCohort = data.ttpCohort || {};
    const ttpAsOf = ttpCohort.ttp_rate_as_of ?? ttpCohort.ttp_rate ?? t.ttp_rate;
    const ttpInPeriod = ttpCohort.ttp_rate_in_period ?? (
      (ttpCohort.mature_in_period || 0) > 0
        ? (ttpCohort.paid_conversions_in_period || 0) / ttpCohort.mature_in_period
        : null
    );
    const activationAsOf = (attach != null && ttpAsOf != null) ? attach * ttpAsOf : null;
    const activationInPeriod = (attach != null && ttpInPeriod != null) ? attach * ttpInPeriod : null;
    return {
      eligibleOrders: t.total_orders || 0,
      airOrders: t.air_orders || 0,
      attachRate: attach,
      ttpRateAsOf: ttpAsOf,
      ttpRateInPeriod: ttpInPeriod,
      activationRateAsOf: activationAsOf,
      activationRateInPeriod: activationInPeriod,
      matureSubs: ttpCohort.mature || 0,
      matureInPeriod: ttpCohort.mature_in_period || 0,
      convertedMatureSubs: ttpCohort.paid_conversions_in_period ?? ttpCohort.converted ?? 0,
      cancelled30d: ttpCohort.cancelled_30d || 0,
      cancelRate30d: ttpCohort.cancel_rate_30d,
      paidAirOrders: t.paid_air_orders || 0,
      zeroAirOrders: t.zero_air_orders || 0,
      sameDayCancels: t.same_day_cancels || 0,
      combinedNetRevenue: t.combined_net_revenue || 0,
      rebillRevenue: t.rebill_revenue || 0,
      newSubRevenue: t.new_sub_revenue || 0,
      activeSubs: !regionScoped ? (data.active_count ?? subData?.active_count ?? 0) : null,
      activeArr:  !regionScoped ? (data.active_arr ?? subData?.active_arr ?? 0) : null,
    };
  }, [data, subData, regionScoped]);

  const tierData = useMemo(
    () => (subData?.tiers || []).map(t => ({
      ...t,
      label: `$${t.tier}`,
      color: TIER_COLORS[t.tier] || '#94a3b8',
    })),
    [subData]
  );
  const forecastAssumptions = revenueForecast?.assumptions || {};
  const forecastRows = revenueForecast?.rows || [];
  const forecastFullYear = revenueForecast?.full_year || null;
  const forecastTableRows = useMemo(
    () => [...forecastRows, forecastFullYear].filter(Boolean),
    [forecastRows, forecastFullYear]
  );
  const forecastMonthlyOnly = useMemo(
    () => forecastTableRows.filter((r) => r.row_type !== 'total'),
    [forecastTableRows],
  );
  const forecastTotalRow = useMemo(
    () => forecastTableRows.find((r) => r.row_type === 'total') || forecastFullYear,
    [forecastTableRows, forecastFullYear],
  );
  const {
    page: forecastPage,
    setPage: setForecastPage,
    pageItems: forecastPageItems,
    totalRows: forecastTableTotal,
  } = useClientPagination(forecastMonthlyOnly, TABLE_PAGE_SIZE, [forecastTableRows]);
  const currentForecastRow = useMemo(
    () => forecastRows.find(r => r.row_type === 'current_projection'),
    [forecastRows]
  );
  const hasActualForecastData = (row) => ['actual', 'current_projection', 'total'].includes(row?.row_type);
  const hasProjectedForecastData = (row) => ['actual', 'current_projection', 'target', 'total'].includes(row?.row_type);
  const fmtActualCurrency = (row, field) => hasActualForecastData(row) ? fmt$(row?.[field]) : '—';
  const fmtActualNumber = (row, field) => hasActualForecastData(row) ? fmtNum(row?.[field]) : '—';
  const fmtActualPct = (row, field) => hasActualForecastData(row) ? fmtPct(row?.[field]) : '—';
  const fmtProjectedCurrency = (row, field) => hasProjectedForecastData(row) ? fmt$(row?.[field]) : '—';
  const fmtProjectedNumber = (row, field) => hasProjectedForecastData(row) ? fmtNum(row?.[field]) : '—';
  const fmtProjectedPct = (row, field) => hasProjectedForecastData(row) ? fmtPct(row?.[field]) : '—';
  const forecastChartRows = useMemo(
    () => forecastRows.map(row => hasActualForecastData(row)
      ? {
        ...row,
        projected_store_revenue_chart: row.store_revenue,
        projected_orders_chart: row.orders,
      }
      : {
        ...row,
        actual_store_revenue: null,
        actual_orders: null,
        projected_store_revenue_chart: row.store_revenue,
        projected_orders_chart: row.orders,
      }),
    [forecastRows]
  );
  const statusData = useMemo(
    () => (subData?.status || []).map(s => ({
      name: s.status || 'unknown',
      value: s.n,
      color: STATUS_COLORS[s.status] || '#94a3b8',
    })),
    [subData]
  );

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20, gap:12, flexWrap:'wrap' }}>
        <PageIntro title={PAGE.noblAir.title} desc={PAGE.noblAir.desc} accent="#6366f1" />
        <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <RegionMultiSelect value={regions} onChange={(next) => setRegions(normalizeRegions(next))} />
          <DateRangePicker
            start={range.start}
            end={range.end}
            onChange={setRange}
            scope="nobl-air-performance"
          />
        </div>
      </div>

      <div style={{ display:'flex', gap:8, marginBottom:18, borderBottom:'1px solid var(--border)', paddingBottom:8 }}>
        {[
          ['performance', 'Results'],
          ['forecast', 'Forecast'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            style={{
              border:'1px solid var(--border2)',
              background: activeTab === key ? 'var(--accent)' : 'var(--bg2)',
              color: activeTab === key ? '#fff' : 'var(--text2)',
              borderRadius: 999,
              padding:'8px 14px',
              fontSize:12,
              fontWeight:700,
              cursor:'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? <Skeleton /> : error ? <ErrorBox msg={error} onRetry={load} /> : (
        <>
          {activeTab === 'performance' && (
          <>
          {/* ── Top KPI row ── */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(170px, 1fr))', gap:12, marginBottom:20 }}>
            <KpiCard label={L.airOrders} value={fmtNum(kpi.airOrders)} fullValue={fmtFullNum(kpi.airOrders)} color="nobl" tooltip={KPI_TOOLTIPS.airOrders} />
            <KpiCard label={L.attachRate} value={fmtPct(kpi.attachRate || 0)} fullValue={fmtPct(kpi.attachRate || 0)} color="teal" tooltip={KPI_TOOLTIPS.attachRate} sub="selected dates" />
            <KpiCard label={L.ttpRateAsOf} value={fmtPct(kpi.ttpRateAsOf || 0)} fullValue={fmtPct(kpi.ttpRateAsOf || 0)} color="purple" tooltip={KPI_TOOLTIPS.ttpRateAsOf} sub="as of end date" />
            <KpiCard label={L.ttpRateInPeriod} value={fmtPct(kpi.ttpRateInPeriod || 0)} fullValue={fmtPct(kpi.ttpRateInPeriod || 0)} color="purple" tooltip={KPI_TOOLTIPS.ttpRateInPeriod} sub="trial ended in range" />
            <KpiCard label={L.activationRateAsOf} value={fmtPct(kpi.activationRateAsOf || 0)} fullValue={fmtPct(kpi.activationRateAsOf || 0)} color="green" tooltip={KPI_TOOLTIPS.activationRateAsOf} sub="as of end date" />
            <KpiCard label={L.activationRateInPeriod} value={fmtPct(kpi.activationRateInPeriod || 0)} fullValue={fmtPct(kpi.activationRateInPeriod || 0)} color="green" tooltip={KPI_TOOLTIPS.activationRateInPeriod} sub="trial ended in range" />
            <KpiCard label={L.combinedNetRevenue} value={fmt$(kpi.combinedNetRevenue)} fullValue={fmtFull$(kpi.combinedNetRevenue)} color="blue" tooltip={KPI_TOOLTIPS.combinedNetRevenue} />
            <KpiCard label={L.rebillRevenue} value={fmt$(kpi.rebillRevenue)} fullValue={fmtFull$(kpi.rebillRevenue)} color="warn" tooltip={KPI_TOOLTIPS.rebillRevenue} />
            {!regionScoped && <KpiCard label={L.activeSubs} value={fmtNum(kpi.activeSubs)} fullValue={fmtFullNum(kpi.activeSubs)} color="green" tooltip={KPI_TOOLTIPS.activeSubscribers} />}
            {!regionScoped && <KpiCard label="Est. yearly sub value" value={fmt$(kpi.activeArr)} fullValue={fmtFull$(kpi.activeArr)} color="purple" tooltip={KPI_TOOLTIPS.activeArr} />}
          </div>

          <div style={{
            fontSize: 12,
            color: 'var(--text3)',
            lineHeight: 1.5,
            marginBottom: 14,
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg2)',
          }}>
            <strong style={{ color: 'var(--text2)' }}>Two TTP views:</strong>{' '}
            <em>As of end date</em> uses every subscriber whose trial had finished by your end date (headline / forecast).{' '}
            <em>Trial ended in range</em> only counts subscribers whose trial ended inside the selected dates — often a lower % (e.g. ~63% vs ~67%).
          </div>

          {/* ── Secondary KPI row ── */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:12, marginBottom:20 }}>
            <KpiCard label={L.eligibleOrders} value={fmtNum(kpi.eligibleOrders)} fullValue={fmtFullNum(kpi.eligibleOrders)} color="text" tooltip={KPI_TOOLTIPS.eligibleOrders} />
            <KpiCard label={L.paidAir} value={fmtNum(kpi.paidAirOrders)} fullValue={fmtFullNum(kpi.paidAirOrders)} color="nobl" tooltip={KPI_TOOLTIPS.paidAirOrders} />
            <KpiCard label={L.zeroAir} value={fmtNum(kpi.zeroAirOrders)} fullValue={fmtFullNum(kpi.zeroAirOrders)} color="warn" tooltip={KPI_TOOLTIPS.zeroAirOrders} />
            <KpiCard label={L.matureSubsAsOf} value={fmtNum(kpi.matureSubs)} fullValue={fmtFullNum(kpi.matureSubs)} color="purple" tooltip={KPI_TOOLTIPS.matureSubs} sub="as of end date" />
            <KpiCard label={L.matureInPeriod} value={fmtNum(kpi.matureInPeriod)} fullValue={fmtFullNum(kpi.matureInPeriod)} color="purple" tooltip={KPI_TOOLTIPS.matureInPeriod} sub="trial ended in range" />
            <KpiCard label={L.paidConversions} value={fmtNum(kpi.convertedMatureSubs)} fullValue={fmtFullNum(kpi.convertedMatureSubs)} color="green" tooltip={KPI_TOOLTIPS.paidConversions} sub="paid · in range" />
            <KpiCard label={L.cancels30d} value={fmtNum(kpi.cancelled30d)} fullValue={fmtFullNum(kpi.cancelled30d)} color="red" tooltip={KPI_TOOLTIPS.cancels30d} />
            <KpiCard label={L.cancelRate30d} value={fmtPct(kpi.cancelRate30d || 0)} fullValue={fmtPct(kpi.cancelRate30d || 0)} color="red" tooltip={KPI_TOOLTIPS.cancelRate30d} />
            <KpiCard label={L.newSubRevenue} value={fmt$(kpi.newSubRevenue)} fullValue={fmtFull$(kpi.newSubRevenue)} color="blue" tooltip={KPI_TOOLTIPS.newSubRevenue} />
          </div>

          {/* ── Row 1: revenue trend + attach/TTP trend ── */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
            <Card title="Total Air sales trend">
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={chartRows} margin={{ top:4, right:16, left:0, bottom:4 }}>
                  <defs>
                    <linearGradient id="revGradAir" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={(v) => fmt$(v)} tick={{ fontSize:11 }} width={70} stroke="var(--border2)" />
                  <Tooltip
                    formatter={(v, n) => [fmt$(v), n]}
                    labelFormatter={fmtDateLabel}
                    contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }}
                  />
                  <Area type="monotone" dataKey="combined_net_revenue" name={L.combinedNetRevenue} stroke="#6366f1" fill="url(#revGradAir)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Daily add-on & trial rates" subtitle="Per-day rates (trial ended that day). KPI cards above show period totals; purple/green pairs compare as-of end date vs trial ended in range.">
              <ResponsiveContainer width="100%" height={250}>
                <ComposedChart data={chartRows} margin={{ top:4, right:16, left:0, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis yAxisId="orders" tick={{ fontSize:11 }} width={48} stroke="var(--border2)" />
                  <YAxis yAxisId="rates"  orientation="right" tick={{ fontSize:11 }} width={48} stroke="var(--border2)" tickFormatter={(v) => `${Math.round(v * 100)}%`} />
                  <Tooltip
                    formatter={(v, n) =>
                      ['attach_rate','ttp_rate','activation_rate'].includes(n)
                        ? [fmtPct(v), n]
                        : [fmtNum(v), n]
                    }
                    labelFormatter={fmtDateLabel}
                    contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }}
                  />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  <Bar  yAxisId="orders" dataKey="air_orders"      name={L.airOrders}      fill="#6366f1" radius={[2,2,0,0]} />
                  <Line yAxisId="rates"  dataKey="attach_rate"     name={L.attachRate}     stroke="#14b8a6" strokeWidth={2} dot={false} />
                  <Line yAxisId="rates"  dataKey="ttp_rate"        name={L.ttpRateInPeriod} stroke="#f59e0b" strokeWidth={2} dot={false} />
                  <Line yAxisId="rates"  dataKey="activation_rate" name={L.activationRateInPeriod} stroke="#8b5cf6" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          </div>

          {/* ── Row 2: tier mix bar + status pie ── */}
          {!regionScoped && (
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:16, marginBottom:16 }}>
            <Card title="Subscription price tiers" subtitle="How many subscribers are active, cancelled, or paused at each monthly price.">
              {tierData.length === 0 ? <Empty msg="No tier data" /> : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={tierData} margin={{ top:4, right:16, left:0, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize:11 }} stroke="var(--border2)" />
                    <YAxis tick={{ fontSize:11 }} stroke="var(--border2)" width={50} />
                    <Tooltip formatter={(v, n) => [fmtNum(v), n]}
                      contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
                    <Legend wrapperStyle={{ fontSize:12 }} />
                    <Bar dataKey="active"    name="Active"    stackId="s" fill="#22c55e" />
                    <Bar dataKey="cancelled" name="Cancelled" stackId="s" fill="#ef4444" />
                    <Bar dataKey="paused"    name="Paused"    stackId="s" fill="#f59e0b" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>

            <Card title="Subscriber Status">
              {statusData.length === 0 ? <Empty msg="No status data" /> : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={90} paddingAngle={2}>
                      {statusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Pie>
                    <Tooltip
                      formatter={(v, n) => [fmtNum(v), n]}
                      contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }}
                    />
                    <Legend verticalAlign="bottom" wrapperStyle={{ fontSize:11 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </Card>
          </div>
          )}

          {/* ── Row 3: revenue composition stacked bar ── */}
          <Card title="Where the money comes from (luggage, new subs, renewals)" style={{ marginBottom:16 }}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartRows} margin={{ top:4, right:16, left:0, bottom:4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
                <YAxis tickFormatter={(v) => fmt$(v)} tick={{ fontSize:11 }} width={70} stroke="var(--border2)" />
                <Tooltip
                  formatter={(v, n) => [fmt$(v), n]}
                  labelFormatter={fmtDateLabel}
                  contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }}
                />
                <Legend wrapperStyle={{ fontSize:12 }} />
                <Bar dataKey="tag_net_sales"  name="Tag (Hardware)"   stackId="rev" fill="#22c55e" />
                <Bar dataKey="sub_net_sales"  name="New Subscriptions" stackId="rev" fill="#6366f1" />
                <Bar dataKey="rebill_revenue" name="Rebills"           stackId="rev" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* ── NOBL Air ad attribution ── */}
          {!regionScoped && (
          <Card title="Meta ads driving Air sales" subtitle="Facebook/Instagram ads that led to Air orders in your dates — spend, sales, and trial conversions." style={{ marginBottom:16 }}>
            {airAttrLoading ? (
              <div style={{ height:260, borderRadius:12, background:'var(--bg3)', animation:'pulse 1.5s ease-in-out infinite' }} />
            ) : airAttr?.error ? (
              <div style={{ color:'var(--danger)', fontSize:13 }}>NOBL Air ad attribution unavailable: {airAttr.error}</div>
            ) : airAttrTotalRows === 0 && airAttrRows.length === 0 ? (
              <Empty msg={airAttr?.cache_hint || 'No Meta ad data for this range yet. Run tw_air_attribution sync or wait for the nightly job.'} />
            ) : (
              <>
                {airAttr?.cache_hint ? (
                  <div style={{ fontSize:12, color:'var(--text3)', marginBottom:12, padding:'8px 12px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--border)' }}>
                    {airAttr.cache_hint}
                  </div>
                ) : null}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:12, marginBottom:16 }}>
                  <KpiCard label={L.spend} value={fmt$(airAttr.totals?.spend || 0)} fullValue={fmtFull$(airAttr.totals?.spend || 0)} tooltip={TIP.spend} />
                  <KpiCard label={L.day1Revenue} value={fmt$(airAttr.totals?.day_1_revenue || 0)} fullValue={fmtFull$(airAttr.totals?.day_1_revenue || 0)} tooltip={TIP.day1Revenue} />
                  <KpiCard label={L.aov} value={fmt$(airAttr.totals?.aov || 0)} fullValue={fmtFull$(airAttr.totals?.aov || 0)} tooltip={TIP.aov} />
                  <KpiCard label={L.airOrders} value={fmtNum(airAttr.totals?.air_orders || 0)} fullValue={fmtFullNum(airAttr.totals?.air_orders || 0)} tooltip={TIP.airOrders} />
                  <KpiCard label={L.paidConversions} value={fmtNum(airAttr.totals?.ttp_paid_subscribers || 0)} fullValue={fmtFullNum(airAttr.totals?.ttp_paid_subscribers || 0)} tooltip={TIP.paidConversions} />
                  <KpiCard label={L.totalAttributedOrders} value={fmtNum(airAttr.totals?.total_attributed_orders || 0)} fullValue={fmtFullNum(airAttr.totals?.total_attributed_orders || 0)} />
                  <KpiCard label={L.attributedAirOrders} value={fmtNum(airAttr.totals?.attributed_air_orders || 0)} fullValue={fmtFullNum(airAttr.totals?.attributed_air_orders || 0)} />
                  <KpiCard label={L.attachRate} value={fmtPct(airAttr.totals?.attach_rate || 0)} fullValue={fmtPct(airAttr.totals?.attach_rate || 0)} tooltip={TIP.attachRate} />
                  <KpiCard label={L.ttpRate} value={fmtPct(airAttr.totals?.ttp_rate || 0)} fullValue={fmtPct(airAttr.totals?.ttp_rate || 0)} tooltip={TIP.ttpRate} />
                  <KpiCard label={L.activationRate} value={fmtPct(airAttr.totals?.activation_rate || 0)} fullValue={fmtPct(airAttr.totals?.activation_rate || 0)} tooltip={TIP.activationRate} />
                  <KpiCard label={L.attributedAirRevenue} value={fmt$(airAttr.totals?.attributed_air_revenue || 0)} fullValue={fmtFull$(airAttr.totals?.attributed_air_revenue || 0)} />
                  <KpiCard label="Total ads" value={fmtNum(airAttrTotalRows)} fullValue={fmtFullNum(airAttrTotalRows)} />
                </div>

                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={airAttrChartRows} margin={{ top:4, right:16, left:0, bottom:72 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="chart_label" tick={{ fontSize:10 }} stroke="var(--border2)" angle={-30} textAnchor="end" interval={0} height={72} />
                    <YAxis yAxisId="orders" tick={{ fontSize:11 }} width={56} stroke="var(--border2)" />
                    <YAxis yAxisId="revenue" orientation="right" tickFormatter={(v) => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                    <Tooltip
                      formatter={(v, n) => n === L.attributedAirRevenue ? [fmt$(v), n] : [fmtNum(v), n]}
                      contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }}
                    />
                    <Legend wrapperStyle={{ fontSize:12 }} />
                    <Bar yAxisId="orders" dataKey="attributed_air_orders" name="Attributed Air Orders" fill="#1877f2" radius={[2,2,0,0]} />
                    <Line yAxisId="revenue" dataKey="attributed_air_revenue" name={L.attributedAirRevenue} stroke="#22c55e" strokeWidth={2} dot={{ r:3 }} />
                  </ComposedChart>
                </ResponsiveContainer>

                <ServerPaginatedSheetTable
                  headers={AIR_ATTR_HEADERS}
                  rows={airAttrRows}
                  keyField="_ad"
                  page={airAttrPage}
                  totalRows={airAttrTotalRows}
                  onPageChange={(p) => loadAirAttrPage(p)}
                  search={airAttrSearch}
                  onSearchChange={(v) => { setAirAttrSearch(v); setAirAttrPage(1); }}
                  searchColumn={airAttrSearchColumn}
                  onSearchColumnChange={(col) => { setAirAttrSearchColumn(col); setAirAttrPage(1); }}
                  loading={airAttrTableLoading}
                  sortBy={airAttrSortBy}
                  sortDir={airAttrSortDir}
                  onSort={handleAirAttrSort}
                />
              </>
            )}
          </Card>
          )}

          {/* ── Daily detail table ── */}
          <Card title="Day-by-day numbers" subtitle="One row per day — orders, add-on rate, trials, and sales breakdown.">
            <PaginatedSheetTable
              headers={HEADERS}
              rows={tableRows}
              keyField="_date"
              resetDeps={[range.start, range.end, regionParam]}
              defaultSortField={L.date}
              defaultSortDir="desc"
            />
          </Card>
          </>
          )}

          {activeTab === 'forecast' && !regionScoped && forecastLoading && (
            <div style={{ height:260, borderRadius:12, background:'var(--bg2)', animation:'pulse 1.5s ease-in-out infinite' }} />
          )}
          {activeTab === 'forecast' && !regionScoped && !forecastLoading && revenueForecast && (
          <>
            <Card title="Air sales forecast" subtitle="Projected Air revenue using your latest results and plan targets." style={{ marginBottom: 16 }}>
              {currentForecastRow && (
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(180px, 1fr))', gap:10, marginBottom:14 }}>
                  <KpiCard size="sm" label="This month — store sales so far" value={fmt$(currentForecastRow.actual_store_revenue)} tooltip="All NOBL store sales month-to-date (including renewals), after discounts where applicable." />
                  <KpiCard size="sm" label="This month — orders so far" value={fmtNum(currentForecastRow.actual_orders)} tooltip="All NOBL orders month-to-date through the latest sync." />
                  <KpiCard size="sm" label="This month — Air sales so far" value={fmt$(currentForecastRow.actual_air_rev_net)} tooltip="Total Air revenue month-to-date. Matches the Results tab when you use the same dates." />
                  <KpiCard size="sm" label="This month — projected store sales" value={fmt$(currentForecastRow.store_revenue)} tooltip="Extrapolates month-to-date sales to the full month." />
                  <KpiCard size="sm" label="This month — projected eligible orders" value={fmtNum(currentForecastRow.orders)} tooltip="Orders that could include Air, projected for the full month." />
                  <KpiCard size="sm" label="This month — forecast Air sales" value={fmt$(currentForecastRow.total_air_rev_net_est)} tooltip="Estimated Air revenue for the full month from the forecast model." />
                  <KpiCard size="sm" label="This month — eligible orders (forecast)" value={fmtNum(currentForecastRow.eligible_orders)} tooltip="Projected orders that could add Air (excludes rebills)." />
                </div>
              )}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:10 }}>
                <KpiCard size="sm" label="Forecast success rate" value={fmtPct(forecastAssumptions.forecast_activation_rate)} tooltip="Expected share of Air orders that complete trial and pay (used in the forecast)." />
                <KpiCard size="sm" label="Actual success rate" value={fmtPct(forecastAssumptions.period_activation_rate)} tooltip="Add-on rate × trial-to-paid rate for your selected dates (from Results tab)." />
                <KpiCard size="sm" label={L.aov} value={fmt$(forecastAssumptions.avg_revenue_per_store_order)} tooltip="Average sales per eligible order in the selected period." />
                <KpiCard size="sm" label="Eligible order share" value={fmtPct(forecastAssumptions.eligible_order_rate)} tooltip="Share of all store orders that can include Air (not rebills)." />
                <KpiCard size="sm" label="Avg paying tier price" value={fmt$(forecastAssumptions.avg_tier_price_converted_subs)} tooltip="Average monthly price for subscribers who started paying." />
                <KpiCard size="sm" label="Luggage sales per Air order" value={fmt$(forecastAssumptions.tag_net_sales_per_air_order)} tooltip="Net luggage/hardware sales divided by Air orders." />
                <KpiCard size="sm" label="Total Air sales per order" value={fmt$(forecastAssumptions.blended_net_rev_per_air_order)} tooltip="All Air revenue (luggage + subs + renewals) per Air order." />
              </div>
            </Card>

            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(340px, 1fr))', gap:16, marginBottom:16 }}>
              <Card title="Line Chart — Total Air Revenue" subtitle="Monthly forecast trend for total NOBL Air revenue.">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={forecastRows} margin={{ top:8, right:18, left:0, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize:11 }} stroke="var(--border2)" />
                    <YAxis tickFormatter={(v) => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                    <Tooltip contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} formatter={(v, n) => [fmt$(v), n]} />
                    <Legend wrapperStyle={{ fontSize:12 }} />
                    <Line type="monotone" dataKey="total_air_rev_net_est" name="Total Air Rev" stroke="#8b5cf6" strokeWidth={2.5} dot={{ r:3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Bar Chart — NOBL Air Revenue Mix" subtitle="Stacked Tag + Sub revenue estimates by month.">
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={forecastRows} margin={{ top:8, right:18, left:0, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize:11 }} stroke="var(--border2)" />
                    <YAxis yAxisId="rev" tickFormatter={(v) => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                    <YAxis yAxisId="orders" orientation="right" tickFormatter={(v) => fmtNum(v)} tick={{ fontSize:11 }} width={58} stroke="var(--border2)" />
                    <Tooltip contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} formatter={(v, n) => [String(n).includes('Activations') ? fmtNum(v) : fmt$(v), n]} />
                    <Legend wrapperStyle={{ fontSize:12 }} />
                    <Bar yAxisId="rev" dataKey="tag_rev_net_est" stackId="airRev" name="Tag Rev" fill="#60a5fa" />
                    <Bar yAxisId="rev" dataKey="sub_rev_net_est" stackId="airRev" name="Sub Rev" fill="#8b5cf6" />
                    <Line yAxisId="orders" type="monotone" dataKey="est_activations" name="Est. Activations" stroke="#22c55e" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Column Chart — Store Revenue" subtitle="Store revenue forecast/actual columns with actual revenue overlay.">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={forecastChartRows} margin={{ top:8, right:18, left:0, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize:11 }} stroke="var(--border2)" />
                    <YAxis tickFormatter={(v) => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                    <Tooltip contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} formatter={(v, n) => [fmt$(v), n]} />
                    <Legend wrapperStyle={{ fontSize:12 }} />
                    <Bar dataKey="projected_store_revenue_chart" name="Projected/Target Revenue" fill="#14b8a6" radius={[3,3,0,0]} />
                    <Bar dataKey="actual_store_revenue" name="Actual Revenue" fill="#22c55e" radius={[3,3,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>

              <Card title="Store Revenue, Orders, and Air Orders" subtitle="Store revenue drives order volume; attach rate drives estimated Air orders.">
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={forecastChartRows} margin={{ top:8, right:18, left:0, bottom:4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize:11 }} stroke="var(--border2)" />
                    <YAxis yAxisId="rev" tickFormatter={(v) => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                    <YAxis yAxisId="orders" orientation="right" tickFormatter={(v) => fmtNum(v)} tick={{ fontSize:11 }} width={58} stroke="var(--border2)" />
                    <Tooltip contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} formatter={(v, n) => [String(n).includes('Revenue') ? fmt$(v) : fmtNum(v), n]} />
                    <Legend wrapperStyle={{ fontSize:12 }} />
                    <Bar yAxisId="rev" dataKey="projected_store_revenue_chart" name="Projected/Target Store Revenue" fill="#14b8a6" />
                    <Bar yAxisId="rev" dataKey="actual_store_revenue" name="Actual Revenue" fill="#22c55e" />
                    <Line yAxisId="orders" type="monotone" dataKey="projected_orders_chart" name="Projected/Target Orders" stroke="#f59e0b" strokeWidth={2} dot={false} />
                    <Line yAxisId="orders" type="monotone" dataKey="actual_orders" name="Actual Orders" stroke="#22c55e" strokeWidth={2} dot={false} />
                    <Line yAxisId="orders" type="monotone" dataKey="est_air_orders" name="Est. Air Orders" stroke="#6366f1" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Card>
            </div>

            <Card title="Monthly Forecast Detail" subtitle="Actual columns match the Performance tab for the same date period. Forecast columns follow the provided sheet model: eligible orders × forecast activation/attach assumptions. The Full Year Total row shows actuals through latest ETL and full-year forecast columns separately." style={{ marginBottom: 16 }}>
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <thead>
                    <tr style={{ color:'var(--text3)', borderBottom:'1px solid var(--border)' }}>
                      {['Month','Status','Actual Store Rev','Actual Store Orders','Actual Eligible Orders','Actual Air Orders','Actual Attach','Actual TTP','Actual Activation','Actual Tag Rev','Actual Sub Rev','Actual Rebill Rev','Actual Air Rev','Projected/Target Store Rev','Projected/Target Eligible Orders','AOV','Forecast Air Orders','Forecast Activations','Forecast Attach','Forecast Activation','Forecast Air Rev','Source'].map(h => (
                        <th key={h} style={{ textAlign: h === 'Month' || h === 'Source' ? 'left' : 'right', padding:'8px 10px', fontWeight:600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {forecastPageItems.map((r, idx) => {
                      const statusStyle = FORECAST_STATUS_STYLES[r.row_type] || FORECAST_STATUS_STYLES.no_data;
                      const isSummary = r.row_type === 'total';
                      return (
                      <tr key={r.month} style={{ borderBottom:'1px solid var(--border)', color: isSummary ? 'var(--text)' : 'var(--text2)', fontWeight: isSummary ? 700 : 400 }}>
                        <td style={{ padding:'8px 10px', whiteSpace:'nowrap' }}>{forecastMonthLabel(r)}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right' }}>
                          <span style={{ display:'inline-block', padding:'3px 8px', borderRadius:999, background:statusStyle.bg, color:statusStyle.color, fontSize:11, fontWeight:700, whiteSpace:'nowrap' }}>
                            {r.status_label || statusStyle.label}
                          </span>
                        </td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualCurrency(r, 'actual_store_revenue')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualNumber(r, 'actual_orders')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualNumber(r, 'actual_eligible_orders')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualNumber(r, 'actual_air_orders')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualPct(r, 'actual_attach_rate')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualPct(r, 'actual_ttp_rate')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualPct(r, 'actual_activation_rate')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualCurrency(r, 'actual_tag_rev_net')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualCurrency(r, 'actual_sub_rev_net')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualCurrency(r, 'actual_rebill_rev_net')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualCurrency(r, 'actual_air_rev_net')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedCurrency(r, 'store_revenue')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedNumber(r, 'orders')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{hasProjectedForecastData(r) ? fmt$(r.aov) : '—'}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedNumber(r, 'est_air_orders')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedNumber(r, 'est_activations')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedPct(r, 'attach_rate')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedPct(r, 'activation_rate')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedCurrency(r, 'total_air_rev_net_est')}</td>
                        <td style={{ padding:'8px 10px', color:'var(--text3)', whiteSpace:'nowrap' }} title={r.order_source || undefined}>{forecastSourceLabel(r)}</td>
                      </tr>
                    );})}
                    {forecastTotalRow && (() => {
                      const r = forecastTotalRow;
                      const statusStyle = FORECAST_STATUS_STYLES[r.row_type] || FORECAST_STATUS_STYLES.no_data;
                      const isSummary = true;
                      return (
                      <tr key={r.month || 'total'} style={{ borderBottom:'1px solid var(--border)', color: 'var(--text)', fontWeight: 700 }}>
                        <td style={{ padding:'8px 10px', whiteSpace:'nowrap' }}>{forecastMonthLabel(r)}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right' }}>
                          <span style={{ display:'inline-block', padding:'3px 8px', borderRadius:999, background:statusStyle.bg, color:statusStyle.color, fontSize:11, fontWeight:700, whiteSpace:'nowrap' }}>
                            {r.status_label || statusStyle.label}
                          </span>
                        </td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualCurrency(r, 'actual_store_revenue')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualNumber(r, 'actual_orders')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualNumber(r, 'actual_eligible_orders')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualNumber(r, 'actual_air_orders')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualPct(r, 'actual_attach_rate')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualPct(r, 'actual_ttp_rate')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualPct(r, 'actual_activation_rate')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualCurrency(r, 'actual_tag_rev_net')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualCurrency(r, 'actual_sub_rev_net')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualCurrency(r, 'actual_rebill_rev_net')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums', color: hasActualForecastData(r) ? '#22c55e' : 'var(--text3)' }}>{fmtActualCurrency(r, 'actual_air_rev_net')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedCurrency(r, 'store_revenue')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedNumber(r, 'orders')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{hasProjectedForecastData(r) ? fmt$(r.aov) : '—'}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedNumber(r, 'est_air_orders')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedNumber(r, 'est_activations')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedPct(r, 'attach_rate')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedPct(r, 'activation_rate')}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtProjectedCurrency(r, 'total_air_rev_net_est')}</td>
                        <td style={{ padding:'8px 10px', color:'var(--text3)', whiteSpace:'nowrap' }} title={r.order_source || undefined}>{forecastSourceLabel(r)}</td>
                      </tr>
                      );
                    })()}
                  </tbody>
                </table>
                <TablePagination page={forecastPage} pageSize={TABLE_PAGE_SIZE} totalRows={forecastTableTotal} onPageChange={setForecastPage} />
              </div>
            </Card>
          </>
          )}

          {activeTab === 'forecast' && !regionScoped && !forecastLoading && !revenueForecast && (
            <Card title="Forecast" subtitle="Could not load forecast data.">
              <Empty msg="Forecast failed to load. Try again or check the server logs." />
            </Card>
          )}

          {activeTab === 'forecast' && regionScoped && (
            <Card title="Forecast unavailable for regional filters" subtitle="The forecast model is currently all-region only because store revenue targets and AOV are all-region assumptions.">
              <Empty msg="Switch region to All Regions to view the NOBL Air forecast." />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/* ────────────── helper components ────────────── */
function Card({ title, subtitle, children, style }) {
  return (
    <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20, ...style }}>
      <div style={{ fontSize:14, fontWeight:700, marginBottom: subtitle ? 4 : 14 }}>{title}</div>
      {subtitle && <div style={{ fontSize:11.5, color:'var(--text3)', marginBottom:14 }}>{subtitle}</div>}
      {children}
    </div>
  );
}

function Empty({ msg }) {
  return (
    <div style={{ height:240, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text3)', fontSize:12 }}>
      {msg}
    </div>
  );
}

function Skeleton() {
  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(170px, 1fr))', gap:12, marginBottom:20 }}>
        {[...Array(8)].map((_, i) => (
          <div key={i} style={{ height:80, borderRadius:12, background:'var(--bg3)', animation:'pulse 1.5s ease-in-out infinite' }} />
        ))}
      </div>
      <div style={{ height:260, borderRadius:12, background:'var(--bg2)', marginBottom:16, animation:'pulse 1.5s ease-in-out infinite' }} />
      <div style={{ height:260, borderRadius:12, background:'var(--bg2)', marginBottom:16, animation:'pulse 1.5s ease-in-out infinite' }} />
    </div>
  );
}

function ErrorBox({ msg, onRetry }) {
  return (
    <div style={{ textAlign:'center', padding:'40px 0' }}>
      <div style={{ color:'var(--danger)', marginBottom:12, fontSize:14 }}>Failed to load: {msg}</div>
      <button
        onClick={onRetry}
        style={{ padding:'8px 20px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontWeight:600 }}
      >
        Retry
      </button>
    </div>
  );
}
