import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, ComposedChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getNoblAirPerformance, getNoblAirSubscribers, getNoblAirAttribution, fmt$, fmtNum, fmtPct } from '../utils/api';
import DateRangePicker from '../components/DateRangePicker';
import KpiCard from '../components/KpiCard';
import SheetTable from '../components/SheetTable';

/* ────────────── helpers ────────────── */
function toISO(d) { return d.toISOString().slice(0, 10); }
function startOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
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
const REGION_OPTIONS = [
  { value: 'ALL', label: 'All Regions' },
  { value: 'US',  label: 'USA' },
  { value: 'CA',  label: 'Canada' },
  { value: 'AUS', label: 'AUS' },
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

  function toggle(v) {
    const vv = String(v).toUpperCase();
    if (vv === 'ALL') {
      onChange(['ALL']);
      return;
    }
    if (selected.includes('ALL')) {
      onChange([vv]);
      return;
    }
    if (selected.includes(vv)) {
      onChange(selected.filter(x => x !== vv));
    } else {
      onChange([...selected, vv]);
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
                ? (selected.length === 1 && selected[0] === 'ALL')
                : selected.includes(opt.value);
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
                onClick={() => onChange(['ALL'])}
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
                onClick={() => setOpen(false)}
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
  'Date', 'Total Orders', 'Air Orders', 'Attach Rate', 'TTP Rate', 'Activation Rate',
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
    'Total Orders': r.total_orders,
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
      const [perf, subs] = await Promise.all([
        getNoblAirPerformance(range.start, range.end, 14, 0, regionParam),
        regionScoped ? Promise.resolve(null) : getNoblAirSubscribers(range.start, range.end),
      ]);
      setData({ rows: perf?.rows || [], totals: perf?.totals || {}, ttpCohort: perf?.ttp_cohort || {} });
      setSubData(subs || null);
      setLoading(false);

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
      totalOrders: t.total_orders || 0,
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

      {loading ? <Skeleton /> : error ? <ErrorBox msg={error} onRetry={load} /> : (
        <>
          {/* ── Top KPI row ── */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(170px, 1fr))', gap:12, marginBottom:20 }}>
            <KpiCard label="Air Orders"            value={fmtNum(kpi.airOrders)}            color="nobl" />
            <KpiCard label="Overall Attach Rate"   value={fmtPct(kpi.attachRate || 0)}      color="teal" />
            <KpiCard label="Overall TTP Rate"      value={fmtPct(kpi.ttpRate || 0)}         color="purple" />
            <KpiCard label="Overall Activation"    value={fmtPct(kpi.activationRate || 0)}  color="green" />
            <KpiCard label="Combined Net Revenue"  value={fmt$(kpi.combinedNetRevenue)}     color="blue" />
            <KpiCard label="Rebill Revenue"        value={fmt$(kpi.rebillRevenue)}          color="warn" />
            {!regionScoped && <KpiCard label="Active Subscribers" value={fmtNum(kpi.activeSubs)} color="green" />}
            {!regionScoped && <KpiCard label="Active ARR (est.)" value={fmt$(kpi.activeArr)} color="purple" />}
          </div>

          {/* ── Secondary KPI row ── */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:12, marginBottom:20 }}>
            <KpiCard label="Total Orders"      value={fmtNum(kpi.totalOrders)}      color="text" />
            <KpiCard label="Paid Air Orders"   value={fmtNum(kpi.paidAirOrders)}    color="nobl" />
            <KpiCard label="$0 Air Orders"     value={fmtNum(kpi.zeroAirOrders)}    color="warn" />
            <KpiCard label="Mature Subs"       value={fmtNum(kpi.matureSubs)}       color="purple" />
            <KpiCard label="Converted Mature"  value={fmtNum(kpi.convertedMatureSubs)} color="green" />
            <KpiCard label="30-Day Cancels"    value={fmtNum(kpi.cancelled30d)}     color="red" />
            <KpiCard label="30-Day Cancel Rate" value={fmtPct(kpi.cancelRate30d || 0)} color="red" />
            <KpiCard label="New Sub Revenue"   value={fmt$(kpi.newSubRevenue)}      color="blue" />
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
