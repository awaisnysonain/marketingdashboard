import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, ComposedChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  LineChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getNoblAirPerformance, getNoblAirSubscribers, getNoblAirAttribution, fmt$, fmtNum, fmtPct } from '../utils/api';
import DateRangePicker from '../components/DateRangePicker';
import KpiCard from '../components/KpiCard';
import SheetTable from '../components/SheetTable';

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
  airOrders: 'Air Orders\nData: SUM air_orders for the selected Performance date range.\nFormula: count of NOBL orders with NOBLAIR + luggage. This matches Forecast Actual Air Orders for the same period.',
  attachRate: 'Overall Attach Rate\nData: selected Performance date range.\nFormula: SUM(Air Orders) / SUM(Air-Eligible Orders). Air-Eligible Orders are non-rebill NOBL orders. This is the same formula used by Forecast Actual Attach for the same period.',
  ttpRate: 'Overall TTP Rate\nData: all mature subscribers as of the selected Performance end date.\nFormula: converted mature subscribers / mature subscribers. Mature = created at least 14 days before end date. Converted = Appstle paid billing after creation OR Shopify rebill after creation. This matches Forecast Actual TTP for the same period end date.',
  activationRate: 'Overall Activation\nFormula: Overall Attach Rate x Overall TTP Rate for the selected Performance date range. Forecast Actual Activation uses this same formula for the same period.\nDaily rows use attach rate from 14 days prior x that day\'s TTP cohort.',
  combinedNetRevenue: 'Combined Net Revenue\nData: selected date range from NOBL Air daily aggregate.\nFormula: tag_gross + sub_gross - tag_discounts - sub_discounts - tag_refunds - sub_refunds + Appstle rebill revenue.',
  rebillRevenue: 'Rebill Revenue\nData: selected date range.\nSource: Appstle lastSuccessfulOrder.orderAmount bucketed by billing date.',
  activeSubscribers: 'Active Subscribers\nData: all NOBL Air subscribers.\nFormula: count where Appstle status = active.',
  activeArr: 'Active ARR (est.)\nData: all active NOBL Air subscribers.\nFormula: SUM(contract_amount) for active subscriptions. Label is kept as ARR estimate in the dashboard.',
  eligibleOrders: 'Air-Eligible Orders\nData: selected Performance date range.\nFormula: count of NOBL Shopify orders where is_rebill = false. This is the denominator for Overall Attach Rate and matches Forecast Actual Eligible Orders for the same period.',
  paidAirOrders: 'Paid Air Orders\nData: selected date range.\nFormula: count of orders with NOBLAIR + luggage + paid NOBLAIR line.',
  zeroAirOrders: '$0 Air Orders\nData: selected date range.\nFormula: count of orders with NOBLAIR + luggage + zero-price NOBLAIR line.',
  matureSubs: 'Mature Subs\nData: all subscribers mature as of selected end date.\nFormula: count of NOBL Air subscribers where UTC created_at date <= end date - 14 days.',
  convertedMature: 'Converted Mature\nData: mature subscriber cohort as of selected end date.\nFormula: count of mature subscribers with Appstle paid billing after creation OR Shopify rebill after creation.',
  cancels30d: '30-Day Cancels\nData: mature subscribers as of selected end date.\nFormula: count where cancelled_on <= created_at + 30 days.',
  cancelRate30d: '30-Day Cancel Rate\nData: mature subscribers as of selected end date.\nFormula: 30-day cancels / mature subscribers.',
  newSubRevenue: 'New Sub Revenue\nData: selected date range.\nFormula: sub_gross - sub_discounts for new non-rebill subscription orders.',
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
  'Date', 'Air-Eligible Orders', 'Air Orders', 'Attach Rate', 'TTP Rate', 'Activation Rate',
  '$0 Air', 'Paid Air', 'Rebill', 'Same-Day Cancel',
  'Tag Net Sales', 'Sub Net Sales', 'Rebill Revenue', 'New Sub Revenue', 'Combined Net Revenue',
  'New $79', 'New $99', 'New $119', 'New $129', 'New $139', 'New $149',
  'Rebill $79', 'Rebill $99', 'Rebill $119', 'Rebill $129', 'Rebill $139', 'Rebill $149',
];

const AIR_ATTR_HEADERS = [
  'Ad', 'Ad ID', 'Ad Set', 'Campaign', 'Total Attributed Orders', 'Air Orders', 'Attributed Air Orders',
  'Attach Rate', 'TTP Mature Air Orders', 'TTP Paid Air Orders', 'TTP Rate', 'Activation Rate',
  'Attributed Air Revenue',
];

function toTableRow(r) {
  return {
    'Date': r.date,
    'Air-Eligible Orders': r.total_orders,
    'Air Orders': r.air_orders,
    'Attach Rate': r.attach_rate,
    'TTP Rate': r.ttp_rate,
    'Activation Rate': r.activation_rate,
    '$0 Air': r.zero_air_orders,
    'Paid Air': r.paid_air_orders,
    'Rebill': r.rebill_orders,
    'Same-Day Cancel': r.same_day_cancels,
    'Tag Net Sales': r.tag_net_sales,
    'Sub Net Sales': r.sub_net_sales,
    'Rebill Revenue': r.rebill_revenue,
    'New Sub Revenue': r.new_sub_revenue,
    'Combined Net Revenue': r.combined_net_revenue,
    'New $79':   r.new_79,
    'New $99':   r.new_99,
    'New $119':  r.new_119,
    'New $129':  r.new_129,
    'New $139':  r.new_139,
    'New $149':  r.new_149,
    'Rebill $79':  r.rebill_79,
    'Rebill $99':  r.rebill_99,
    'Rebill $119': r.rebill_119,
    'Rebill $129': r.rebill_129,
    'Rebill $139': r.rebill_139,
    'Rebill $149': r.rebill_149,
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
    'Ad Set': r.adset_name || 'Unknown ad set',
    'Campaign': r.campaign_name,
    'Total Attributed Orders': r.total_attributed_orders,
    'Air Orders': r.air_orders,
    'Attributed Air Orders': r.attributed_air_orders,
    'Attach Rate': r.attach_rate,
    'TTP Mature Air Orders': r.ttp_mature_air_orders,
    'TTP Paid Air Orders': r.ttp_paid_air_orders,
    'TTP Rate': r.ttp_rate,
    'Activation Rate': r.activation_rate,
    'Attributed Air Revenue': r.attributed_air_revenue,
    _ad: [r.campaign_id, r.adset_id, r.ad_id, r.ad_name].map(v => v || '').join('|'),
  };
}

/* ────────────── PAGE ────────────── */
export default function NoblAirPerformancePage() {
  // Default range: current month-to-date.
  const [range, setRange] = useState({ start: startOfMonthISO(), end: toISO(new Date()) });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ rows: [], totals: {} });
  const [subData, setSubData] = useState(null);
  const [airAttr, setAirAttr] = useState({ rows: [], totals: {}, error: null });
  const [airAttrLoading, setAirAttrLoading] = useState(false);
  const [regions, setRegions] = useState(['ALL']);
  const [activeTab, setActiveTab] = useState('performance');

  const regionParam = useMemo(() => regionsParam(regions), [regions]);
  const regionScoped = regionParam !== 'ALL';

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    setAirAttrLoading(true);
    setAirAttr({ rows: [], totals: {}, error: null });
    try {
      const attrPromise = regionScoped
        ? Promise.resolve({ rows: [], totals: {}, error: null })
        : getNoblAirAttribution(range.start, range.end, 'ad').catch(e => ({ rows: [], totals: {}, error: e.message }));
      const subsPromise = regionScoped
        ? Promise.resolve(null)
        : getNoblAirSubscribers(range.start, range.end).catch(() => null);
      const perf = await getNoblAirPerformance(range.start, range.end, 14, 0, regionParam);
      setData({
        rows: perf?.rows || [],
        totals: perf?.totals || {},
        ttpCohort: perf?.ttp_cohort || {},
        revenueForecast: perf?.revenue_forecast || null,
      });
      setSubData(null);
      setLoading(false);

      const subs = await subsPromise;
      setSubData(subs || null);

      const attr = await attrPromise;
      setAirAttr(attr || { rows: [], totals: {}, error: null });
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
      setAirAttrLoading(false);
    }
  }, [range, regionParam, regionScoped]);

  useEffect(() => { load(); }, [load]);

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
    () => (airAttr?.rows || []).slice(0, 10).map(r => ({ ...r, chart_label: shortName(r.ad_name || r.adset_name, 24) })),
    [airAttr]
  );

  /* ── KPIs from performance totals: range attach × cohort TTP ── */
  const kpi = useMemo(() => {
    const t = data.totals || {};
    const ttp = t.ttp_rate;
    const attach = t.attach_rate;
    const activation = (attach != null && ttp != null) ? attach * ttp : null;
    const ttpCohort = data.ttpCohort || {};
    return {
      eligibleOrders: t.total_orders || 0,
      airOrders: t.air_orders || 0,
      attachRate: attach,
      ttpRate: ttp,                 // ← from nobl_air_subscribers cohort
      activationRate: activation,
      matureSubs: ttpCohort.mature || 0,
      convertedMatureSubs: ttpCohort.converted || 0,
      cancelled30d: ttpCohort.cancelled_30d || 0,
      cancelRate30d: ttpCohort.cancel_rate_30d,
      paidAirOrders: t.paid_air_orders || 0,
      zeroAirOrders: t.zero_air_orders || 0,
      sameDayCancels: !regionScoped ? (subData?.ttp_cohort?.same_day_cancels || t.same_day_cancels || 0) : (t.same_day_cancels || 0),
      combinedNetRevenue: t.combined_net_revenue || 0,
      rebillRevenue: t.rebill_revenue || 0,
      newSubRevenue: t.new_sub_revenue || 0,
      activeSubs: !regionScoped ? (subData?.active_count || 0) : null,
      activeArr:  !regionScoped ? (subData?.active_arr || 0) : null,
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
  const revenueForecast = data.revenueForecast;
  const forecastAssumptions = revenueForecast?.assumptions || {};
  const forecastRows = revenueForecast?.rows || [];
  const forecastFullYear = revenueForecast?.full_year || null;
  const forecastTableRows = useMemo(
    () => [...forecastRows, forecastFullYear].filter(Boolean),
    [forecastRows, forecastFullYear]
  );
  const currentForecastRow = useMemo(
    () => forecastRows.find(r => r.row_type === 'current_projection'),
    [forecastRows]
  );
  const hasActualForecastData = (row) => ['actual', 'current_projection', 'total'].includes(row?.row_type);
  const fmtActualCurrency = (row, field) => hasActualForecastData(row) ? fmt$(row?.[field]) : '—';
  const fmtActualNumber = (row, field) => hasActualForecastData(row) ? fmtNum(row?.[field]) : '—';
  const fmtActualPct = (row, field) => hasActualForecastData(row) ? fmtPct(row?.[field]) : '—';
  const fmtMaybeNumber = (value) => value === null || value === undefined ? '—' : fmtNum(value);
  const forecastChartRows = useMemo(
    () => forecastRows.map(row => hasActualForecastData(row)
      ? row
      : { ...row, actual_store_revenue: null, actual_orders: null }),
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
        <div>
          <h1 style={{ fontSize:22, fontWeight:800, margin:0, fontFamily:'var(--font-head)', color:'#6366f1' }}>
            NOBL Air Performance
          </h1>
          <p style={{ margin:'4px 0 0', fontSize:13, color:'var(--text3)' }}>
            Subscription product launched March 2026 · attach rate, TTP, tier mix, revenue split
          </p>
        </div>
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
          ['performance', 'Performance'],
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
            <KpiCard label="Air Orders"            value={fmtNum(kpi.airOrders)}            color="nobl" tooltip={KPI_TOOLTIPS.airOrders} />
            <KpiCard label="Overall Attach Rate"   value={fmtPct(kpi.attachRate || 0)}      color="teal" tooltip={KPI_TOOLTIPS.attachRate} />
            <KpiCard label="Overall TTP Rate"      value={fmtPct(kpi.ttpRate || 0)}         color="purple" tooltip={KPI_TOOLTIPS.ttpRate} />
            <KpiCard label="Overall Activation"    value={fmtPct(kpi.activationRate || 0)}  color="green" tooltip={KPI_TOOLTIPS.activationRate} />
            <KpiCard label="Combined Net Revenue"  value={fmt$(kpi.combinedNetRevenue)}     color="blue" tooltip={KPI_TOOLTIPS.combinedNetRevenue} />
            <KpiCard label="Rebill Revenue"        value={fmt$(kpi.rebillRevenue)}          color="warn" tooltip={KPI_TOOLTIPS.rebillRevenue} />
            {!regionScoped && <KpiCard label="Active Subscribers" value={fmtNum(kpi.activeSubs)} color="green" tooltip={KPI_TOOLTIPS.activeSubscribers} />}
            {!regionScoped && <KpiCard label="Active ARR (est.)" value={fmt$(kpi.activeArr)} color="purple" tooltip={KPI_TOOLTIPS.activeArr} />}
          </div>

          {/* ── Secondary KPI row ── */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:12, marginBottom:20 }}>
            <KpiCard label="Air-Eligible Orders" value={fmtNum(kpi.eligibleOrders)} color="text" tooltip={KPI_TOOLTIPS.eligibleOrders} />
            <KpiCard label="Paid Air Orders"   value={fmtNum(kpi.paidAirOrders)}    color="nobl" tooltip={KPI_TOOLTIPS.paidAirOrders} />
            <KpiCard label="$0 Air Orders"     value={fmtNum(kpi.zeroAirOrders)}    color="warn" tooltip={KPI_TOOLTIPS.zeroAirOrders} />
            <KpiCard label="Mature Subs"       value={fmtNum(kpi.matureSubs)}       color="purple" tooltip={KPI_TOOLTIPS.matureSubs} />
            <KpiCard label="Converted Mature"  value={fmtNum(kpi.convertedMatureSubs)} color="green" tooltip={KPI_TOOLTIPS.convertedMature} />
            <KpiCard label="30-Day Cancels"    value={fmtNum(kpi.cancelled30d)}     color="red" tooltip={KPI_TOOLTIPS.cancels30d} />
            <KpiCard label="30-Day Cancel Rate" value={fmtPct(kpi.cancelRate30d || 0)} color="red" tooltip={KPI_TOOLTIPS.cancelRate30d} />
            <KpiCard label="New Sub Revenue"   value={fmt$(kpi.newSubRevenue)}      color="blue" tooltip={KPI_TOOLTIPS.newSubRevenue} />
          </div>

          {/* ── Row 1: revenue trend + attach/TTP trend ── */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
            <Card title="Combined Net Revenue Trend">
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
                  <Area type="monotone" dataKey="combined_net_revenue" name="Combined Net Revenue" stroke="#6366f1" fill="url(#revGradAir)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Daily Attach / TTP / Activation" subtitle="Daily TTP uses the cohort that reached day 14 that day; daily activation = attach from 14 days earlier × daily TTP.">
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
                  <Bar  yAxisId="orders" dataKey="air_orders"      name="Air Orders"      fill="#6366f1" radius={[2,2,0,0]} />
                  <Line yAxisId="rates"  dataKey="attach_rate"     name="Attach Rate"     stroke="#14b8a6" strokeWidth={2} dot={false} />
                  <Line yAxisId="rates"  dataKey="ttp_rate"        name="TTP Rate"        stroke="#f59e0b" strokeWidth={2} dot={false} />
                  <Line yAxisId="rates"  dataKey="activation_rate" name="Activation Rate" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          </div>

          {/* ── Row 2: tier mix bar + status pie ── */}
          {!regionScoped && (
          <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:16, marginBottom:16 }}>
            <Card title="Subscriber Tier Mix" subtitle="Active / Cancelled / Paused per tier">
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
          <Card title="Revenue Composition (Tag + Sub + Rebill)" style={{ marginBottom:16 }}>
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
          <Card title="NOBL Air Purchases by Meta Ad" subtitle="Only ads with NOBL Air sales. Attach uses selected-range sales; TTP uses cohorts reaching day 14 in the selected range." style={{ marginBottom:16 }}>
            {airAttrLoading ? (
              <div style={{ height:260, borderRadius:12, background:'var(--bg3)', animation:'pulse 1.5s ease-in-out infinite' }} />
            ) : airAttr?.error ? (
              <div style={{ color:'var(--danger)', fontSize:13 }}>NOBL Air ad attribution unavailable: {airAttr.error}</div>
            ) : airAttrRows.length === 0 ? <Empty msg="No NOBL Air ad attribution data yet. Run tw_air_attribution sync for this date range." /> : (
              <>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:12, marginBottom:16 }}>
                  <KpiCard label="Air Orders" value={fmtNum(airAttr.totals?.air_orders || 0)} />
                  <KpiCard label="Total Attributed Orders" value={fmtNum(airAttr.totals?.total_attributed_orders || 0)} />
                  <KpiCard label="Attributed Air Orders" value={fmtNum(airAttr.totals?.attributed_air_orders || 0)} />
                  <KpiCard label="Attach Rate" value={fmtPct(airAttr.totals?.attach_rate || 0)} />
                  <KpiCard label="TTP Rate" value={fmtPct(airAttr.totals?.ttp_rate || 0)} />
                  <KpiCard label="Activation Rate" value={fmtPct(airAttr.totals?.activation_rate || 0)} />
                  <KpiCard label="Attributed Air Revenue" value={fmt$(airAttr.totals?.attributed_air_revenue || 0)} />
                </div>

                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={airAttrChartRows} margin={{ top:4, right:16, left:0, bottom:72 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="chart_label" tick={{ fontSize:10 }} stroke="var(--border2)" angle={-30} textAnchor="end" interval={0} height={72} />
                    <YAxis yAxisId="orders" tick={{ fontSize:11 }} width={56} stroke="var(--border2)" />
                    <YAxis yAxisId="revenue" orientation="right" tickFormatter={(v) => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                    <Tooltip
                      formatter={(v, n) => n === 'Attributed Air Revenue' ? [fmt$(v), n] : [fmtNum(v), n]}
                      contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }}
                    />
                    <Legend wrapperStyle={{ fontSize:12 }} />
                    <Bar yAxisId="orders" dataKey="attributed_air_orders" name="Attributed Air Orders" fill="#1877f2" radius={[2,2,0,0]} />
                    <Line yAxisId="revenue" dataKey="attributed_air_revenue" name="Attributed Air Revenue" stroke="#22c55e" strokeWidth={2} dot={{ r:3 }} />
                  </ComposedChart>
                </ResponsiveContainer>

                <SheetTable
                  headers={AIR_ATTR_HEADERS}
                  rows={airAttrRows}
                  keyField="_ad"
                  maxHeight="520px"
                  defaultSortField="Attributed Air Orders"
                  defaultSortDir="desc"
                />
              </>
            )}
          </Card>
          )}

          {/* ── Daily detail table ── */}
          <Card title="Daily Detail" subtitle="Daily TTP uses cohorts reaching day 14 on each date; daily activation uses attach from 14 days earlier.">
            <SheetTable
              headers={HEADERS}
              rows={tableRows}
              keyField="_date"
              maxHeight="620px"
              defaultSortField="Date"
              defaultSortDir="desc"
            />
          </Card>
          </>
          )}

          {activeTab === 'forecast' && !regionScoped && revenueForecast && (
          <>
            <Card title="NOBL Air Revenue Forecast — Live Model" subtitle="Forecast assumptions refresh from live database/dashboard data; the sheet was only context for model structure." style={{ marginBottom: 16 }}>
              {currentForecastRow && (
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(180px, 1fr))', gap:10, marginBottom:14 }}>
                  <KpiCard size="sm" label="Current Month Actual Store Rev" value={fmt$(currentForecastRow.actual_store_revenue)} tooltip="Actual NOBL order revenue month-to-date through the latest completed ETL date, including rebills. Formula: Gross Sales - Discounts + Taxes + Shipping." />
                  <KpiCard size="sm" label="Current Month Actual Orders" value={fmtNum(currentForecastRow.actual_orders)} tooltip="Actual NOBL store orders month-to-date through the latest completed ETL date, including rebills." />
                  <KpiCard size="sm" label="Current Month Actual Air Rev" value={fmt$(currentForecastRow.actual_air_rev_net)} tooltip="Actual NOBL Air combined net revenue MTD. This matches Performance Combined Net Revenue when Performance is set to the same MTD date range." />
                  <KpiCard size="sm" label="Current Month Projected Store Rev" value={fmt$(currentForecastRow.store_revenue)} tooltip="Actual MTD store revenue multiplied by days in month / completed days." />
                  <KpiCard size="sm" label="Current Month Projected Orders" value={fmtNum(currentForecastRow.orders)} tooltip="Actual MTD orders multiplied by days in month / completed days." />
                  <KpiCard size="sm" label="Current Month Projected Air Rev" value={fmt$(currentForecastRow.total_air_rev_net_est)} tooltip="Actual MTD NOBL Air combined net revenue multiplied by days in month / completed days." />
                  <KpiCard size="sm" label="Current Month Eligible Orders" value={fmtNum(currentForecastRow.eligible_orders)} tooltip="Projected non-rebill store orders. Attach rate applies to this eligible order base, not to rebill orders." />
                </div>
              )}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:10 }}>
                <KpiCard size="sm" label="Forecast Activation" value={fmtPct(forecastAssumptions.forecast_activation_rate)} tooltip="Main forecast assumption. Formula: Overall Attach Rate × Overall TTP Rate, matching the Performance KPI definition." />
                <KpiCard size="sm" label="Rolling 7d Perf Activation" value={fmtPct(forecastAssumptions.rolling_7d_activation_rate)} tooltip="Reference only. Weighted average of daily Performance activation_rate over the latest 7 complete days." />
                <KpiCard size="sm" label="AOV" value={fmt$(forecastAssumptions.avg_revenue_per_store_order)} tooltip="Formula: selected-period order revenue / selected-period store orders, including rebills. Order revenue = Gross Sales - Discounts + Taxes + Shipping." />
                <KpiCard size="sm" label="Eligible Order Rate" value={fmtPct(forecastAssumptions.eligible_order_rate)} tooltip="Formula: non-rebill store orders / all store orders. Used to convert total target orders into Air-eligible orders." />
                <KpiCard size="sm" label="Avg Converted Tier" value={fmt$(forecastAssumptions.avg_tier_price_converted_subs)} tooltip="Formula: average Appstle contract amount for converted subscribers." />
                <KpiCard size="sm" label="Tag Net / Air Order" value={fmt$(forecastAssumptions.tag_net_sales_per_air_order)} tooltip="Formula: selected-period Tag Net Sales / Air Orders." />
                <KpiCard size="sm" label="Blended Net / Air Order" value={fmt$(forecastAssumptions.blended_net_rev_per_air_order)} tooltip="Formula: selected-period Combined Net Revenue / Air Orders." />
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
                    <Bar dataKey="store_revenue" name="Projected/Target Revenue" fill="#14b8a6" radius={[3,3,0,0]} />
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
                    <Bar yAxisId="rev" dataKey="store_revenue" name="Store Revenue" fill="#14b8a6" />
                    <Bar yAxisId="rev" dataKey="actual_store_revenue" name="Actual Revenue" fill="#22c55e" />
                    <Line yAxisId="orders" type="monotone" dataKey="orders" name="Orders" stroke="#f59e0b" strokeWidth={2} dot={false} />
                    <Line yAxisId="orders" type="monotone" dataKey="actual_orders" name="Actual Orders" stroke="#22c55e" strokeWidth={2} dot={false} />
                    <Line yAxisId="orders" type="monotone" dataKey="est_air_orders" name="Est. Air Orders" stroke="#6366f1" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Card>
            </div>

            <Card title="Monthly Forecast Detail" subtitle="Actual columns match the Performance tab for the same date period. The single Full Year Total row shows actuals through latest ETL and full-year forecast/projection columns separately." style={{ marginBottom: 16 }}>
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <thead>
                    <tr style={{ color:'var(--text3)', borderBottom:'1px solid var(--border)' }}>
                      {['Month','Status','Actual Store Rev','Actual Store Orders','Actual Eligible Orders','Actual Air Orders','Actual Attach','Actual TTP','Actual Activation','Actual Tag Rev','Actual Sub Rev','Actual Rebill Rev','Actual Air Rev','Projected/Target Store Rev','Projected/Target Store Orders','AOV','Forecast Air Orders','Forecast Activations','Forecast Attach','Forecast Activation','Forecast Air Rev','Source'].map(h => (
                        <th key={h} style={{ textAlign: h === 'Month' || h === 'Source' ? 'left' : 'right', padding:'8px 10px', fontWeight:600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {forecastTableRows.map((r, idx) => {
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
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmt$(r.store_revenue)}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtMaybeNumber(r.orders)}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmt$(r.aov)}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtMaybeNumber(r.est_air_orders)}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtMaybeNumber(r.est_activations)}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtPct(r.attach_rate)}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtPct(r.activation_rate)}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmt$(r.total_air_rev_net_est)}</td>
                        <td style={{ padding:'8px 10px', color:'var(--text3)', whiteSpace:'nowrap' }} title={r.order_source || undefined}>{forecastSourceLabel(r)}</td>
                      </tr>
                    );})}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
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
