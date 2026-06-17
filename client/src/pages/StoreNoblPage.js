import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getStoreNobl, fmt$, fmtNum, fmtPct, fmtRatio } from '../utils/api';
import KpiCard from '../components/KpiCard';
import PageFilterBar from '../components/PageFilterBar';
import PaginatedSheetTable from '../components/PaginatedSheetTable';
import VerticalDataTable from '../components/VerticalDataTable';
import { CommentProvider } from '../components/CommentProvider';
import { commentTargetKey } from '../utils/commentKeys';
import { aggCellKey, dailyCellKey, dailyCellLabel, entityDateCellKey, entityDateCellLabel } from '../utils/sheetComments';
import { L, TIP, PAGE } from '../copy/plainLanguage';
import { mtdRange } from '../utils/dateRange';
import { fmtAxisRatio, fmtAxisCurrency } from '../utils/chartHelpers';
function fmtLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${M[parseInt(mo)-1]} ${parseInt(dy)}`;
}
function mer(rev, spend) { return spend > 0 ? (rev / spend) : 0; }

const PAGE_KEY = 'store-nobl';

/* ── colour palettes ─────────────────────────────────────────────── */
const CHANNEL_COL = {
  META:'#1877f2', GOOGLE:'#ea4335', TIKTOK:'#69c9d0', SNAPCHAT:'#f7c948',
  PINTEREST:'#e60023', APPLOVIN:'#ff8c00', BING:'#00809d', X:'#657786',
};
const GEO_COL  = ['#6366f1','#14b8a6','#f59e0b','#ef4444','#8b5cf6','#06b6d4'];
const NOBL_ACCENT = '#6366f1';
const NOBL_WARN   = '#f59e0b';

/* ── tab list ────────────────────────────────────────────────────── */
const TABS = [
  { id:'overview',      label:'Overview'      },
  { id:'channels',      label:'Channels'      },
  { id:'regions',       label:'Regions'       },
  { id:'subscriptions', label:'Subscriptions' },
  { id:'email',         label:'Email'         },
];

/* ── colour helper for MER / ROAS ────────────────────────────────── */
function merColor(v) {
  if (!v) return 'var(--text3)';
  if (v >= 2.0) return 'var(--success, #22c55e)';
  if (v >= 1.8) return 'var(--warn, #f59e0b)';
  return 'var(--danger, #ef4444)';
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN PAGE
════════════════════════════════════════════════════════════════════ */
export default function StoreNoblPage({ showToast }) {
  const [range, setRange]   = useState(mtdRange());
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [tab, setTab]       = useState('overview');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getStoreNobl(range.start, range.end)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  /* ── aggregations used across multiple tabs ── */
  const summary   = data?.summary   || [];
  const channels  = data?.channels  || [];
  const geo       = data?.geo       || [];
  const subDaily  = data?.subs_daily || [];
  const subStats  = data?.subs_stats || {};
  const email     = data?.email      || [];

  const totals = useMemo(() => summary.reduce((a, r) => ({
    revenue: a.revenue + (r.order_revenue || r.total_revenue || 0),
    spend:   a.spend   + (r.total_spend   || 0),
    orders:  a.orders  + (r.total_orders  || 0),
    nc:      a.nc      + (r.new_customer_orders      || 0),
    rc:      a.rc      + (r.returning_customer_orders || 0),
  }), { revenue:0, spend:0, orders:0, nc:0, rc:0 }), [summary]);

  const totalMer = mer(totals.revenue, totals.spend);
  const totalAov = totals.orders > 0 ? totals.revenue / totals.orders : 0;
  const nvpPct   = totals.orders > 0 ? (totals.nc / totals.orders) * 100 : 0;

  // Channel aggregates (across full period)
  const chAgg = useMemo(() => {
    const m = {};
    for (const r of channels) {
      if (!m[r.channel]) m[r.channel] = { spend:0, revenue:0, orders:0, days:0 };
      m[r.channel].spend   += r.spend_1d   || 0;
      m[r.channel].revenue += r.revenue_1d || 0;
      m[r.channel].orders  += r.new_cust_orders || 0;
      if ((r.spend_1d || 0) > 0) m[r.channel].days++;
    }
    return Object.entries(m)
      .map(([ch, v]) => ({ channel:ch, ...v, roas: mer(v.revenue, v.spend) }))
      .sort((a,b) => b.revenue - a.revenue);
  }, [channels]);

  // Geo aggregates (across full period)
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

  // Sub totals
  const subTotals = useMemo(() => subDaily.reduce((a, r) => ({
    total:       a.total       + (Number(r.sub_revenue_actual) || 0),
    rebill:      a.rebill      + (Number(r.rebill_revenue)     || 0),
    newSubRev:   a.newSubRev   + (Number(r.new_sub_revenue)    || 0),
    newSubCount: a.newSubCount + (Number(r.new_sub_count)      || 0),
  }), { total:0, rebill:0, newSubRev:0, newSubCount:0 }), [subDaily]);

  // Email totals
  const emailTotals = useMemo(() => email.reduce((a, r) => ({
    sent:    a.sent    + (r.emails_sent    || 0),
    opened:  a.opened  + (r.emails_opened  || 0),
    clicked: a.clicked + (r.emails_clicked || 0),
    revenue: a.revenue + (r.email_revenue  || 0),
  }), { sent:0, opened:0, clicked:0, revenue:0 }), [email]);

  return (
    <CommentProvider pageKey={PAGE_KEY}>
    <div className="page-stack">
      <PageFilterBar start={range.start} end={range.end} onChange={setRange} />

      <div className="page-header">
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
            <h1 style={{ fontSize:22, fontWeight:800, margin:0, fontFamily:'var(--font-head)', color:NOBL_ACCENT }}>
              NOBL Travel
            </h1>
            <span style={{ fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:99,
              background:'rgba(99,102,241,.15)', color:NOBL_ACCENT, border:'1px solid rgba(99,102,241,.3)' }}>
              🇺🇸 US + 🇪🇺 EU — Combined
            </span>
          </div>
          <p style={{ fontSize:13, color:'var(--text3)', margin:0 }}>
            {PAGE.storeNobl.desc} · {range.start} → {range.end}
          </p>
        </div>
      </div>

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 14px',
            background:'rgba(99,102,241,.07)', border:'1px solid rgba(99,102,241,.2)', borderRadius:8, fontSize:12 }}>
            <span style={{ color:NOBL_ACCENT, fontWeight:700 }}>ℹ EU included</span>
            <span style={{ color:'var(--text3)' }}>
              NOBL Travel operates one Shopify store for all regions. EU data is always summed into all metrics below.
            </span>
          </div>

          <div className="page-kpi-grid">
            <KpiCard label="Order Revenue" value={fmt$(totals.revenue)} fullValue={fmt$(totals.revenue)} tooltip={TIP.orderRevenue} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('order_revenue'), targetLabel: 'Order Revenue' }} />
            <KpiCard label="Total ad spend" value={fmt$(totals.spend)} fullValue={fmt$(totals.spend)} tooltip={TIP.spend} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_spend'), targetLabel: 'Total Ad Spend' }} />
            <KpiCard label={L.mer} value={fmtRatio(totalMer)} copyValue={totalMer.toFixed(4)} tooltip={TIP.mer} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('mer'), targetLabel: L.mer }} />
            <KpiCard label="Total orders" value={fmtNum(totals.orders)} fullValue={String(totals.orders)} tooltip={TIP.orders} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_orders'), targetLabel: 'Total Orders' }} />
            <KpiCard label={L.ncOrders} value={fmtNum(totals.nc)} fullValue={String(totals.nc)} tooltip={TIP.ncOrders} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('nc_orders'), targetLabel: L.ncOrders }} />
            <KpiCard label={L.aov} value={fmt$(totalAov)} fullValue={fmt$(totalAov)} tooltip={TIP.aov} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('aov'), targetLabel: L.aov }} />
            <KpiCard label={L.nvp} value={fmtPct(nvpPct)} copyValue={nvpPct.toFixed(2)} tooltip={TIP.nvp} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('nvp'), targetLabel: L.nvp }} />
            <KpiCard label={L.activeSubs} value={fmtNum(subStats.active||0)} fullValue={String(subStats.active||0)} tooltip={TIP.activeSubs} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('active_subs'), targetLabel: L.activeSubs }} />
          </div>

          <div className="page-tabs">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding:'8px 16px', fontSize:13, fontWeight:600, border:'none',
                background:'none', cursor:'pointer',
                color: tab===t.id ? NOBL_ACCENT : 'var(--text3)',
                borderBottom: tab===t.id ? `2px solid ${NOBL_ACCENT}` : '2px solid transparent',
                transition:'color .15s',
              }}>{t.label}</button>
            ))}
          </div>

          {tab === 'overview'      && <OverviewTab      summary={summary}  totals={totals} totalMer={totalMer} totalAov={totalAov} nvpPct={nvpPct} />}
          {tab === 'channels'      && <ChannelsTab      channels={channels} chAgg={chAgg} />}
          {tab === 'regions'       && <RegionsTab       geo={geo}     geoAgg={geoAgg} />}
          {tab === 'subscriptions' && <SubscriptionsTab subDaily={subDaily} subStats={subStats} subTotals={subTotals} />}
          {tab === 'email'         && <EmailTab         email={email}  emailTotals={emailTotals} />}
        </>
      )}
    </div>
    </CommentProvider>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   OVERVIEW TAB
════════════════════════════════════════════════════════════════════ */
const OV_METRICS = [
  { key: 'order_revenue', label: 'Order Revenue', type: '$' },
  { key: 'total_spend', label: 'Spend', type: '$' },
  { key: 'mer', label: 'MER', type: 'x' },
  { key: 'total_orders', label: 'Orders', type: 'num' },
  { key: 'new_customer_orders', label: 'NC Orders', type: 'num' },
  { key: 'returning_customer_orders', label: 'RC Orders', type: 'num' },
  { key: 'nvp_pct', label: 'NVP %', type: 'num' },
  { key: 'aov', label: 'AOV', type: '$' },
];

function OverviewTab({ summary, totals, totalMer, totalAov, nvpPct }) {
  const summaryByDate = {};
  const dates = [];
  for (const r of summary) {
    summaryByDate[r.date] = {
      ...r,
      order_revenue: r.order_revenue || r.total_revenue,
    };
    dates.push(r.date);
  }
  dates.sort();

  // chart data reversed for chronological order
  const chartData = [...summary].reverse();

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Revenue + Spend chart */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>Revenue & Spend — Daily</div>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
            <defs>
              <linearGradient id="nGradRev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={NOBL_ACCENT} stopOpacity={0.3} />
                <stop offset="95%" stopColor={NOBL_ACCENT} stopOpacity={0}   />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
            <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
            <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtLabel}
              contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            <Legend wrapperStyle={{ fontSize:12 }} />
            <Area type="monotone" dataKey="order_revenue" name="Order Revenue" stroke={NOBL_ACCENT} fill="url(#nGradRev)" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="total_spend"   name="Spend"   stroke={NOBL_WARN}  fill="none" strokeWidth={2} strokeDasharray="4 2" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* MER + New vs Returning */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>MER Daily</div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:10 }} stroke="var(--border2)" />
              <YAxis domain={['auto','auto']} tick={{ fontSize:10 }} width={40} stroke="var(--border2)"
                tickFormatter={fmtAxisRatio} />
              <Tooltip formatter={(v) => [fmtRatio(v), 'MER']} labelFormatter={fmtLabel}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Line type="monotone" dataKey="mer" name="MER" stroke={NOBL_ACCENT} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>New vs Returning Orders</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:10 }} stroke="var(--border2)" />
              <YAxis tick={{ fontSize:10 }} width={36} stroke="var(--border2)" />
              <Tooltip labelFormatter={fmtLabel}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Legend wrapperStyle={{ fontSize:11 }} />
              <Bar dataKey="new_customer_orders"       name="New"       stackId="a" fill="#6366f1" radius={[0,0,0,0]} />
              <Bar dataKey="returning_customer_orders" name="Returning" stackId="a" fill="#14b8a6" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Daily summary table */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Daily Summary — All Days</div>
        <VerticalDataTable dates={dates} getRow={(d) => summaryByDate[d]} metrics={OV_METRICS} tableScope="overview" />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CHANNELS TAB
════════════════════════════════════════════════════════════════════ */
const CH_AGG_HEADERS  = ['Channel','Spend','Revenue','ROAS','NC Orders','CAC'];
const CH_DAILY_HEADERS = ['Date','Channel','Spend','Revenue','ROAS','Purchases','NC Orders','CAC'];

function ChannelsTab({ channels, chAgg }) {
  const aggRows = chAgg.map(r => ({
    Channel:     r.channel,
    Spend:       r.spend,
    Revenue:     r.revenue,
    ROAS:        r.roas,
    'NC Orders': r.orders,
    CAC:         r.spend > 0 && r.orders > 0 ? parseFloat((r.spend / r.orders).toFixed(2)) : null,
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
      {/* Period KPIs per channel */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:10 }}>
        {chAgg.map(ch => (
          <div key={ch.channel} style={{
            background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:10, padding:'12px 14px',
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background: CHANNEL_COL[ch.channel]||'#6366f1' }} />
              <span style={{ fontSize:12, fontWeight:700, color:'var(--text)' }}>{ch.channel}</span>
            </div>
            <div style={{ fontSize:14, fontWeight:800, color:'var(--text)', marginBottom:2 }}>{fmt$(ch.revenue)}</div>
            <div style={{ fontSize:11, color:'var(--text3)' }}>Spend: {fmt$(ch.spend)}</div>
            <div style={{ fontSize:12, fontWeight:700, color: merColor(ch.roas), marginTop:4 }}>
              {fmtRatio(ch.roas)} ROAS
            </div>
          </div>
        ))}
      </div>

      {/* Spend + ROAS charts */}
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
              <Bar dataKey="spend" name="Spend" radius={[4,4,0,0]}>
                {chAgg.map((e,i) => <Cell key={i} fill={CHANNEL_COL[e.channel]||NOBL_ACCENT} />)}
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
              <YAxis domain={[0,'auto']} tickFormatter={fmtAxisRatio} tick={{ fontSize:11 }} width={50} stroke="var(--border2)" />
              <Tooltip formatter={(v) => [fmtRatio(v), 'ROAS']}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Bar dataKey="roas" name="ROAS" radius={[4,4,0,0]}>
                {chAgg.map((e,i) => <Cell key={i} fill={CHANNEL_COL[e.channel]||NOBL_ACCENT} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Aggregated channel table */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Period Totals by Channel</div>
        <PaginatedSheetTable
          headers={CH_AGG_HEADERS}
          rows={aggRows}
          defaultSortField="Revenue"
          defaultSortDir="desc"
          searchable={false}
          getCellCommentKey={(row, h) => aggCellKey('ch-agg', row, h, 'Channel')}
        />
      </div>

      {/* Daily channel table — every day × every channel */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>Daily Channel Data — Every Day</div>
        <div style={{ fontSize:11, color:'var(--text3)', marginBottom:14 }}>
          Each row = one day × one channel. Sort and filter to explore.
        </div>
        <PaginatedSheetTable
          headers={CH_DAILY_HEADERS}
          rows={dailyRows}
          defaultSortField="Date"
          defaultSortDir="desc"
          getCellCommentKey={(row, h) => entityDateCellKey('ch-daily', row, h, 'Channel')}
          getCellCommentLabel={(row, h) => entityDateCellLabel('channel', h, row, 'Channel')}
        />
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
    Region:      r.region,
    Revenue:     r.revenue,
    Spend:       r.spend,
    MER:         r.mer,
    'Rev Share %': totalRev > 0 ? Math.round((r.revenue / totalRev) * 100) : 0,
  }));

  const dailyRows = geo.map(r => ({
    Date:   r.date,
    Region: r.region,
    Revenue:r.revenue,
    Spend:  r.spend,
    MER:    r.mer,
  }));

  // Regions sorted by revenue (descending)
  const sortedGeo = geoAgg;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Region cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))', gap:10 }}>
        {sortedGeo.map((r, i) => (
          <div key={r.region} style={{
            background:'var(--bg2)', border: r.region==='EU' ? '1px solid rgba(99,102,241,.4)' : '1px solid var(--border)',
            borderRadius:10, padding:'12px 14px', position:'relative',
          }}>
            {r.region === 'EU' && (
              <span style={{ position:'absolute', top:8, right:8, fontSize:9, fontWeight:700,
                padding:'1px 6px', borderRadius:99, background:'rgba(99,102,241,.15)', color:NOBL_ACCENT }}>
                ✓ IN TOTALS
              </span>
            )}
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background: GEO_COL[i % GEO_COL.length] }} />
              <span style={{ fontSize:12, fontWeight:700, color:'var(--text)' }}>{r.region}</span>
            </div>
            <div style={{ fontSize:14, fontWeight:800, color:'var(--text)', marginBottom:2 }}>{fmt$(r.revenue)}</div>
            <div style={{ fontSize:11, color:'var(--text3)', marginBottom:4 }}>Spend: {fmt$(r.spend)}</div>
            <div style={{ fontSize:12, fontWeight:700, color: merColor(r.mer) }}>{fmtRatio(r.mer)} MER</div>
            {totalRev > 0 && (
              <div style={{ fontSize:11, color:'var(--text3)', marginTop:2 }}>
                {Math.round((r.revenue / totalRev) * 100)}% of rev
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Revenue pie + Spend bar */}
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
            <BarChart data={sortedGeo} layout="vertical" margin={{ top:4, right:16, left:40, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" domain={[0,'auto']} tickFormatter={fmtAxisRatio} tick={{ fontSize:10 }} stroke="var(--border2)" />
              <YAxis type="category" dataKey="region" tick={{ fontSize:11 }} stroke="var(--border2)" />
              <Tooltip formatter={(v) => [fmtRatio(v), 'MER']}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Bar dataKey="mer" name="MER" radius={[0,4,4,0]}>
                {sortedGeo.map((_,i) => <Cell key={i} fill={GEO_COL[i%GEO_COL.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Aggregated geo table */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Period Totals by Region</div>
        <PaginatedSheetTable
          headers={GEO_AGG_HEADERS}
          rows={aggRows}
          defaultSortField="Revenue"
          defaultSortDir="desc"
          searchable={false}
          getCellCommentKey={(row, h) => aggCellKey('geo-agg', row, h, 'Region')}
        />
      </div>

      {/* Daily geo table */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>Daily Regional Data — Every Day</div>
        <div style={{ fontSize:11, color:'var(--text3)', marginBottom:14 }}>Each row = one day × one region (EU always shown)</div>
        <PaginatedSheetTable
          headers={GEO_DAILY_HEADERS}
          rows={dailyRows}
          defaultSortField="Date"
          defaultSortDir="desc"
          getCellCommentKey={(row, h) => entityDateCellKey('geo-daily', row, h, 'Region')}
          getCellCommentLabel={(row, h) => entityDateCellLabel('region', h, row, 'Region')}
        />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SUBSCRIPTIONS TAB
════════════════════════════════════════════════════════════════════ */
const SUB_HEADERS = ['Date','New Subs','New Sub Rev','Rebill Rev','Total Sub Rev'];

function SubscriptionsTab({ subDaily, subStats, subTotals }) {
  const rows = subDaily.map(r => ({
    Date:           r.date,
    'New Subs':     r.new_sub_count ?? 0,
    'New Sub Rev':  r.new_sub_revenue,
    'Rebill Rev':   r.rebill_revenue,
    'Total Sub Rev':r.sub_revenue_actual,
  }));

  // Daily array is desc; chart needs chronological order
  const chartData = [...subDaily].reverse();

  if (subDaily.length === 0 && (subStats.active || 0) === 0) {
    return (
      <div style={{ textAlign:'center', padding:'60px 20px', color:'var(--text3)', fontSize:14 }}>
        No subscription activity in this date range.
      </div>
    );
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Period KPIs (move with the date picker) */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:12 }}>
        <KpiCard label="Subscription sales" sub="in date range" value={fmt$(subTotals.total)} tooltip={TIP.totalSubRevenue} color="nobl"   />
        <KpiCard label={L.newSubs}           sub="in date range" value={fmtNum(subTotals.newSubCount)} tooltip={TIP.newSubs} color="teal"   />
        <KpiCard label={L.newSubRevenue}    sub="in date range" value={fmt$(subTotals.newSubRev)} tooltip={TIP.newSubRevenue} color="teal"   />
        <KpiCard label={L.rebillRevenue}     sub="in date range" value={fmt$(subTotals.rebill)} tooltip={TIP.rebillRevenue} color="blue"   />
      </div>
      {/* All-time subscriber snapshot */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:12 }}>
        <KpiCard label={L.activeSubs}        sub="right now" value={fmtNum(subStats.active    || 0)} tooltip={TIP.activeSubs} color="nobl"   />
        <KpiCard label={L.converted}          sub="right now" value={fmtNum(subStats.converted || 0)} tooltip={TIP.converted} color="blue"   />
        <KpiCard label={L.cancelled}          sub="right now" value={fmtNum(subStats.cancelled || 0)} tooltip={TIP.cancelled} color="warn"   />
        <KpiCard label={L.avgContract} sub="right now" value={fmt$(subStats.avg_order_amount || 0)} tooltip={TIP.avgContract} color="purple" />
      </div>

      {/* Trend chart */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Subscription Revenue — Daily</div>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
            <defs>
              <linearGradient id="nGradSub" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#8b5cf6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}   />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
            <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
            <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtLabel}
              contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            <Legend wrapperStyle={{ fontSize:12 }} />
            <Area type="monotone" dataKey="sub_revenue_actual" name="Total Sub Rev" stroke="#8b5cf6" fill="url(#nGradSub)" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="rebill_revenue"     name="Rebill"        stroke="#6366f1" fill="none" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
            <Area type="monotone" dataKey="new_sub_revenue"    name="New Subs"      stroke="#14b8a6" fill="none" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Daily table */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Daily Subscription Detail</div>
        <PaginatedSheetTable
          headers={SUB_HEADERS}
          rows={rows}
          defaultSortField="Date"
          defaultSortDir="desc"
          getCellCommentKey={(row, h) => dailyCellKey('subs', row, h, 'Date')}
          getCellCommentLabel={(row, h) => dailyCellLabel(h, row, 'Date')}
        />
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
    Date:          r.date,
    Sent:          r.emails_sent,
    Opened:        r.emails_opened,
    Clicked:       r.emails_clicked,
    'Open Rate':   r.open_rate,
    'Click Rate':  r.click_rate,
    Revenue:       r.email_revenue,
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
        <KpiCard label={L.emailSent}  value={fmtNum(emailTotals.sent)}    color="blue"   />
        <KpiCard label={L.emailOpened}       value={fmtNum(emailTotals.opened)}  color="teal"   />
        <KpiCard label={L.emailClicked}      value={fmtNum(emailTotals.clicked)} color="nobl"   />
        <KpiCard label={L.openRate} value={fmtPct(avgOpenRate)}        color="green"  />
        <KpiCard label={L.clickRate}value={fmtPct(avgClickRate)}       color="purple" />
        <KpiCard label={L.emailRevenue} value={fmt$(emailTotals.revenue)} tooltip={TIP.emailRevenue} color="nobl"   />
      </div>

      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Email Revenue — Daily</div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
            <defs>
              <linearGradient id="nGradEmail" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#14b8a6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#14b8a6" stopOpacity={0}   />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
            <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
            <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtLabel}
              contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            <Area type="monotone" dataKey="email_revenue" name="Email Revenue" stroke="#14b8a6" fill="url(#nGradEmail)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Daily Email Stats</div>
        <PaginatedSheetTable
          headers={EMAIL_HEADERS}
          rows={rows}
          defaultSortField="Date"
          defaultSortDir="desc"
          getCellCommentKey={(row, h) => dailyCellKey('email', row, h, 'Date')}
          getCellCommentLabel={(row, h) => dailyCellLabel(h, row, 'Date')}
        />
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
