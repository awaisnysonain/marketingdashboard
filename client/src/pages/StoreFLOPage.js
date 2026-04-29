import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getStoreFlo, fmt$, fmtNum, fmtPct } from '../utils/api';
import KpiCard from '../components/KpiCard';
import DateRangePicker from '../components/DateRangePicker';
import SheetTable from '../components/SheetTable';

/* ── helpers ──────────────────────────────────────────────────────── */
function toISO(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return toISO(d); }
function fmtLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${M[parseInt(mo)-1]} ${parseInt(dy)}`;
}
function mer(rev, spend) { return spend > 0 ? (rev / spend) : 0; }

/* ── palettes ─────────────────────────────────────────────────────── */
const CHANNEL_COL = {
  META:'#1877f2', GOOGLE:'#ea4335', TIKTOK:'#69c9d0', SNAPCHAT:'#f7c948',
  PINTEREST:'#e60023', APPLOVIN:'#ff8c00', BING:'#00809d', X:'#657786',
};
const GEO_COL     = ['#14b8a6','#6366f1','#f59e0b','#ef4444','#8b5cf6','#06b6d4'];
const PROD_COL    = { portable:'#14b8a6', wooden:'#f59e0b', metal:'#6366f1' };
const FLO_ACCENT  = '#14b8a6';
const FLO_WARN    = '#f59e0b';

/* ── tabs ────────────────────────────────────────────────────────── */
const TABS = [
  { id:'overview',  label:'Overview'  },
  { id:'channels',  label:'Channels'  },
  { id:'regions',   label:'Regions'   },
  { id:'products',  label:'Products'  },
  { id:'email',     label:'Email'     },
];

function merColor(v) {
  if (!v) return 'var(--text3)';
  if (v >= 2.0) return 'var(--success, #22c55e)';
  if (v >= 1.8) return 'var(--warn, #f59e0b)';
  return 'var(--danger, #ef4444)';
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN PAGE
════════════════════════════════════════════════════════════════════ */
export default function StoreFLOPage({ showToast }) {
  const [range, setRange]     = useState({ start: daysAgo(30), end: toISO(new Date()) });
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState('overview');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getStoreFlo(range.start, range.end)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const summary  = data?.summary  || [];
  const channels = data?.channels || [];
  const geo      = data?.geo      || [];
  const products = data?.products || [];
  const email    = data?.email    || [];

  const totals = useMemo(() => summary.reduce((a, r) => ({
    revenue: a.revenue + (r.total_revenue || 0),
    spend:   a.spend   + (r.total_spend   || 0),
    orders:  a.orders  + (r.total_orders  || 0),
    nc:      a.nc      + (r.new_customer_orders      || 0),
    rc:      a.rc      + (r.returning_customer_orders || 0),
  }), { revenue:0, spend:0, orders:0, nc:0, rc:0 }), [summary]);

  const totalMer = mer(totals.revenue, totals.spend);
  const totalAov = totals.orders > 0 ? totals.revenue / totals.orders : 0;
  const nvpPct   = totals.orders > 0 ? (totals.nc / totals.orders) * 100 : 0;

  const chAgg = useMemo(() => {
    const m = {};
    for (const r of channels) {
      if (!m[r.channel]) m[r.channel] = { spend:0, revenue:0, orders:0 };
      m[r.channel].spend   += r.spend_1d   || 0;
      m[r.channel].revenue += r.revenue_1d || 0;
      m[r.channel].orders  += r.new_cust_orders || 0;
    }
    return Object.entries(m)
      .map(([ch, v]) => ({ channel:ch, ...v, roas: mer(v.revenue, v.spend) }))
      .sort((a,b) => b.revenue - a.revenue);
  }, [channels]);

  const geoAgg = useMemo(() => {
    const m = {};
    for (const r of geo) {
      if (!m[r.region]) m[r.region] = { revenue:0, spend:0 };
      m[r.region].revenue += r.revenue || 0;
      m[r.region].spend   += r.spend   || 0;
    }
    return Object.entries(m)
      .map(([region, v]) => ({ region, ...v, mer: mer(v.revenue, v.spend) }))
      .sort((a,b) => b.revenue - a.revenue);
  }, [geo]);

  const prodAgg = useMemo(() => {
    const m = {};
    for (const r of products) {
      const pl = r.product_line || 'unknown';
      if (!m[pl]) m[pl] = { spend:0, revenue:0, orders:0,
        meta:0, google:0, tiktok:0, snap:0, pinterest:0, bing:0, applovin:0 };
      m[pl].spend   += r.spend   || 0;
      m[pl].revenue += r.revenue || 0;
      m[pl].orders  += r.new_cust_orders || 0;
      m[pl].meta     += r.meta_spend     || 0;
      m[pl].google   += r.google_spend   || 0;
      m[pl].tiktok   += r.tiktok_spend   || 0;
      m[pl].snap     += r.snap_spend     || 0;
      m[pl].pinterest+= r.pinterest_spend || 0;
      m[pl].bing     += r.bing_spend     || 0;
      m[pl].applovin += r.applovin_spend || 0;
    }
    return Object.entries(m)
      .map(([line, v]) => ({ line, ...v, mer: mer(v.revenue, v.spend) }))
      .sort((a,b) => b.revenue - a.revenue);
  }, [products]);

  const emailTotals = useMemo(() => email.reduce((a, r) => ({
    sent:    a.sent    + (r.emails_sent    || 0),
    opened:  a.opened  + (r.emails_opened  || 0),
    clicked: a.clicked + (r.emails_clicked || 0),
    revenue: a.revenue + (r.email_revenue  || 0),
  }), { sent:0, opened:0, clicked:0, revenue:0 }), [email]);

  return (
    <div>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:20, flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
            <h1 style={{ fontSize:22, fontWeight:800, margin:0, fontFamily:'var(--font-head)', color:FLO_ACCENT }}>
              Pilates FLO
            </h1>
            <span style={{ fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:99,
              background:'rgba(20,184,166,.15)', color:FLO_ACCENT, border:'1px solid rgba(20,184,166,.3)' }}>
              US Store
            </span>
          </div>
          <p style={{ fontSize:13, color:'var(--text3)', margin:0 }}>
            Complete store analytics · Portable · Wooden · Metal · {range.start} → {range.end}
          </p>
        </div>
        <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
      </div>

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          {/* KPI Strip */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:12, marginBottom:20 }}>
            <KpiCard label="Total Revenue" value={fmt$(totals.revenue)}     color="teal"   />
            <KpiCard label="Total Spend"   value={fmt$(totals.spend)}       color="warn"   />
            <KpiCard label="MER"           value={totalMer.toFixed(2)+'x'} color={totalMer>=2?'green':totalMer>=1.8?'warn':'red'} />
            <KpiCard label="Total Orders"  value={fmtNum(totals.orders)}    color="blue"   />
            <KpiCard label="NC Orders"     value={fmtNum(totals.nc)}        color="nobl"   />
            <KpiCard label="AOV"           value={fmt$(totalAov)}           color="purple" />
            <KpiCard label="NVP %"         value={nvpPct.toFixed(1)+'%'}    color={nvpPct>=50?'green':nvpPct>=45?'warn':'red'} />
            <KpiCard label="Product Lines" value={prodAgg.length + ' lines'} color="teal"  />
          </div>

          {/* Tabs */}
          <div style={{ display:'flex', gap:2, marginBottom:20, borderBottom:'1px solid var(--border)' }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding:'8px 16px', fontSize:13, fontWeight:600, border:'none',
                background:'none', cursor:'pointer',
                color: tab===t.id ? FLO_ACCENT : 'var(--text3)',
                borderBottom: tab===t.id ? `2px solid ${FLO_ACCENT}` : '2px solid transparent',
                transition:'color .15s',
              }}>{t.label}</button>
            ))}
          </div>

          {tab === 'overview'  && <OverviewTab  summary={summary} totals={totals} totalMer={totalMer} totalAov={totalAov} nvpPct={nvpPct} />}
          {tab === 'channels'  && <ChannelsTab  channels={channels} chAgg={chAgg} />}
          {tab === 'regions'   && <RegionsTab   geo={geo} geoAgg={geoAgg} />}
          {tab === 'products'  && <ProductsTab  products={products} prodAgg={prodAgg} />}
          {tab === 'email'     && <EmailTab     email={email} emailTotals={emailTotals} />}
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   OVERVIEW TAB
════════════════════════════════════════════════════════════════════ */
const OV_HEADERS = ['Date','Revenue','Spend','MER','Orders','NC Orders','RC Orders','NVP %','AOV'];
function OverviewTab({ summary, totals, totalMer, totalAov, nvpPct }) {
  const rows = summary.map(r => ({
    Date:       r.date,
    Revenue:    r.total_revenue,
    Spend:      r.total_spend,
    MER:        r.mer,
    Orders:     r.total_orders,
    'NC Orders':r.new_customer_orders,
    'RC Orders':r.returning_customer_orders,
    'NVP %':    r.nvp_pct,
    AOV:        r.aov,
  }));
  const chartData = [...summary].reverse();

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>Revenue & Spend — Daily</div>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
            <defs>
              <linearGradient id="fGradRev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={FLO_ACCENT} stopOpacity={0.3} />
                <stop offset="95%" stopColor={FLO_ACCENT} stopOpacity={0}   />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
            <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
            <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtLabel}
              contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            <Legend wrapperStyle={{ fontSize:12 }} />
            <Area type="monotone" dataKey="total_revenue" name="Revenue" stroke={FLO_ACCENT} fill="url(#fGradRev)" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="total_spend"   name="Spend"   stroke={FLO_WARN}  fill="none" strokeWidth={2} strokeDasharray="4 2" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>MER Daily</div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:10 }} stroke="var(--border2)" />
              <YAxis domain={['auto','auto']} tickFormatter={v => v.toFixed(1)+'x'} tick={{ fontSize:10 }} width={42} stroke="var(--border2)" />
              <Tooltip formatter={(v) => [v?.toFixed(2)+'x','MER']} labelFormatter={fmtLabel}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Line type="monotone" dataKey="mer" name="MER" stroke={FLO_ACCENT} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>New vs Returning Orders</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:10 }} stroke="var(--border2)" />
              <YAxis tick={{ fontSize:10 }} width={36} stroke="var(--border2)" />
              <Tooltip labelFormatter={fmtLabel}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Legend wrapperStyle={{ fontSize:11 }} />
              <Bar dataKey="new_customer_orders"       name="New"       stackId="a" fill="#14b8a6" radius={[0,0,0,0]} />
              <Bar dataKey="returning_customer_orders" name="Returning" stackId="a" fill="#6366f1" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Daily Summary — All Days</div>
        <SheetTable headers={OV_HEADERS} rows={rows} maxHeight="500px" defaultSortField="Date" defaultSortDir="desc" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CHANNELS TAB
════════════════════════════════════════════════════════════════════ */
const CH_AGG_HEADERS   = ['Channel','Spend','Revenue','ROAS','NC Orders','CAC'];
const CH_DAILY_HEADERS = ['Date','Channel','Spend','Revenue','ROAS','Purchases','NC Orders','CAC'];

function ChannelsTab({ channels, chAgg }) {
  const aggRows = chAgg.map(r => ({
    Channel:     r.channel,
    Spend:       r.spend,
    Revenue:     r.revenue,
    ROAS:        r.roas,
    'NC Orders': r.orders,
    CAC:         r.spend > 0 && r.orders > 0 ? parseFloat((r.spend/r.orders).toFixed(2)) : null,
  }));

  const dailyRows = channels.map(r => ({
    Date:        r.date,
    Channel:     r.channel,
    Spend:       r.spend_1d,
    Revenue:     r.revenue_1d,
    ROAS:        r.roas,
    Purchases:   r.purchases_1d,
    'NC Orders': r.new_cust_orders,
    CAC:         r.cac,
  }));

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:10 }}>
        {chAgg.map(ch => (
          <div key={ch.channel} style={{
            background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:10, padding:'12px 14px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background: CHANNEL_COL[ch.channel]||FLO_ACCENT }} />
              <span style={{ fontSize:12, fontWeight:700, color:'var(--text)' }}>{ch.channel}</span>
            </div>
            <div style={{ fontSize:14, fontWeight:800, color:'var(--text)', marginBottom:2 }}>{fmt$(ch.revenue)}</div>
            <div style={{ fontSize:11, color:'var(--text3)' }}>Spend: {fmt$(ch.spend)}</div>
            <div style={{ fontSize:12, fontWeight:700, color: merColor(ch.roas), marginTop:4 }}>
              {ch.roas.toFixed(2)}x ROAS
            </div>
          </div>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Spend by Channel</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chAgg} margin={{ top:4, right:16, left:0, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="channel" tick={{ fontSize:11 }} stroke="var(--border2)" />
              <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={70} stroke="var(--border2)" />
              <Tooltip formatter={(v) => [fmt$(v),'Spend']}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Bar dataKey="spend" radius={[4,4,0,0]}>
                {chAgg.map((e,i) => <Cell key={i} fill={CHANNEL_COL[e.channel]||FLO_ACCENT} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>ROAS by Channel</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chAgg} margin={{ top:4, right:16, left:0, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="channel" tick={{ fontSize:11 }} stroke="var(--border2)" />
              <YAxis domain={[0,'auto']} tickFormatter={v => v.toFixed(1)+'x'} tick={{ fontSize:11 }} width={50} stroke="var(--border2)" />
              <Tooltip formatter={(v) => [v.toFixed(2)+'x','ROAS']}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Bar dataKey="roas" radius={[4,4,0,0]}>
                {chAgg.map((e,i) => <Cell key={i} fill={CHANNEL_COL[e.channel]||FLO_ACCENT} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Period Totals by Channel</div>
        <SheetTable headers={CH_AGG_HEADERS} rows={aggRows} maxHeight="280px" defaultSortField="Revenue" defaultSortDir="desc" searchable={false} />
      </div>

      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>Daily Channel Data — Every Day</div>
        <div style={{ fontSize:11, color:'var(--text3)', marginBottom:14 }}>Each row = one day × one channel</div>
        <SheetTable headers={CH_DAILY_HEADERS} rows={dailyRows} maxHeight="600px" defaultSortField="Date" defaultSortDir="desc" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   REGIONS TAB
════════════════════════════════════════════════════════════════════ */
const GEO_AGG_HEADERS   = ['Region','Revenue','Spend','MER','Rev Share %'];
const GEO_DAILY_HEADERS = ['Date','Region','Revenue','Spend','MER'];

function RegionsTab({ geo, geoAgg }) {
  const totalRev = geoAgg.reduce((s,r) => s + r.revenue, 0);
  const aggRows = geoAgg.map(r => ({
    Region:        r.region,
    Revenue:       r.revenue,
    Spend:         r.spend,
    MER:           r.mer,
    'Rev Share %': totalRev > 0 ? parseFloat(((r.revenue/totalRev)*100).toFixed(1)) : 0,
  }));
  const dailyRows = geo.map(r => ({
    Date:   r.date,
    Region: r.region,
    Revenue:r.revenue,
    Spend:  r.spend,
    MER:    r.mer,
  }));

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))', gap:10 }}>
        {geoAgg.map((r,i) => (
          <div key={r.region} style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:10, padding:'12px 14px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background: GEO_COL[i%GEO_COL.length] }} />
              <span style={{ fontSize:12, fontWeight:700 }}>{r.region}</span>
            </div>
            <div style={{ fontSize:14, fontWeight:800, marginBottom:2 }}>{fmt$(r.revenue)}</div>
            <div style={{ fontSize:11, color:'var(--text3)', marginBottom:4 }}>Spend: {fmt$(r.spend)}</div>
            <div style={{ fontSize:12, fontWeight:700, color: merColor(r.mer) }}>{r.mer.toFixed(2)}x MER</div>
            {totalRev > 0 && (
              <div style={{ fontSize:11, color:'var(--text3)', marginTop:2 }}>
                {((r.revenue/totalRev)*100).toFixed(1)}% of rev
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Revenue by Region</div>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={geoAgg} dataKey="revenue" nameKey="region" cx="50%" cy="50%" outerRadius={90}
                label={({ region, percent }) => `${region} ${(percent*100).toFixed(0)}%`} labelLine={false}>
                {geoAgg.map((_,i) => <Cell key={i} fill={GEO_COL[i%GEO_COL.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => fmt$(v)}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>MER by Region</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={geoAgg} layout="vertical" margin={{ top:4, right:16, left:40, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" domain={[0,'auto']} tickFormatter={v => v.toFixed(1)+'x'} tick={{ fontSize:10 }} stroke="var(--border2)" />
              <YAxis type="category" dataKey="region" tick={{ fontSize:11 }} stroke="var(--border2)" />
              <Tooltip formatter={(v) => [v.toFixed(2)+'x','MER']}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Bar dataKey="mer" radius={[0,4,4,0]}>
                {geoAgg.map((_,i) => <Cell key={i} fill={GEO_COL[i%GEO_COL.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Period Totals by Region</div>
        <SheetTable headers={GEO_AGG_HEADERS} rows={aggRows} maxHeight="280px" defaultSortField="Revenue" defaultSortDir="desc" searchable={false} />
      </div>

      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>Daily Regional Data</div>
        <div style={{ fontSize:11, color:'var(--text3)', marginBottom:14 }}>Each row = one day × one region</div>
        <SheetTable headers={GEO_DAILY_HEADERS} rows={dailyRows} maxHeight="600px" defaultSortField="Date" defaultSortDir="desc" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PRODUCTS TAB
════════════════════════════════════════════════════════════════════ */
const PROD_AGG_HEADERS   = ['Product Line','Revenue','Spend','MER','NC Orders','CAC'];
const PROD_DAILY_HEADERS = ['Date','Product Line','Revenue','Spend','MER','NC Orders','Meta','Google','TikTok','Snap','Pinterest','Bing','AppLovin'];

function ProductsTab({ products, prodAgg }) {
  const totalRev = prodAgg.reduce((s,r) => s + r.revenue, 0);
  const capitalize = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

  const aggRows = prodAgg.map(r => ({
    'Product Line': capitalize(r.line),
    Revenue:        r.revenue,
    Spend:          r.spend,
    MER:            r.mer,
    'NC Orders':    r.orders,
    CAC:            r.spend > 0 && r.orders > 0 ? parseFloat((r.spend/r.orders).toFixed(2)) : null,
  }));

  const dailyRows = products.map(r => ({
    Date:             r.date,
    'Product Line':   capitalize(r.product_line),
    Revenue:          r.revenue,
    Spend:            r.spend,
    MER:              r.mer,
    'NC Orders':      r.new_cust_orders,
    Meta:             r.meta_spend,
    Google:           r.google_spend,
    TikTok:           r.tiktok_spend,
    Snap:             r.snap_spend,
    Pinterest:        r.pinterest_spend,
    Bing:             r.bing_spend,
    AppLovin:         r.applovin_spend,
  }));

  // Channel spend breakdown per product
  const channelKeys = ['meta','google','tiktok','snap','pinterest','bing','applovin'];
  const chBreakdown = prodAgg.map(p => ({
    name: capitalize(p.line),
    Meta: p.meta, Google: p.google, TikTok: p.tiktok,
    Snap: p.snap, Pinterest: p.pinterest, Bing: p.bing, AppLovin: p.applovin,
  }));

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Product line KPI cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:12 }}>
        {prodAgg.map(p => (
          <div key={p.line} style={{
            background:'var(--bg2)', border:`1px solid ${PROD_COL[p.line]||'var(--border)'}40`,
            borderRadius:12, padding:'16px 18px',
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
              <div style={{ width:10, height:10, borderRadius:3, background: PROD_COL[p.line]||FLO_ACCENT }} />
              <span style={{ fontSize:13, fontWeight:700, color:'var(--text)', textTransform:'capitalize' }}>
                {p.line} Reformer
              </span>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <div>
                <div style={{ fontSize:10, color:'var(--text3)', marginBottom:1 }}>Revenue</div>
                <div style={{ fontSize:14, fontWeight:800 }}>{fmt$(p.revenue)}</div>
              </div>
              <div>
                <div style={{ fontSize:10, color:'var(--text3)', marginBottom:1 }}>Spend</div>
                <div style={{ fontSize:14, fontWeight:800 }}>{fmt$(p.spend)}</div>
              </div>
              <div>
                <div style={{ fontSize:10, color:'var(--text3)', marginBottom:1 }}>MER</div>
                <div style={{ fontSize:14, fontWeight:800, color: merColor(p.mer) }}>{p.mer.toFixed(2)}x</div>
              </div>
              <div>
                <div style={{ fontSize:10, color:'var(--text3)', marginBottom:1 }}>NC Orders</div>
                <div style={{ fontSize:14, fontWeight:800 }}>{fmtNum(p.orders)}</div>
              </div>
            </div>
            {totalRev > 0 && (
              <div style={{ marginTop:8, fontSize:11, color:'var(--text3)' }}>
                {((p.revenue/totalRev)*100).toFixed(1)}% of total rev
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Revenue pie + Channel spend stacked bar */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Revenue Split by Product</div>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={prodAgg} dataKey="revenue" nameKey="line" cx="50%" cy="50%" outerRadius={90}
                label={({ line, percent }) => `${capitalize(line)} ${(percent*100).toFixed(0)}%`} labelLine={false}>
                {prodAgg.map(p => <Cell key={p.line} fill={PROD_COL[p.line]||FLO_ACCENT} />)}
              </Pie>
              <Tooltip formatter={(v) => fmt$(v)}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Channel Spend by Product</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chBreakdown} margin={{ top:4, right:16, left:0, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="name" tick={{ fontSize:11 }} stroke="var(--border2)" />
              <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={70} stroke="var(--border2)" />
              <Tooltip formatter={(v,n) => [fmt$(v),n]}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Legend wrapperStyle={{ fontSize:11 }} />
              <Bar dataKey="Meta"      stackId="a" fill={CHANNEL_COL.META}      />
              <Bar dataKey="Google"    stackId="a" fill={CHANNEL_COL.GOOGLE}    />
              <Bar dataKey="TikTok"    stackId="a" fill={CHANNEL_COL.TIKTOK}    />
              <Bar dataKey="Snap"      stackId="a" fill={CHANNEL_COL.SNAPCHAT}  />
              <Bar dataKey="Pinterest" stackId="a" fill={CHANNEL_COL.PINTEREST} />
              <Bar dataKey="Bing"      stackId="a" fill={CHANNEL_COL.BING}      />
              <Bar dataKey="AppLovin"  stackId="a" fill={CHANNEL_COL.APPLOVIN}  radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Aggregated product table */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Period Totals by Product Line</div>
        <SheetTable headers={PROD_AGG_HEADERS} rows={aggRows} maxHeight="200px" defaultSortField="Revenue" defaultSortDir="desc" searchable={false} />
      </div>

      {/* Daily product table */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>Daily Product Data — Every Day</div>
        <div style={{ fontSize:11, color:'var(--text3)', marginBottom:14 }}>Each row = one day × one product line, with channel spend breakdown</div>
        <SheetTable headers={PROD_DAILY_HEADERS} rows={dailyRows} maxHeight="600px" defaultSortField="Date" defaultSortDir="desc" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   EMAIL TAB
════════════════════════════════════════════════════════════════════ */
const EMAIL_HEADERS = ['Date','Sent','Opened','Clicked','Open Rate','Click Rate','Revenue'];

function EmailTab({ email, emailTotals }) {
  const rows = email.map(r => ({
    Date:         r.date,
    Sent:         r.emails_sent,
    Opened:       r.emails_opened,
    Clicked:      r.emails_clicked,
    'Open Rate':  r.open_rate,
    'Click Rate': r.click_rate,
    Revenue:      r.email_revenue,
  }));

  const avgOpenRate  = email.length > 0 ? email.reduce((s,r) => s+(r.open_rate||0),0)/email.length : 0;
  const avgClickRate = email.length > 0 ? email.reduce((s,r) => s+(r.click_rate||0),0)/email.length : 0;
  const chartData    = [...email].reverse();

  if (email.length === 0) {
    return (
      <div style={{ textAlign:'center', padding:'60px 20px', color:'var(--text3)', fontSize:14 }}>
        No email data available for this date range.
      </div>
    );
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:12 }}>
        <KpiCard label="Emails Sent"   value={fmtNum(emailTotals.sent)}    color="blue"   />
        <KpiCard label="Opened"        value={fmtNum(emailTotals.opened)}  color="teal"   />
        <KpiCard label="Clicked"       value={fmtNum(emailTotals.clicked)} color="nobl"   />
        <KpiCard label="Avg Open Rate" value={fmtPct(avgOpenRate)}         color="green"  />
        <KpiCard label="Avg Click Rate"value={fmtPct(avgClickRate)}        color="purple" />
        <KpiCard label="Email Revenue" value={fmt$(emailTotals.revenue)}   color="teal"   />
      </div>

      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Email Revenue — Daily</div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
            <defs>
              <linearGradient id="fGradEmail" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={FLO_ACCENT} stopOpacity={0.3} />
                <stop offset="95%" stopColor={FLO_ACCENT} stopOpacity={0}   />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
            <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
            <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtLabel}
              contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            <Area type="monotone" dataKey="email_revenue" name="Email Revenue" stroke={FLO_ACCENT} fill="url(#fGradEmail)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Daily Email Stats</div>
        <SheetTable headers={EMAIL_HEADERS} rows={rows} maxHeight="500px" defaultSortField="Date" defaultSortDir="desc" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SKELETON / ERROR
════════════════════════════════════════════════════════════════════ */
function Skeleton() {
  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:12, marginBottom:20 }}>
        {[...Array(8)].map((_,i) => (
          <div key={i} style={{ height:78, background:'var(--bg3)', borderRadius:12, animation:'pulse 1.5s ease-in-out infinite' }} />
        ))}
      </div>
      <div style={{ height:280, background:'var(--bg2)', borderRadius:12, animation:'pulse 1.5s ease-in-out infinite' }} />
    </div>
  );
}

function ErrorMsg({ msg, onRetry }) {
  return (
    <div style={{ padding:'40px 0', textAlign:'center' }}>
      <div style={{ color:'var(--danger)', marginBottom:12, fontSize:14 }}>Failed to load: {msg}</div>
      <button onClick={onRetry} style={{ padding:'8px 20px', background:'var(--accent)', color:'#fff',
        border:'none', borderRadius:8, cursor:'pointer', fontWeight:600 }}>Retry</button>
    </div>
  );
}
