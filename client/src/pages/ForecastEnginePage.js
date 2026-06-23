import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { getDashboardForecast, fmt$, fmtNum, fmtPct, fmtRatio } from '../utils/api';
import TablePagination from '../components/TablePagination';
import PageIntro from '../components/PageIntro';
import KpiCard from '../components/KpiCard';
import ChartPanel from '../components/ChartPanel';
import { useClientPagination } from '../hooks/useClientPagination';
import { TABLE_PAGE_SIZE } from '../constants/pagination';
import { L } from '../copy/plainLanguage';

const TAB_META = [
  ['overview', 'Overview'],
  ['nobl-monthly', 'NOBL Monthly'],
  ['nobl-daily', 'NOBL Daily'],
  ['air-monthly', 'NOBL Air Monthly'],
  ['air-daily', 'NOBL Air Daily'],
  ['methodology', 'Methodology'],
];

const money = (n) => (n === null || n === undefined ? '—' : fmt$(n));
const num = (n) => (n === null || n === undefined ? '—' : fmtNum(n));
const pct = (n) => (n === null || n === undefined ? '—' : fmtPct(n));
const mer = (n) => (n === null || n === undefined ? '—' : fmtRatio(n));
const tooltipStyle = { background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:10, fontSize:12, boxShadow:'0 8px 22px rgba(15,23,42,.10)' };

function monthOptionLabel(key) {
  if (!key || key === 'all') return 'All months';
  if (key === 'current') return 'Current month ongoing';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const idx = Number(String(key).slice(5, 7)) - 1;
  return `${months[idx] || key} ${String(key).slice(0, 4)}`;
}

function rowText(row) {
  return Object.values(row || {}).map(v => String(v ?? '')).join(' ').toLowerCase();
}

function filterRows(rows, { monthFilter, currentMonthKey, typeFilter, search }) {
  const q = String(search || '').trim().toLowerCase();
  return (rows || []).filter(row => {
    const mk = row.month_key || String(row.date || '').slice(0, 7);
    const type = String(row.row_type || row.status_label || row.status || '').toLowerCase();
    const monthOk = monthFilter === 'all' || (monthFilter === 'current' ? mk === currentMonthKey : mk === monthFilter);
    const typeOk = typeFilter === 'all'
      || (typeFilter === 'projected' ? (type.includes('project') || type.includes('projection') || type.includes('future') || type.includes('target')) : type.includes(typeFilter));
    const searchOk = !q || rowText(row).includes(q);
    return monthOk && typeOk && searchOk;
  });
}

function monthOptionsFromRows(...groups) {
  const keys = new Set();
  groups.flat().forEach(r => {
    const mk = r?.month_key || String(r?.date || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(mk)) keys.add(mk);
  });
  return [...keys].sort();
}

function Pill({ value }) {
  const text = String(value || '—');
  const lower = text.toLowerCase();
  const good = lower.includes('actual') || lower.includes('target met') || lower === 'green' || lower.includes('track');
  const warn = lower.includes('missing') || lower.includes('watch') || lower === 'amber' || lower.includes('pending');
  const bad = lower.includes('below') || lower === 'red' || lower.includes('off');
  const variant = bad ? 'danger' : warn ? 'warn' : good ? 'success' : 'accent';
  return <span className={`badge badge--${variant}`}>{text}</span>;
}

function DataTable({ columns, rows, page, pageSize, totalRows, onPageChange, footer }) {
  return (
    <div style={{ overflowX:'auto', border:'1px solid var(--border)', borderRadius:14 }}>
      <table style={{ width:'100%', borderCollapse:'separate', borderSpacing:0, fontSize:12 }}>
        <thead><tr style={{ color:'var(--text3)', background:'var(--bg3)' }}>
          {columns.map(c => <th key={c.key || c.label} style={{ textAlign:c.align || 'right', padding:'10px 12px', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{c.label}</th>)}
        </tr></thead>
        <tbody>{rows.length === 0 ? (
          <tr><td colSpan={columns.length} style={{ padding:18, color:'var(--text3)', textAlign:'center' }}>No rows match the selected filters.</td></tr>
        ) : rows.map((r, i) => <tr key={r.date || r.month_key || `${r.month}-${i}`} style={{ color:'var(--text2)' }}>
          {columns.map(c => <td key={c.key || c.label} style={{ padding:'10px 12px', textAlign:c.align || 'right', whiteSpace:c.wrap ? 'normal' : 'nowrap', borderBottom:'1px solid var(--border)', fontVariantNumeric:'tabular-nums', minWidth:c.minWidth }}>
            {c.render ? c.render(r) : r[c.key]}
          </td>)}
        </tr>)}</tbody>
        {footer}
      </table>
      {page && <TablePagination page={page} pageSize={pageSize} totalRows={totalRows} onPageChange={onPageChange} />}
    </div>
  );
}

export default function ForecastEnginePage() {
  const [activeTab, setActiveTab] = useState('overview');
  const [asOf, setAsOf] = useState('');
  const [monthFilter, setMonthFilter] = useState('current');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDashboardForecast(asOf)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [asOf]);

  const noblMonthly = data?.nobl?.monthly || [];
  const noblDaily = data?.nobl?.daily || [];
  const airMonthly = data?.air?.monthly || [];
  const airDaily = data?.air?.daily || [];
  const airMonthlyWithTotal = useMemo(() => [...airMonthly, data?.air?.full_year].filter(Boolean), [airMonthly, data?.air?.full_year]);
  const currentMonthKey = String(data?.as_of || data?.air_as_of || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const monthOptions = useMemo(() => monthOptionsFromRows(noblMonthly, noblDaily, airMonthly, airDaily), [noblMonthly, noblDaily, airMonthly, airDaily]);
  const filterState = { monthFilter, currentMonthKey, typeFilter, search };
  const filteredNoblMonthly = useMemo(() => filterRows(noblMonthly, filterState), [noblMonthly, monthFilter, currentMonthKey, typeFilter, search]);
  const filteredNoblDaily = useMemo(() => filterRows(noblDaily, filterState), [noblDaily, monthFilter, currentMonthKey, typeFilter, search]);
  const filteredAirMonthly = useMemo(() => filterRows(airMonthlyWithTotal, filterState), [airMonthlyWithTotal, monthFilter, currentMonthKey, typeFilter, search]);
  const filteredAirDaily = useMemo(() => filterRows(airDaily, filterState), [airDaily, monthFilter, currentMonthKey, typeFilter, search]);
  const currentNobl = noblMonthly.find(r => r.row_type === 'current_projection') || noblMonthly.find(r => r.month_key === String(data?.as_of || '').slice(0, 7));
  const currentAir = airMonthly.find(r => r.row_type === 'current_projection') || airMonthly.find(r => r.month_key === String(data?.air_as_of || '').slice(0, 7));

  const { page: noblDailyPage, setPage: setNoblDailyPage, pageItems: noblDailyItems, totalRows: noblDailyTotal } = useClientPagination(filteredNoblDaily, TABLE_PAGE_SIZE, [filteredNoblDaily.length, monthFilter, typeFilter, search]);
  const { page: airDailyPage, setPage: setAirDailyPage, pageItems: airDailyItems, totalRows: airDailyTotal } = useClientPagination(filteredAirDaily, TABLE_PAGE_SIZE, [filteredAirDaily.length, monthFilter, typeFilter, search]);

  const chartRows = noblMonthly.map(r => ({
    month: String(r.month || '').replace(' 2026', ''),
    nobl: r.projected_revenue || 0,
    plan: r.plan_revenue || 0,
    air: airMonthly.find(a => a.month_key === r.month_key)?.forecast_total_air_rev_net || 0,
  }));

  if (loading) return <div style={{ padding:20, color:'var(--text3)' }}>Loading database forecast…</div>;
  if (error) return <div style={{ padding:20, color:'var(--danger)' }}>Forecast error: {error}</div>;

  return (
    <div className="page-stack">
      <PageIntro
        actions={
          <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <span style={{ fontSize:11, color:'var(--text3)', fontWeight:700 }}>
              As of {data?.as_of || 'latest'} · Air {data?.air_as_of || 'latest'}
            </span>
            <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} style={controlStyle} />
            <button type="button" className="btn btn--sm" onClick={() => setAsOf('')}>Latest actuals</button>
          </div>
        }
      />

      <div className="seg" style={{ flexWrap:'wrap' }}>
        {TAB_META.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`seg__btn${activeTab === id ? ' seg__btn--active' : ''}`}
            onClick={() => setActiveTab(id)}
          >{label}</button>
        ))}
      </div>

      <FilterPanel
        activeTab={activeTab}
        monthFilter={monthFilter}
        setMonthFilter={setMonthFilter}
        typeFilter={typeFilter}
        setTypeFilter={setTypeFilter}
        search={search}
        setSearch={setSearch}
        monthOptions={monthOptions}
        currentMonthKey={currentMonthKey}
      />

      <CurrentMonthStrip currentMonthKey={currentMonthKey} currentNobl={currentNobl} currentAir={currentAir} />

      {activeTab === 'overview' && (
        <>
          <div className="section">
            <div className="section__title">FULL-YEAR FORECAST</div>
            <div className="page-kpi-grid">
              <KpiCard label="NOBL FY Forecast" value={money(data?.nobl?.full_year?.projected_revenue)} sub="Store sales P50" accent="nobl" />
              <KpiCard label="NOBL FY Plan" value={money(data?.nobl?.full_year?.plan_revenue)} sub={pct(data?.nobl?.full_year?.variance_pct)} accent="nobl" />
              <KpiCard label={`NOBL FY ${L.mer}`} value={mer(data?.nobl?.full_year?.projected_mer)} sub="Sales / ad spend" accent="nobl" />
              <KpiCard label="Air FY Forecast" value={money(data?.air?.full_year?.total_air_rev_net_est)} sub="Tag + sub + rebill estimate" accent="accent" />
              <KpiCard label="Air attach used" value={pct(data?.air?.assumptions?.overall_attach_rate)} sub="From nobl_air_daily" accent="accent" />
              <KpiCard label="Air activation used" value={pct(data?.air?.assumptions?.forecast_activation_rate)} sub="Trailing cohort basis" accent="accent" />
            </div>
          </div>
          <div className="chart-grid-2">
            <ChartPanel title="Monthly forecast overview" subtitle="NOBL store revenue vs plan, with NOBL Air forecast layered on the same month axis.">
              <ResponsiveContainer width="100%" height={330}>
                <ComposedChart data={chartRows} margin={{ top:8, right:18, left:0, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={fmt$} tick={{ fontSize:11 }} width={74} stroke="var(--border2)" />
                  <Tooltip formatter={(v, n) => [money(v), n]} contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  <Bar dataKey="nobl" name="NOBL P50" fill="var(--nobl)" radius={[3,3,0,0]} />
                  <Line dataKey="plan" name="NOBL Plan" stroke="var(--warn)" strokeWidth={2.5} dot={false} />
                  <Line dataKey="air" name="NOBL Air" stroke="var(--accent)" strokeWidth={2.5} dot={{ r:3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartPanel>
            <ChartPanel title="Current month focus" subtitle="Actual-to-date plus computed projection from the forecast engine (plan calendar + Triple Whale actuals).">
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <KpiCard label="NOBL current P50" value={money(currentNobl?.projected_revenue)} sub={currentNobl?.month} accent="nobl" />
                <KpiCard label="NOBL current status" value={String(currentNobl?.status || '—').toUpperCase()} sub={pct(currentNobl?.variance_pct)} accent={currentNobl?.status === 'red' ? 'danger' : currentNobl?.status === 'amber' ? 'warn' : 'success'} />
                <KpiCard label="Air current forecast" value={money(currentAir?.total_air_rev_net_est)} sub={currentAir?.month || currentAir?.month_label} accent="accent" />
                <KpiCard label="Air current actual" value={money(currentAir?.actual_air_rev_net)} sub="Actual Air revenue" accent="accent" />
              </div>
              <div style={{ marginTop:14, padding:12, borderRadius:14, background:'var(--bg3)', color:'var(--text2)', fontSize:13, lineHeight:1.65 }}>{data?.nobl?.narrative}</div>
            </ChartPanel>
          </div>
        </>
      )}

      {activeTab === 'nobl-monthly' && <NoblMonthly rows={filteredNoblMonthly} />}
      {activeTab === 'nobl-daily' && <NoblDaily rows={noblDailyItems} page={noblDailyPage} totalRows={noblDailyTotal} onPageChange={setNoblDailyPage} />}
      {activeTab === 'air-monthly' && <AirMonthly rows={filteredAirMonthly} />}
      {activeTab === 'air-daily' && <AirDaily rows={airDailyItems} page={airDailyPage} totalRows={airDailyTotal} onPageChange={setAirDailyPage} />}
      {activeTab === 'methodology' && <Methodology data={data} />}
    </div>
  );
}

function FilterPanel({ activeTab, monthFilter, setMonthFilter, typeFilter, setTypeFilter, search, setSearch, monthOptions, currentMonthKey }) {
  const typeOptions = [
    ['all', 'All row types'],
    ['actual', 'Actual'],
    ['projected', 'Projected / Forecast'],
    ['missing', 'Missing actuals'],
    ['target', 'Target'],
  ];
  return (
    <section className="card card--pad" style={{
      display:'grid', gridTemplateColumns:'minmax(220px, .85fr) minmax(180px, .65fr) minmax(260px, 1fr) auto', gap:10,
      alignItems:'center',
    }}>
      <div>
        <div style={filterLabel}>Month</div>
        <select value={monthFilter} onChange={e => setMonthFilter(e.target.value)} style={controlStyle}>
          <option value="current">Current month ongoing ({monthOptionLabel(currentMonthKey)})</option>
          <option value="all">All months</option>
          {monthOptions.map(m => <option key={m} value={m}>{monthOptionLabel(m)}</option>)}
        </select>
      </div>
      <div>
        <div style={filterLabel}>Row type</div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={controlStyle}>
          {typeOptions.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </div>
      <div>
        <div style={filterLabel}>Search</div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search sale, drop, reason, status…" style={controlStyle} />
      </div>
      <button type="button" className="btn" style={{ alignSelf:'end' }} onClick={() => { setMonthFilter('current'); setTypeFilter('all'); setSearch(''); }}>
        Reset to current
      </button>
      <div style={{ gridColumn:'1 / -1', fontSize:11, color:'var(--text3)', lineHeight:1.45 }}>
        Showing <strong>{activeTab.replace('-', ' ')}</strong>. Default is always the ongoing current month so you see what is happening now first.
      </div>
    </section>
  );
}

function CurrentMonthStrip({ currentMonthKey, currentNobl, currentAir }) {
  return (
    <div className="section">
      <div className="section__title">CURRENT MONTH ONGOING · {monthOptionLabel(currentMonthKey)}</div>
      <div className="page-kpi-grid">
        <KpiCard label="NOBL current P50" value={money(currentNobl?.projected_revenue)} sub={pct(currentNobl?.variance_pct)} accent="nobl" />
        <KpiCard label={`NOBL current ${L.mer}`} value={mer(currentNobl?.projected_mer)} sub={`Target ${mer(currentNobl?.mer_target)}`} accent="nobl" />
        <KpiCard label="Air current forecast" value={money(currentAir?.total_air_rev_net_est)} sub="Forecast Air revenue" accent="accent" />
        <KpiCard label="Air actual so far" value={money(currentAir?.actual_air_rev_net)} sub="Database actual" accent="accent" />
      </div>
    </div>
  );
}

function NoblMonthly({ rows }) {
  const columns = [
    { label:'Month', key:'month', align:'left' },
    { label:'Type', align:'left', render:r => <Pill value={r.row_type} /> },
    { label:L.planTarget, render:r => money(r.plan_revenue) },
    { label:`Actual ${L.sales}`, render:r => money(r.actual_revenue) },
    { label:`P50 ${L.sales}`, render:r => money(r.projected_revenue) },
    { label:'P25', render:r => money(r.p25) },
    { label:'P75', render:r => money(r.p75) },
    { label:L.variance, render:r => pct(r.variance_pct) },
    { label:`Projected ${L.mer}`, render:r => mer(r.projected_mer) },
    { label:`${L.mer} Target`, render:r => mer(r.mer_target) },
    { label:'Reason', align:'left', wrap:true, minWidth:320, render:r => r.reason },
  ];
  return <ChartPanel title="NOBL Forecast Monthly" subtitle="Matches the store-level monthly forecast model, but reads actuals from nobl_brand_tw_summary_daily."><DataTable columns={columns} rows={rows} /></ChartPanel>;
}

function NoblDaily({ rows, page, totalRows, onPageChange }) {
  const columns = [
    { label:'Date', key:'date', align:'left' },
    { label:'Row Type', align:'left', render:r => <Pill value={r.row_type} /> },
    { label:`Actual ${L.sales}`, render:r => money(r.actual_revenue) },
    { label:`Forecast ${L.sales}`, render:r => money(r.forecast_revenue) },
    { label:'Actual Spend', render:r => money(r.actual_spend) },
    { label:'Forecast Spend', render:r => money(r.forecast_spend) },
    { label:'Orders', render:r => num(r.actual_orders) },
    { label:L.mer, render:r => mer(r.actual_mer || r.forecast_mer) },
    { label:'Sale', align:'left', render:r => r.sale_name },
    { label:'Drop', align:'left', render:r => r.drop_type || '—' },
    { label:'Weight', render:r => fmtRatio(r.weight || 0) },
    { label:'Reason', align:'left', wrap:true, minWidth:320, render:r => r.reason },
  ];
  return <ChartPanel title="NOBL Forecast Daily" subtitle="Daily audit view: actual rows from the database and future rows allocated from the forecast model."><DataTable columns={columns} rows={rows} page={page} pageSize={TABLE_PAGE_SIZE} totalRows={totalRows} onPageChange={onPageChange} /></ChartPanel>;
}

function AirMonthly({ rows }) {
  const columns = [
    { label:'Month', align:'left', render:r => r.month_label || r.month },
    { label:'Status', align:'left', render:r => <Pill value={r.status_label || r.status || r.row_type} /> },
    { label:'Actual Store Rev', render:r => money(r.actual_store_revenue) },
    { label:'Actual Eligible Orders', render:r => num(r.actual_eligible_orders) },
    { label:'Actual Air Orders', render:r => num(r.actual_air_orders) },
    { label:'Actual Attach', render:r => pct(r.actual_attach_rate) },
    { label:'Actual TTP', render:r => pct(r.actual_ttp_rate) },
    { label:'Actual Air Rev', render:r => money(r.actual_air_rev_net) },
    { label:'Forecast Store Rev', render:r => money(r.store_revenue) },
    { label:'Forecast Eligible Orders', render:r => num(r.eligible_orders) },
    { label:'Forecast Air Orders', render:r => num(r.est_air_orders) },
    { label:'Forecast Air Rev', render:r => money(r.total_air_rev_net_est) },
    { label:'Source', align:'left', wrap:true, minWidth:300, render:r => r.order_source },
  ];
  return <ChartPanel title="NOBL Air Forecast Monthly" subtitle="Forecast columns use database actuals and Air assumptions from nobl_air_daily."><DataTable columns={columns} rows={rows} /></ChartPanel>;
}

function AirDaily({ rows, page, totalRows, onPageChange }) {
  const columns = [
    { label:'Date', key:'date', align:'left' },
    { label:'Row Type', align:'left', render:r => <Pill value={r.row_type} /> },
    { label:'Actual Store Rev', render:r => money(r.actual_store_revenue) },
    { label:'Actual Eligible Orders', render:r => num(r.actual_eligible_orders) },
    { label:'Actual Air Orders', render:r => num(r.actual_air_orders) },
    { label:'Actual Attach', render:r => pct(r.actual_attach_rate) },
    { label:'Actual TTP', render:r => pct(r.actual_ttp_rate) },
    { label:'Actual Air Rev', render:r => money(r.actual_air_rev_net) },
    { label:'Forecast Store Rev', render:r => money(r.forecast_store_revenue) },
    { label:'Forecast Eligible Orders', render:r => num(r.forecast_eligible_orders) },
    { label:'Forecast Air Orders', render:r => num(r.forecast_air_orders) },
    { label:'Forecast Activations', render:r => num(r.forecast_activations) },
    { label:'Forecast Air Rev', render:r => money(r.forecast_total_air_rev_net) },
    { label:'Target Status', align:'left', render:r => <Pill value={r.target_status} /> },
    { label:'Note', align:'left', wrap:true, minWidth:320, render:r => r.forecast_note },
  ];
  return <ChartPanel title="NOBL Air Forecast Daily" subtitle="This is the dashboard equivalent of the NOBL Air daily sheet tab, with completed days pulled from nobl_air_daily."><DataTable columns={columns} rows={rows} page={page} pageSize={TABLE_PAGE_SIZE} totalRows={totalRows} onPageChange={onPageChange} /></ChartPanel>;
}

function Methodology({ data }) {
  const items = [
    ['Data source', data?.data_source],
    ['NOBL actual table', 'nobl_brand_tw_summary_daily'],
    ['NOBL Air actual table', 'nobl_air_daily'],
    ['Future NOBL method', 'Monthly P50 revenue is allocated to future days using day-of-week, seasonality, sale, and drop weights.'],
    ['Future Air method', 'Forecast Store Revenue ÷ eligible AOV × attach/activation assumptions from the database.'],
    ['Missing actuals', 'Completed dates missing from the database are labeled Missing Actual so ETL gaps are visible.'],
  ];
  return (
    <ChartPanel title="Forecast methodology" subtitle="What changed from the sheet workflow and how the dashboard protects future values.">
      <div style={{ display:'grid', gap:10 }}>
        {items.map(([k, v]) => <div key={k} style={{ display:'grid', gridTemplateColumns:'220px 1fr', gap:12, padding:12, border:'1px solid var(--border)', borderRadius:14, background:'var(--bg3)', fontSize:13, lineHeight:1.55 }}><strong>{k}</strong><span style={{ color:'var(--text2)' }}>{v}</span></div>)}
        {(data?.methodology?.checks || []).map(x => <div key={x} style={{ padding:12, border:'1px solid var(--success-dim)', borderRadius:14, background:'var(--success-dim)', color:'var(--success)', fontWeight:800 }}>✓ {x}</div>)}
      </div>
    </ChartPanel>
  );
}

const controlStyle = { padding:'10px 12px', border:'1px solid var(--border2)', borderRadius:12, background:'var(--bg2)', color:'var(--text)', fontFamily:'var(--font-body)', width:'100%' };
const filterLabel = { fontSize:10.5, color:'var(--text3)', fontWeight:900, textTransform:'uppercase', letterSpacing:'.6px', margin:'0 0 5px 2px' };
