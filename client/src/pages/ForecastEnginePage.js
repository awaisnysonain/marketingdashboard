import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { getDashboardForecast, fmt$, fmtNum, fmtPct } from '../utils/api';
import TablePagination from '../components/TablePagination';
import { useClientPagination } from '../hooks/useClientPagination';
import { TABLE_PAGE_SIZE } from '../constants/pagination';
import { L, PAGE } from '../copy/plainLanguage';

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
const mer = (n) => (n === null || n === undefined ? '—' : `${Number(n || 0).toFixed(2)}x`);
const tooltipStyle = { background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:10, fontSize:12, boxShadow:'0 8px 22px rgba(15,23,42,.10)' };

function Card({ title, subtitle, children, style }) {
  return (
    <section style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:18, padding:18, boxShadow:'0 10px 30px rgba(15,23,42,.045)', ...style }}>
      {title && <div style={{ fontSize:15, fontWeight:900, color:'var(--text)', marginBottom:subtitle ? 5 : 14 }}>{title}</div>}
      {subtitle && <div style={{ fontSize:12, color:'var(--text3)', marginBottom:14, lineHeight:1.55 }}>{subtitle}</div>}
      {children}
    </section>
  );
}

function StatCard({ label, value, sub, tone = 'indigo' }) {
  const tones = {
    indigo: ['#6366f1', 'rgba(99,102,241,.12)'],
    teal: ['#14b8a6', 'rgba(20,184,166,.12)'],
    green: ['#22c55e', 'rgba(34,197,94,.12)'],
    amber: ['#f59e0b', 'rgba(245,158,11,.13)'],
    rose: ['#ef4444', 'rgba(239,68,68,.12)'],
  };
  const [c, bg] = tones[tone] || tones.indigo;
  return (
    <div style={{ position:'relative', overflow:'hidden', background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:16, padding:'16px 17px', minHeight:96, boxShadow:'0 8px 22px rgba(15,23,42,.04)' }}>
      <div style={{ position:'absolute', inset:'auto -18px -28px auto', width:92, height:92, borderRadius:'50%', background:bg }} />
      <div style={{ width:32, height:3, borderRadius:999, background:c, marginBottom:12 }} />
      <div style={{ fontSize:11, color:'var(--text3)', fontWeight:700, letterSpacing:'.2px', marginBottom:7 }}>{label}</div>
      <div style={{ fontSize:23, lineHeight:1.05, fontWeight:900, color:'var(--text)', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:'var(--text3)', marginTop:7 }}>{sub}</div>}
    </div>
  );
}

function Pill({ value }) {
  const text = String(value || '—');
  const lower = text.toLowerCase();
  const good = lower.includes('actual') || lower.includes('target met') || lower === 'green' || lower.includes('track');
  const warn = lower.includes('missing') || lower.includes('watch') || lower === 'amber' || lower.includes('pending');
  const bad = lower.includes('below') || lower === 'red' || lower.includes('off');
  const color = bad ? '#dc2626' : warn ? '#d97706' : good ? '#16a34a' : '#6366f1';
  const bg = bad ? 'rgba(239,68,68,.12)' : warn ? 'rgba(245,158,11,.13)' : good ? 'rgba(34,197,94,.12)' : 'rgba(99,102,241,.12)';
  return <span style={{ display:'inline-flex', alignItems:'center', padding:'5px 9px', borderRadius:999, background:bg, color, fontSize:11, fontWeight:800, whiteSpace:'nowrap' }}>{text}</span>;
}

function TabButton({ id, label, active, onClick }) {
  return (
    <button type="button" onClick={() => onClick(id)} style={{
      border:'1px solid var(--border2)', borderRadius:999, padding:'9px 14px', cursor:'pointer', fontSize:12, fontWeight:900,
      background:active ? 'linear-gradient(135deg, #6366f1, #14b8a6)' : 'var(--bg2)',
      color:active ? '#fff' : 'var(--text2)', fontFamily:'var(--font-body)',
    }}>{label}</button>
  );
}

function DataTable({ columns, rows, page, pageSize, totalRows, onPageChange, footer }) {
  return (
    <div style={{ overflowX:'auto', border:'1px solid var(--border)', borderRadius:14 }}>
      <table style={{ width:'100%', borderCollapse:'separate', borderSpacing:0, fontSize:12 }}>
        <thead><tr style={{ color:'var(--text3)', background:'var(--bg3)' }}>
          {columns.map(c => <th key={c.key || c.label} style={{ textAlign:c.align || 'right', padding:'10px 12px', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{c.label}</th>)}
        </tr></thead>
        <tbody>{rows.map((r, i) => <tr key={r.date || r.month_key || `${r.month}-${i}`} style={{ color:'var(--text2)' }}>
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
  const currentNobl = noblMonthly.find(r => r.row_type === 'current_projection') || noblMonthly.find(r => r.month_key === String(data?.as_of || '').slice(0, 7));
  const currentAir = airMonthly.find(r => r.row_type === 'current_projection') || airMonthly.find(r => r.month_key === String(data?.air_as_of || '').slice(0, 7));

  const { page: noblDailyPage, setPage: setNoblDailyPage, pageItems: noblDailyItems, totalRows: noblDailyTotal } = useClientPagination(noblDaily, TABLE_PAGE_SIZE, [noblDaily.length]);
  const { page: airDailyPage, setPage: setAirDailyPage, pageItems: airDailyItems, totalRows: airDailyTotal } = useClientPagination(airDaily, TABLE_PAGE_SIZE, [airDaily.length]);

  const chartRows = noblMonthly.map(r => ({
    month: String(r.month || '').replace(' 2026', ''),
    nobl: r.projected_revenue || 0,
    plan: r.plan_revenue || 0,
    air: airMonthly.find(a => a.month_key === r.month_key)?.forecast_total_air_rev_net || 0,
  }));

  if (loading) return <div style={{ padding:20, color:'var(--text3)' }}>Loading database forecast…</div>;
  if (error) return <div style={{ padding:20, color:'var(--danger)' }}>Forecast error: {error}</div>;

  return (
    <div style={{ paddingBottom:24 }}>
      <header style={{ display:'grid', gridTemplateColumns:'minmax(0, 1.6fr) minmax(280px, .8fr)', gap:18, marginBottom:18 }}>
        <div style={{ position:'relative', overflow:'hidden', borderRadius:24, padding:24, background:'radial-gradient(circle at top left, rgba(99,102,241,.24), transparent 34%), radial-gradient(circle at bottom right, rgba(20,184,166,.18), transparent 30%), var(--bg2)', border:'1px solid rgba(99,102,241,.22)', boxShadow:'0 18px 44px rgba(15,23,42,.08)' }}>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:14 }}>
            {['Database-backed', 'NOBL + NOBL Air', 'Daily + Monthly tabs', 'No sheet dependency'].map(x => <span key={x} style={{ padding:'5px 10px', borderRadius:999, background:'rgba(255,255,255,.65)', border:'1px solid var(--border)', fontSize:11, fontWeight:800, color:'var(--text2)' }}>{x}</span>)}
          </div>
          <h1 style={{ margin:0, fontSize:30, letterSpacing:'-.03em', lineHeight:1.05, fontWeight:950, color:'var(--text)', fontFamily:'var(--font-head)' }}>{PAGE.forecastEngine.title}</h1>
          <p style={{ margin:'10px 0 0', maxWidth:820, color:'var(--text2)', fontSize:14, lineHeight:1.65 }}>{PAGE.forecastEngine.desc} This page replaces the old sheet-only forecast view with four proper tabs: NOBL Monthly, NOBL Daily, NOBL Air Monthly, and NOBL Air Daily.</p>
        </div>
        <Card title="Controls" subtitle={`NOBL actuals through ${data?.as_of || 'latest'} · Air actuals through ${data?.air_as_of || 'latest'}.`} style={{ borderRadius:24 }}>
          <div style={{ display:'grid', gap:10 }}>
            <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} style={controlStyle} />
            <button type="button" onClick={() => setAsOf('')} style={{ ...controlStyle, cursor:'pointer', fontWeight:900, color:'#6366f1' }}>Use latest database actuals</button>
            <div style={{ fontSize:11, color:'var(--text3)', lineHeight:1.55 }}>{data?.data_source}</div>
          </div>
        </Card>
      </header>

      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:18 }}>
        {TAB_META.map(([id, label]) => <TabButton key={id} id={id} label={label} active={activeTab === id} onClick={setActiveTab} />)}
      </div>

      {activeTab === 'overview' && (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6, minmax(140px, 1fr))', gap:12, marginBottom:18 }}>
            <StatCard label="NOBL FY Forecast" value={money(data?.nobl?.full_year?.projected_revenue)} sub="Store sales P50" tone="indigo" />
            <StatCard label="NOBL FY Plan" value={money(data?.nobl?.full_year?.plan_revenue)} sub={pct(data?.nobl?.full_year?.variance_pct)} tone="amber" />
            <StatCard label={`NOBL FY ${L.mer}`} value={mer(data?.nobl?.full_year?.projected_mer)} sub="Sales / ad spend" tone="teal" />
            <StatCard label="Air FY Forecast" value={money(data?.air?.full_year?.total_air_rev_net_est)} sub="Tag + sub + rebill estimate" tone="green" />
            <StatCard label="Air attach used" value={pct(data?.air?.assumptions?.overall_attach_rate)} sub="From nobl_air_daily" tone="teal" />
            <StatCard label="Air activation used" value={pct(data?.air?.assumptions?.forecast_activation_rate)} sub="Trailing cohort basis" tone="indigo" />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
            <Card title="Monthly forecast overview" subtitle="NOBL store revenue vs plan, with NOBL Air forecast layered on the same month axis.">
              <ResponsiveContainer width="100%" height={330}>
                <ComposedChart data={chartRows} margin={{ top:8, right:18, left:0, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={fmt$} tick={{ fontSize:11 }} width={74} stroke="var(--border2)" />
                  <Tooltip formatter={(v, n) => [money(v), n]} contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  <Bar dataKey="nobl" name="NOBL P50" fill="#6366f1" radius={[3,3,0,0]} />
                  <Line dataKey="plan" name="NOBL Plan" stroke="#f59e0b" strokeWidth={2.5} dot={false} />
                  <Line dataKey="air" name="NOBL Air" stroke="#14b8a6" strokeWidth={2.5} dot={{ r:3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
            <Card title="Current month focus" subtitle="Actual-to-date plus projection from database values, not Google Sheet formulas.">
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <StatCard label="NOBL current P50" value={money(currentNobl?.projected_revenue)} sub={currentNobl?.month} tone="indigo" />
                <StatCard label="NOBL current status" value={<Pill value={currentNobl?.status} />} sub={pct(currentNobl?.variance_pct)} tone={currentNobl?.status === 'red' ? 'rose' : currentNobl?.status === 'amber' ? 'amber' : 'green'} />
                <StatCard label="Air current forecast" value={money(currentAir?.total_air_rev_net_est)} sub={currentAir?.month || currentAir?.month_label} tone="green" />
                <StatCard label="Air current actual" value={money(currentAir?.actual_air_rev_net)} sub="Actual Air revenue" tone="teal" />
              </div>
              <div style={{ marginTop:14, padding:12, borderRadius:14, background:'var(--bg3)', color:'var(--text2)', fontSize:13, lineHeight:1.65 }}>{data?.nobl?.narrative}</div>
            </Card>
          </div>
        </>
      )}

      {activeTab === 'nobl-monthly' && <NoblMonthly rows={noblMonthly} />}
      {activeTab === 'nobl-daily' && <NoblDaily rows={noblDailyItems} page={noblDailyPage} totalRows={noblDailyTotal} onPageChange={setNoblDailyPage} />}
      {activeTab === 'air-monthly' && <AirMonthly rows={airMonthlyWithTotal} />}
      {activeTab === 'air-daily' && <AirDaily rows={airDailyItems} page={airDailyPage} totalRows={airDailyTotal} onPageChange={setAirDailyPage} />}
      {activeTab === 'methodology' && <Methodology data={data} />}
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
  return <Card title="NOBL Forecast Monthly" subtitle="Matches the store-level monthly forecast model, but reads actuals from nobl_brand_tw_summary_daily."><DataTable columns={columns} rows={rows} /></Card>;
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
    { label:'Weight', render:r => `${Number(r.weight || 0).toFixed(2)}x` },
    { label:'Reason', align:'left', wrap:true, minWidth:320, render:r => r.reason },
  ];
  return <Card title="NOBL Forecast Daily" subtitle="Daily audit view: actual rows from the database and future rows allocated from the forecast model."><DataTable columns={columns} rows={rows} page={page} pageSize={TABLE_PAGE_SIZE} totalRows={totalRows} onPageChange={onPageChange} /></Card>;
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
  return <Card title="NOBL Air Forecast Monthly" subtitle="Forecast columns use database actuals and Air assumptions from nobl_air_daily."><DataTable columns={columns} rows={rows} /></Card>;
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
  return <Card title="NOBL Air Forecast Daily" subtitle="This is the dashboard equivalent of the NOBL Air daily sheet tab, with completed days pulled from nobl_air_daily."><DataTable columns={columns} rows={rows} page={page} pageSize={TABLE_PAGE_SIZE} totalRows={totalRows} onPageChange={onPageChange} /></Card>;
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
    <Card title="Forecast methodology" subtitle="What changed from the sheet workflow and how the dashboard protects future values.">
      <div style={{ display:'grid', gap:10 }}>
        {items.map(([k, v]) => <div key={k} style={{ display:'grid', gridTemplateColumns:'220px 1fr', gap:12, padding:12, border:'1px solid var(--border)', borderRadius:14, background:'var(--bg3)', fontSize:13, lineHeight:1.55 }}><strong>{k}</strong><span style={{ color:'var(--text2)' }}>{v}</span></div>)}
        {(data?.methodology?.checks || []).map(x => <div key={x} style={{ padding:12, border:'1px solid rgba(34,197,94,.22)', borderRadius:14, background:'rgba(34,197,94,.08)', color:'#16a34a', fontWeight:800 }}>✓ {x}</div>)}
      </div>
    </Card>
  );
}

const controlStyle = { padding:'10px 12px', border:'1px solid var(--border2)', borderRadius:12, background:'var(--bg2)', color:'var(--text)', fontFamily:'var(--font-body)', width:'100%' };
