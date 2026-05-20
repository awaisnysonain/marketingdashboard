import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ComposedChart,
} from 'recharts';
import { getForecastEngine, fmt$, fmtNum, fmtPct } from '../utils/api';
import { L, PAGE } from '../copy/plainLanguage';

const STATUS = {
  green: { label: 'On Track', bg: 'rgba(34,197,94,.12)', color: '#16a34a', border: 'rgba(34,197,94,.26)' },
  amber: { label: 'Watch', bg: 'rgba(245,158,11,.13)', color: '#d97706', border: 'rgba(245,158,11,.28)' },
  red: { label: 'Off Track', bg: 'rgba(239,68,68,.12)', color: '#dc2626', border: 'rgba(239,68,68,.26)' },
  model: { label: 'Model', bg: 'rgba(99,102,241,.12)', color: '#6366f1', border: 'rgba(99,102,241,.25)' },
};

const BRAND_ACCENT = {
  NOBL: { from: '#6366f1', to: '#14b8a6', soft: 'rgba(99,102,241,.10)' },
  FLO: { from: '#ec4899', to: '#f59e0b', soft: 'rgba(236,72,153,.10)' },
};

const money = (n) => (n === null || n === undefined ? '—' : fmt$(n));
const num = (n) => (n === null || n === undefined ? '—' : fmtNum(n));
const pct = (n) => (n === null || n === undefined ? '—' : fmtPct(n));
const mer = (n) => (n === null || n === undefined ? '—' : `${Number(n).toFixed(2)}x`);

function statusMeta(s) { return STATUS[s] || STATUS.model; }
function statusPill(s) {
  const x = statusMeta(s);
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'5px 9px', borderRadius:999, background:x.bg, color:x.color, border:`1px solid ${x.border}`, fontSize:11, fontWeight:800, whiteSpace:'nowrap' }}>
      <span style={{ width:6, height:6, borderRadius:999, background:x.color }} />{x.label}
    </span>
  );
}

function Card({ title, subtitle, children, style, action }) {
  return (
    <section style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:18, padding:18, boxShadow:'0 10px 30px rgba(15,23,42,.045)', ...style }}>
      {(title || action) && (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12, marginBottom:subtitle ? 5 : 14 }}>
          {title && <div style={{ fontSize:15, fontWeight:900, color:'var(--text)' }}>{title}</div>}
          {action}
        </div>
      )}
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
    rose: ['#ec4899', 'rgba(236,72,153,.12)'],
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

function Metric({ label, value, hint }) {
  return (
    <div style={{ padding:'11px 12px', border:'1px solid var(--border)', borderRadius:14, background:'var(--bg3)' }}>
      <div style={{ fontSize:11, color:'var(--text3)', marginBottom:5 }}>{label}</div>
      <div style={{ fontSize:18, fontWeight:900, color:'var(--text)' }}>{value}</div>
      {hint && <div style={{ marginTop:4, fontSize:10.5, color:'var(--text4)' }}>{hint}</div>}
    </div>
  );
}

function BrandSummaryCard({ brand, selected, onClick }) {
  const accent = BRAND_ACCENT[brand.brand] || BRAND_ACCENT.NOBL;
  return (
    <button type="button" onClick={onClick} style={{ textAlign:'left', cursor:'pointer', background:selected ? `linear-gradient(135deg, ${accent.soft}, var(--bg2))` : 'var(--bg2)', border:`1px solid ${selected ? accent.from : 'var(--border)'}`, borderRadius:18, padding:17, boxShadow:selected ? `0 12px 26px ${accent.soft}` : '0 8px 22px rgba(15,23,42,.035)', color:'var(--text)', fontFamily:'var(--font-body)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', gap:10, alignItems:'center', marginBottom:12 }}>
        <div>
          <div style={{ fontWeight:900, fontSize:15 }}>{brand.label}</div>
          <div style={{ fontSize:11, color:'var(--text3)', marginTop:3 }}>As of {brand.as_of}</div>
        </div>
        {statusPill(brand.full_year?.status)}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
        <Metric label="Current P50" value={money(brand.current_month?.projected_revenue)} />
        <Metric label="FY Projection" value={money(brand.full_year?.projected_revenue)} />
        <Metric label={`FY ${L.mer}`} value={mer(brand.full_year?.projected_mer)} />
        <Metric label="Plan Variance" value={brand.full_year?.variance_pct == null ? '—' : pct(brand.full_year.variance_pct)} />
      </div>
    </button>
  );
}

export default function ForecastEnginePage() {
  const [brand, setBrand] = useState('ALL');
  const [detailBrand, setDetailBrand] = useState('NOBL');
  const [asOf, setAsOf] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getForecastEngine(brand, asOf)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brand, asOf]);

  const brands = data?.brands || [];
  const selected = brands.find(b => b.brand === detailBrand) || brands[0] || null;
  const combined = data?.combined || {};

  useEffect(() => {
    if (!brands.length) return;
    if (brand !== 'ALL') setDetailBrand(brand);
    else if (!brands.some(b => b.brand === detailBrand)) setDetailBrand(brands[0].brand);
  }, [brands, brand, detailBrand]);

  const chartRows = useMemo(() => {
    if (!selected) return [];
    return selected.monthly.map(r => ({
      ...r,
      plan_revenue: r.plan_revenue || null,
      actual_revenue: r.actual_revenue || null,
      projected_revenue: r.projected_revenue || null,
      projected_mer: r.projected_mer || null,
      mer_target: r.mer_target || null,
    }));
  }, [selected]);

  const redlines = brands.flatMap(b => (b.redlines || []).map(r => ({ ...r, brand:b.label })));

  if (loading) return <div style={{ padding:20, color:'var(--text3)' }}>Loading forecast engine…</div>;
  if (error) return <div style={{ padding:20, color:'var(--danger)' }}>Forecast error: {error}</div>;

  return (
    <div style={{ paddingBottom:24 }}>
      <header style={{
        display:'grid', gridTemplateColumns:'minmax(0, 1.6fr) minmax(280px, .8fr)', gap:18, marginBottom:18,
      }}>
        <div style={{
          position:'relative', overflow:'hidden', borderRadius:24, padding:24,
          background:'radial-gradient(circle at top left, rgba(99,102,241,.24), transparent 34%), radial-gradient(circle at bottom right, rgba(20,184,166,.18), transparent 30%), var(--bg2)',
          border:'1px solid rgba(99,102,241,.22)', boxShadow:'0 18px 44px rgba(15,23,42,.08)',
        }}>
          <div style={{ position:'absolute', right:-50, top:-60, width:180, height:180, borderRadius:'50%', background:'rgba(99,102,241,.10)' }} />
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:14 }}>
            {['P50 Forecast', 'P25–P75 Range', 'Calendar-aware', `${L.mer} + ${L.sales}`].map(x => (
              <span key={x} style={{ padding:'5px 10px', borderRadius:999, background:'rgba(255,255,255,.65)', border:'1px solid var(--border)', fontSize:11, fontWeight:800, color:'var(--text2)' }}>{x}</span>
            ))}
          </div>
          <h1 style={{ margin:0, fontSize:30, letterSpacing:'-.03em', lineHeight:1.05, fontWeight:950, color:'var(--text)', fontFamily:'var(--font-head)' }}>{PAGE.forecastEngine.title}</h1>
          <p style={{ margin:'10px 0 0', maxWidth:760, color:'var(--text2)', fontSize:14, lineHeight:1.65 }}>{PAGE.forecastEngine.desc}</p>
        </div>
        <Card title="Controls" subtitle="Choose stores and forecast as-of date." style={{ borderRadius:24 }}>
          <div style={{ display:'grid', gap:10 }}>
            <select value={brand} onChange={e => setBrand(e.target.value)} style={controlStyle}>
              <option value="ALL">All Stores</option>
              <option value="NOBL">NOBL Travel</option>
              <option value="FLO">Pilates FLO</option>
            </select>
            <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} style={controlStyle} />
            <button type="button" onClick={() => setAsOf('')} style={{ ...controlStyle, cursor:'pointer', fontWeight:900, color:'#6366f1' }}>Use latest actual date</button>
          </div>
        </Card>
      </header>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(5, minmax(150px, 1fr))', gap:12, marginBottom:18 }}>
        <StatCard label={`Combined actual ${L.sales.toLowerCase()}`} value={money(combined.actual_revenue)} sub={`Through ${data?.as_of || 'latest'}`} tone="green" />
        <StatCard label="Combined FY Projection" value={money(combined.projected_revenue)} sub="Actuals + forecast" tone="indigo" />
        <StatCard label="Plan / Target" value={combined.plan_revenue ? money(combined.plan_revenue) : '—'} sub="Configured plan" tone="amber" />
        <StatCard label={`Projected ${L.mer}`} value={mer(combined.projected_mer)} sub="Sales / ad spend" tone="teal" />
        <StatCard label="Variance vs Plan" value={combined.variance_pct == null ? '—' : pct(combined.variance_pct)} sub={statusMeta(combined.status).label} tone={combined.status === 'red' ? 'rose' : combined.status === 'amber' ? 'amber' : 'green'} />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1.35fr .65fr', gap:16, marginBottom:18 }}>
        <Card title="Executive narrative" subtitle="Plain-English summary for the selected forecast run.">
          <div style={{ display:'grid', gap:10 }}>
            {brands.map(b => (
              <div key={b.brand} style={{ padding:'12px 14px', borderRadius:14, border:'1px solid var(--border)', background:'var(--bg3)', lineHeight:1.6, fontSize:13, color:'var(--text2)' }}>
                <strong style={{ color:'var(--text)' }}>{b.label}</strong> — {b.narrative}
              </div>
            ))}
          </div>
        </Card>
        <Card title="Redline monitor" subtitle="Non-negotiable guardrails from the brief.">
          {redlines.length === 0 ? (
            <div style={{ padding:14, borderRadius:14, background:'rgba(34,197,94,.10)', border:'1px solid rgba(34,197,94,.22)', color:'#16a34a', fontWeight:900 }}>No redline breaches detected.</div>
          ) : redlines.map((r, i) => (
            <div key={i} style={{ padding:12, borderRadius:12, background:'rgba(239,68,68,.10)', border:'1px solid rgba(239,68,68,.22)', color:'#dc2626', fontSize:12, lineHeight:1.55, marginBottom:8 }}><strong>{r.brand} · {r.code}</strong>: {r.message}</div>
          ))}
          <div style={{ marginTop:12, fontSize:11.5, color:'var(--text3)', lineHeight:1.55 }}>No flat rolling average. Drop windows stay discrete. BFCM is model anchored. NOBL full-year below $404M requires human review.</div>
        </Card>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(300px, 1fr))', gap:14, marginBottom:16 }}>
        {brands.map(b => <BrandSummaryCard key={b.brand} brand={b} selected={selected?.brand === b.brand} onClick={() => setDetailBrand(b.brand)} />)}
      </div>

      {selected && (
        <>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, margin:'10px 0 14px', flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:18, fontWeight:950, color:'var(--text)' }}>{selected.label} detail</div>
              <div style={{ fontSize:12, color:'var(--text3)', marginTop:2 }}>Actuals through {selected.as_of}; current month uses weighted remaining-days projection.</div>
            </div>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              {brands.map(b => (
                <button key={b.brand} type="button" onClick={() => setDetailBrand(b.brand)} style={{
                  border:'1px solid var(--border2)', borderRadius:999, padding:'8px 13px', cursor:'pointer', fontSize:12, fontWeight:900,
                  background:selected.brand === b.brand ? `linear-gradient(135deg, ${(BRAND_ACCENT[b.brand] || BRAND_ACCENT.NOBL).from}, ${(BRAND_ACCENT[b.brand] || BRAND_ACCENT.NOBL).to})` : 'var(--bg2)',
                  color:selected.brand === b.brand ? '#fff' : 'var(--text2)',
                }}>{b.label}</button>
              ))}
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(6, minmax(140px, 1fr))', gap:12, marginBottom:16 }}>
            <StatCard label="Actual YTD" value={money(selected.full_year?.actual_revenue)} tone="green" />
            <StatCard label="Current P50" value={money(selected.current_month?.projected_revenue)} tone="indigo" />
            <StatCard label="Current Range" value={`${money(selected.current_month?.p25)}–${money(selected.current_month?.p75)}`} tone="teal" />
            <StatCard label="FY Projection" value={money(selected.full_year?.projected_revenue)} tone="indigo" />
            <StatCard label={`FY ${L.mer}`} value={mer(selected.full_year?.projected_mer)} tone="amber" />
            <StatCard label="FY Status" value={statusMeta(selected.full_year?.status).label} tone={selected.full_year?.status === 'red' ? 'rose' : selected.full_year?.status === 'amber' ? 'amber' : 'green'} />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(390px, 1fr))', gap:16, marginBottom:16 }}>
            <Card title="Monthly sales forecast" subtitle="Actuals, plan, and P50 projection by month.">
              <ResponsiveContainer width="100%" height={315}>
                <ComposedChart data={chartRows} margin={{ top:8, right:18, left:0, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={fmt$} tick={{ fontSize:11 }} width={74} stroke="var(--border2)" />
                  <Tooltip formatter={(v, n) => [money(v), n]} contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  <Bar dataKey="actual_revenue" name="Actual" fill="#22c55e" radius={[3,3,0,0]} />
                  <Bar dataKey="projected_revenue" name="Projection" fill="#6366f1" radius={[3,3,0,0]} />
                  <Line dataKey="plan_revenue" name="Plan" stroke="#f59e0b" strokeWidth={2.5} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
            <Card title={`${L.mer} forecast`} subtitle="Sales per ad dollar tracked alongside top-line sales.">
              <ResponsiveContainer width="100%" height={315}>
                <LineChart data={chartRows} margin={{ top:8, right:18, left:0, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={(v) => `${Number(v || 0).toFixed(1)}x`} tick={{ fontSize:11 }} width={54} stroke="var(--border2)" />
                  <Tooltip formatter={(v, n) => [`${Number(v || 0).toFixed(2)}x`, n]} contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  <Line dataKey="projected_mer" name={`Projected ${L.mer}`} stroke="#14b8a6" strokeWidth={2.5} dot={{ r:3 }} />
                  <Line dataKey="mer_target" name={`${L.mer} target`} stroke="#f59e0b" strokeWidth={2.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <Card title="Monthly forecast detail" subtitle="Every projection has a reason and a confidence range. Green/amber/red status uses plan variance thresholds." style={{ marginBottom:16 }}>
            <div style={{ overflowX:'auto', border:'1px solid var(--border)', borderRadius:14 }}>
              <table style={{ width:'100%', borderCollapse:'separate', borderSpacing:0, fontSize:12 }}>
                <thead><tr style={{ color:'var(--text3)', background:'var(--bg3)' }}>
                  {['Month','Status',L.planTarget,`Actual ${L.sales}`,`Projected ${L.sales}`,L.variance,`Actual ${L.mer}`,`Projected ${L.mer}`,`${L.mer} target`,'P25','P75','Reason'].map(h => <th key={h} style={{ textAlign:h === 'Month' || h === 'Reason' ? 'left' : 'right', padding:'10px 12px', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{h}</th>)}
                </tr></thead>
                <tbody>{selected.monthly.map(r => <tr key={r.month_key} style={{ color:'var(--text2)' }}>
                  <td style={tdLeft}>{r.month}</td>
                  <td style={tdRight}>{statusPill(r.status)}</td>
                  <td style={tdRight}>{money(r.plan_revenue)}</td>
                  <td style={{ ...tdRight, color:'#16a34a', fontWeight:800 }}>{money(r.actual_revenue)}</td>
                  <td style={{ ...tdRight, fontWeight:900, color:'var(--text)' }}>{money(r.projected_revenue)}</td>
                  <td style={tdRight}>{r.variance_pct == null ? '—' : pct(r.variance_pct)}</td>
                  <td style={tdRight}>{mer(r.actual_mer)}</td>
                  <td style={tdRight}>{mer(r.projected_mer)}</td>
                  <td style={tdRight}>{mer(r.mer_target)}</td>
                  <td style={tdRight}>{money(r.p25)}</td>
                  <td style={tdRight}>{money(r.p75)}</td>
                  <td style={{ padding:'10px 12px', minWidth:310, maxWidth:520, color:'var(--text3)', borderBottom:'1px solid var(--border)', lineHeight:1.45 }}>{r.reason}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </Card>

          <div style={{ display:'grid', gridTemplateColumns:'minmax(0, 1.7fr) minmax(280px, .8fr)', gap:16 }}>
            <Card title="Current month daily projection" subtitle="Auditable formula: base × day-of-week × seasonality × sale × drop.">
              <div style={{ overflowX:'auto', maxHeight:440, border:'1px solid var(--border)', borderRadius:14 }}>
                <table style={{ width:'100%', borderCollapse:'separate', borderSpacing:0, fontSize:12 }}>
                  <thead><tr style={{ color:'var(--text3)', background:'var(--bg3)' }}>
                    {['Date','Type',L.sales,'DOW','Season','Sale','Drop','Weight'].map(h => <th key={h} style={{ textAlign:h === 'Date' || h === 'Type' || h === 'Sale' || h === 'Drop' ? 'left' : 'right', padding:'10px 12px', borderBottom:'1px solid var(--border)', position:'sticky', top:0, background:'var(--bg3)', zIndex:1 }}>{h}</th>)}
                  </tr></thead>
                  <tbody>{selected.daily_projection.map(r => <tr key={r.date} style={{ color:r.is_actual ? '#16a34a' : 'var(--text2)' }}>
                    <td style={tdLeft}>{r.date}</td>
                    <td style={tdLeft}>{r.is_actual ? 'Actual' : 'Projected'}</td>
                    <td style={tdRight}>{money(r.projected_revenue)}</td>
                    <td style={tdRight}>{Number(r.day_weight).toFixed(2)}x</td>
                    <td style={tdRight}>{Number(r.seasonality).toFixed(2)}x</td>
                    <td style={tdLeft}>{r.sale_name} <span style={{ color:'var(--text4)' }}>({Number(r.sale_lift).toFixed(2)}x)</span></td>
                    <td style={tdLeft}>{r.drop_type ? `${r.drop_type} (${Number(r.drop_lift).toFixed(2)}x)` : '—'}</td>
                    <td style={tdRight}>{Number(r.weight).toFixed(2)}x</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </Card>
            <Card title="Regional pacing" subtitle={`Year-to-date actual ${L.sales.toLowerCase()} by region. ${L.mer} shows when regional ad spend is available.`}>
              <div style={{ display:'grid', gap:8 }}>
                {(selected.regions || []).slice(0, 8).map(r => (
                  <div key={r.region} style={{ padding:12, border:'1px solid var(--border)', borderRadius:14, background:'var(--bg3)' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:10 }}>
                      <div style={{ fontWeight:900 }}>{r.region}</div>
                      <div style={{ fontWeight:950 }}>{money(r.actual_revenue)}</div>
                    </div>
                    <div style={{ marginTop:5, fontSize:11, color:'var(--text3)' }}>{L.mer} {mer(r.actual_mer)} · ratio {r.mer_ratio_vs_usa || '—'}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

const controlStyle = { padding:'10px 12px', border:'1px solid var(--border2)', borderRadius:12, background:'var(--bg2)', color:'var(--text)', fontFamily:'var(--font-body)', width:'100%' };
const tooltipStyle = { background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:10, fontSize:12, boxShadow:'0 8px 22px rgba(15,23,42,.10)' };
const tdLeft = { padding:'10px 12px', whiteSpace:'nowrap', borderBottom:'1px solid var(--border)' };
const tdRight = { padding:'10px 12px', textAlign:'right', whiteSpace:'nowrap', borderBottom:'1px solid var(--border)', fontVariantNumeric:'tabular-nums' };
