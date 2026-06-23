import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getStoreFlo, fmt$, fmtNum, fmtPct, fmtRatio } from '../utils/api';
import KpiCard from '../components/KpiCard';
import PageIntro from '../components/PageIntro';
import ChartPanel from '../components/ChartPanel';
import PaginatedSheetTable from '../components/PaginatedSheetTable';
import { useDashboardFilters } from '../context/DashboardFilterContext';
import VerticalDataTable from '../components/VerticalDataTable';
import { CommentProvider } from '../components/CommentProvider';
import { commentTargetKey } from '../utils/commentKeys';
import { aggCellKey, dailyCellKey, dailyCellLabel, entityDateCellKey, entityDateCellLabel } from '../utils/sheetComments';
import { L, TIP } from '../copy/plainLanguage';
import { fmtAxisRatio, fmtAxisCurrency } from '../utils/chartHelpers';
import useDailyForecast from '../hooks/useDailyForecast';
import { buildForecastCellStatus } from '../utils/forecastCellStatus';

const FORECAST_METRIC_MAP = {
  'order_revenue': 'revenue',
  'total_revenue': 'revenue',
  'revenue': 'revenue',
  'total_spend': 'spend',
  'spend': 'spend',
  'Revenue': 'revenue',
  'Spend': 'spend',
};
function fmtLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${M[parseInt(mo)-1]} ${parseInt(dy)}`;
}
function mer(rev, spend) { return spend > 0 ? (rev / spend) : 0; }

const PAGE_KEY = 'store-flo';

/* ── palettes ─────────────────────────────────────────────────────── */
const CHANNEL_COL = {
  META:'#1877f2', GOOGLE:'#ea4335', TIKTOK:'#69c9d0', SNAPCHAT:'#f7c948',
  PINTEREST:'#e60023', APPLOVIN:'#ff8c00', BING:'#00809d', X:'#657786',
};
const GEO_COL     = ['#14b8a6','#6366f1','#f59e0b','#ef4444','#8b5cf6','#06b6d4'];
const PROD_COL    = { portable:'#14b8a6', wooden:'#f59e0b', metal:'#6366f1', mixed:'#94a3b8', unclassified:'#64748b' };
const CORE_PRODUCT_LINES = ['portable', 'wooden', 'metal'];
const FLO_ACCENT  = '#14b8a6';
const FLO_WARN    = '#f59e0b';

/* ── tabs ────────────────────────────────────────────────────────── */
const TABS = [
  { id:'overview',      label:'Overview'      },
  { id:'channels',      label:'Channels'      },
  { id:'regions',       label:'Regions'       },
  { id:'products',      label:'Products'      },
  { id:'subscriptions', label:'Subscriptions' },
  { id:'email',         label:'Email'         },
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
  const { dateRange, filterByChannels, filterByRegions, isAllRegions } = useDashboardFilters();
  const range = dateRange;
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState('overview');

  const fc = useDailyForecast('FLO', dateRange.start, dateRange.end);
  const cellStatus = useCallback(buildForecastCellStatus(fc, { metrics: FORECAST_METRIC_MAP }), [fc]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getStoreFlo(range.start, range.end)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const summary  = data?.summary  || [];
  const channels = filterByChannels(data?.channels || [], 'channel');
  const geo      = filterByRegions(data?.geo      || [], 'region');
  const products = data?.products || [];
  const subDaily = data?.subs_daily || [];
  const subStats = data?.subs_stats || {};
  const email    = data?.email    || [];

  const subTotals = useMemo(() => subDaily.reduce((a, r) => ({
    total:       a.total       + (Number(r.sub_revenue_actual) || 0),
    rebill:      a.rebill      + (Number(r.rebill_revenue)     || 0),
    newSubRev:   a.newSubRev   + (Number(r.new_sub_revenue)    || 0),
    newSubCount: a.newSubCount + (Number(r.new_sub_count)      || 0),
  }), { total:0, rebill:0, newSubRev:0, newSubCount:0 }), [subDaily]);

  const totals = useMemo(() => {
    if (!isAllRegions && geo.length) {
      const revenue = geo.reduce((a, r) => a + (r.revenue || r.revenue_actual || 0), 0);
      const spend = geo.reduce((a, r) => a + (r.spend || r.spend_actual || 0), 0);
      return { revenue, spend, orders: 0, nc: 0, rc: 0 };
    }
    return summary.reduce((a, r) => ({
      revenue: a.revenue + (r.order_revenue || r.total_revenue || 0),
      spend:   a.spend   + (r.total_spend   || 0),
      orders:  a.orders  + (r.total_orders  || 0),
      nc:      a.nc      + (r.new_customer_orders      || 0),
      rc:      a.rc      + (r.returning_customer_orders || 0),
    }), { revenue:0, spend:0, orders:0, nc:0, rc:0 });
  }, [summary, geo, isAllRegions]);

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

  const coreProdAgg = useMemo(() => prodAgg.filter(p => CORE_PRODUCT_LINES.includes(p.line)), [prodAgg]);

  const emailTotals = useMemo(() => email.reduce((a, r) => ({
    sent:    a.sent    + (r.emails_sent    || 0),
    opened:  a.opened  + (r.emails_opened  || 0),
    clicked: a.clicked + (r.emails_clicked || 0),
    revenue: a.revenue + (r.email_revenue  || 0),
  }), { sent:0, opened:0, clicked:0, revenue:0 }), [email]);

  return (
    <CommentProvider pageKey={PAGE_KEY}>
    <div className="page-stack">

      <PageIntro actions={<span className="badge badge--accent">US Store</span>} />

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          <div className="section">
            <div className="section__title">Store Summary</div>
            <div className="page-kpi-grid">
              <KpiCard label="Order Revenue" value={fmt$(totals.revenue)} fullValue={fmt$(totals.revenue)} tooltip={TIP.orderRevenue} accent="flo" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('order_revenue'), targetLabel: 'Order Revenue' }} />
              <KpiCard label="Total ad spend" value={fmt$(totals.spend)} fullValue={fmt$(totals.spend)} tooltip={TIP.spend} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_spend'), targetLabel: 'Total Ad Spend' }} />
              <KpiCard label={L.mer} value={fmtRatio(totalMer)} copyValue={totalMer.toFixed(4)} tooltip={TIP.mer} accent="flo" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('mer'), targetLabel: L.mer }} />
              <KpiCard label="Total orders" value={fmtNum(totals.orders)} fullValue={String(totals.orders)} tooltip={TIP.orders} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_orders'), targetLabel: 'Total Orders' }} />
              <KpiCard label={L.ncOrders} value={fmtNum(totals.nc)} fullValue={String(totals.nc)} tooltip={TIP.ncOrders} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('nc_orders'), targetLabel: L.ncOrders }} />
              <KpiCard label={L.aov} value={fmt$(totalAov)} fullValue={fmt$(totalAov)} tooltip={TIP.aov} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('aov'), targetLabel: L.aov }} />
              <KpiCard label={L.nvp} value={fmtPct(nvpPct)} copyValue={nvpPct.toFixed(2)} tooltip={TIP.nvp} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('nvp'), targetLabel: L.nvp }} />
              <KpiCard label="Product Lines" value={coreProdAgg.length + ' lines'} copyValue={String(coreProdAgg.length)} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('product_lines'), targetLabel: 'Product Lines' }} />
            </div>
          </div>

          <div className="seg">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`seg__btn${tab === t.id ? ' seg__btn--active' : ''}`}
              >{t.label}</button>
            ))}
          </div>

          {tab === 'overview'      && <OverviewTab      summary={summary} totals={totals} totalMer={totalMer} totalAov={totalAov} nvpPct={nvpPct} cellStatus={cellStatus} />}
          {tab === 'channels'      && <ChannelsTab      channels={channels} chAgg={chAgg} cellStatus={cellStatus} />}
          {tab === 'regions'       && <RegionsTab       geo={geo} geoAgg={geoAgg} cellStatus={cellStatus} />}
          {tab === 'products'      && <ProductsTab      products={products} prodAgg={prodAgg} cellStatus={cellStatus} />}
          {tab === 'subscriptions' && <SubscriptionsTab subDaily={subDaily} subStats={subStats} subTotals={subTotals} cellStatus={cellStatus} />}
          {tab === 'email'         && <EmailTab         email={email} emailTotals={emailTotals} cellStatus={cellStatus} />}
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

function OverviewTab({ summary, totals, totalMer, totalAov, nvpPct, cellStatus }) {
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
  const chartData = [...summary].reverse();

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <ChartPanel title="Revenue & Spend — Daily">
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
            <Area type="monotone" dataKey="order_revenue" name="Order Revenue" stroke={FLO_ACCENT} fill="url(#fGradRev)" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="total_spend"   name="Spend"   stroke={FLO_WARN}  fill="none" strokeWidth={2} strokeDasharray="4 2" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartPanel>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <ChartPanel title="MER Daily">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:10 }} stroke="var(--border2)" />
              <YAxis domain={['auto','auto']} tickFormatter={fmtAxisRatio} tick={{ fontSize:10 }} width={42} stroke="var(--border2)" />
              <Tooltip formatter={(v) => [fmtRatio(v), 'MER']} labelFormatter={fmtLabel}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Line type="monotone" dataKey="mer" name="MER" stroke={FLO_ACCENT} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartPanel>
        <ChartPanel title="New vs Returning Orders">
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
        </ChartPanel>
      </div>

      <ChartPanel title="Daily Summary — All Days">
        <VerticalDataTable dates={dates} getRow={(d) => summaryByDate[d]} metrics={OV_METRICS} tableScope="overview" cellStatus={cellStatus} dateField="date" />
      </ChartPanel>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CHANNELS TAB
════════════════════════════════════════════════════════════════════ */
const CH_AGG_HEADERS   = ['Channel','Spend','Revenue','ROAS','NC Orders','CAC'];
const CH_DAILY_HEADERS = ['Date','Channel','Spend','Revenue','ROAS','Purchases','NC Orders','CAC'];

function ChannelsTab({ channels, chAgg, cellStatus }) {
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
      <div className="section">
        <div className="section__title">Channel Breakdown</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:10 }}>
          {chAgg.map(ch => (
            <KpiCard
              key={ch.channel}
              label={ch.channel}
              value={fmt$(ch.revenue)}
              sub={`Spend ${fmt$(ch.spend)} · ${fmtRatio(ch.roas)} ROAS`}
              accent={CHANNEL_COL[ch.channel] || FLO_ACCENT}
            />
          ))}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <ChartPanel title="Spend by Channel">
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
        </ChartPanel>
        <ChartPanel title="ROAS by Channel">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chAgg} margin={{ top:4, right:16, left:0, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="channel" tick={{ fontSize:11 }} stroke="var(--border2)" />
              <YAxis domain={[0,'auto']} tickFormatter={fmtAxisRatio} tick={{ fontSize:11 }} width={50} stroke="var(--border2)" />
              <Tooltip formatter={(v) => [fmtRatio(v), 'ROAS']}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Bar dataKey="roas" radius={[4,4,0,0]}>
                {chAgg.map((e,i) => <Cell key={i} fill={CHANNEL_COL[e.channel]||FLO_ACCENT} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>
      </div>

      <ChartPanel title="Period Totals by Channel">
        <PaginatedSheetTable
          headers={CH_AGG_HEADERS}
          rows={aggRows}
          defaultSortField="Revenue"
          defaultSortDir="desc"
          searchable={false}
          getCellCommentKey={(row, h) => aggCellKey('ch-agg', row, h, 'Channel')}
        />
      </ChartPanel>

      <ChartPanel title="Daily Channel Data — Every Day" subtitle="Each row = one day × one channel">
        <PaginatedSheetTable
          headers={CH_DAILY_HEADERS}
          rows={dailyRows}
          defaultSortField="Date"
          defaultSortDir="desc"
          getCellCommentKey={(row, h) => entityDateCellKey('ch-daily', row, h, 'Channel')}
          getCellCommentLabel={(row, h) => entityDateCellLabel('channel', h, row, 'Channel')}
          cellStatus={cellStatus}
          dateField="Date"
        />
      </ChartPanel>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   REGIONS TAB
════════════════════════════════════════════════════════════════════ */
const GEO_AGG_HEADERS   = ['Region','Revenue','Spend','MER','Rev Share %'];
const GEO_DAILY_HEADERS = ['Date','Region','Revenue','Spend','MER'];

function RegionsTab({ geo, geoAgg, cellStatus }) {
  const totalRev = geoAgg.reduce((s,r) => s + r.revenue, 0);
  const aggRows = geoAgg.map(r => ({
    Region:        r.region,
    Revenue:       r.revenue,
    Spend:         r.spend,
    MER:           r.mer,
    'Rev Share %': totalRev > 0 ? Math.round((r.revenue / totalRev) * 100) : 0,
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
      <div className="section">
        <div className="section__title">Regional Breakdown</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))', gap:10 }}>
          {geoAgg.map((r,i) => (
            <KpiCard
              key={r.region}
              label={r.region}
              value={fmt$(r.revenue)}
              sub={`Spend ${fmt$(r.spend)} · ${fmtRatio(r.mer)} MER${totalRev > 0 ? ` · ${Math.round((r.revenue / totalRev) * 100)}% of rev` : ''}`}
              accent={GEO_COL[i % GEO_COL.length]}
            />
          ))}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <ChartPanel title="Revenue by Region">
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
        </ChartPanel>
        <ChartPanel title="MER by Region">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={geoAgg} layout="vertical" margin={{ top:4, right:16, left:40, bottom:4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" domain={[0,'auto']} tickFormatter={fmtAxisRatio} tick={{ fontSize:10 }} stroke="var(--border2)" />
              <YAxis type="category" dataKey="region" tick={{ fontSize:11 }} stroke="var(--border2)" />
              <Tooltip formatter={(v) => [fmtRatio(v), 'MER']}
                contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
              <Bar dataKey="mer" radius={[0,4,4,0]}>
                {geoAgg.map((_,i) => <Cell key={i} fill={GEO_COL[i%GEO_COL.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>
      </div>

      <ChartPanel title="Period Totals by Region">
        <PaginatedSheetTable
          headers={GEO_AGG_HEADERS}
          rows={aggRows}
          defaultSortField="Revenue"
          defaultSortDir="desc"
          searchable={false}
          getCellCommentKey={(row, h) => aggCellKey('geo-agg', row, h, 'Region')}
        />
      </ChartPanel>

      <ChartPanel title="Daily Regional Data" subtitle="Each row = one day × one region">
        <PaginatedSheetTable
          headers={GEO_DAILY_HEADERS}
          rows={dailyRows}
          defaultSortField="Date"
          defaultSortDir="desc"
          getCellCommentKey={(row, h) => entityDateCellKey('geo-daily', row, h, 'Region')}
          getCellCommentLabel={(row, h) => entityDateCellLabel('region', h, row, 'Region')}
          cellStatus={cellStatus}
          dateField="Date"
        />
      </ChartPanel>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PRODUCTS TAB
════════════════════════════════════════════════════════════════════ */
const PROD_AGG_HEADERS   = ['Product Line','Revenue','Spend','MER','Units Sold','CAC'];
const PROD_DAILY_HEADERS = ['Date','Product Line','Revenue','Spend','MER','Units Sold','Meta','Google','TikTok','Snap','Pinterest','Bing','AppLovin'];

function ProductsTab({ products, prodAgg, cellStatus }) {
  const productAgg = prodAgg.filter(p => CORE_PRODUCT_LINES.includes(p.line));
  const unallocatedAgg = prodAgg.filter(p => !CORE_PRODUCT_LINES.includes(p.line));
  const totalRev = productAgg.reduce((s,r) => s + r.revenue, 0);
  const unallocatedTotal = unallocatedAgg.reduce((s,r) => s + r.spend, 0);
  const capitalize = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

  const aggRows = productAgg.map(r => ({
    'Product Line': capitalize(r.line),
    Revenue:        r.revenue,
    Spend:          r.spend,
    MER:            r.mer,
    'Units Sold':   r.orders,
    CAC:            r.spend > 0 && r.orders > 0 ? parseFloat((r.spend/r.orders).toFixed(2)) : null,
  }));

  const dailyRows = products.map(r => ({
    Date:             r.date,
    'Product Line':   capitalize(r.product_line),
    Revenue:          r.revenue,
    Spend:            r.spend,
    MER:              r.mer,
    'Units Sold':     r.new_cust_orders,
    Meta:             r.meta_spend,
    Google:           r.google_spend,
    TikTok:           r.tiktok_spend,
    Snap:             r.snap_spend,
    Pinterest:        r.pinterest_spend,
    Bing:             r.bing_spend,
    AppLovin:         r.applovin_spend,
  }));

  // Channel spend breakdown per product
  const chBreakdown = productAgg.map(p => ({
    name: capitalize(p.line),
    Meta: p.meta, Google: p.google, TikTok: p.tiktok,
    Snap: p.snap, Pinterest: p.pinterest, Bing: p.bing, AppLovin: p.applovin,
  }));

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Product line cards */}
      <div className="section">
        <div className="section__title">Product Lines</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:12 }}>
          {productAgg.map(p => (
            <div key={p.line} className="card card--pad" style={{ position:'relative', overflow:'hidden', paddingTop:18 }}>
              <div style={{ position:'absolute', top:0, left:0, right:0, height:3, background: PROD_COL[p.line]||FLO_ACCENT }} />
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
                  <div style={{ fontSize:14, fontWeight:800, color: merColor(p.mer) }}>{fmtRatio(p.mer)}</div>
                </div>
                <div>
                  <div style={{ fontSize:10, color:'var(--text3)', marginBottom:1 }}>Units Sold</div>
                  <div style={{ fontSize:14, fontWeight:800 }}>{fmtNum(p.orders)}</div>
                </div>
              </div>
              {totalRev > 0 && (
                <div style={{ marginTop:8, fontSize:11, color:'var(--text3)' }}>
                  {Math.round((p.revenue / totalRev) * 100)}% of total rev
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {unallocatedAgg.length > 0 && (
        <div className="section">
          <div className="section__head">
            <div className="section__title">Mixed / Unclassified Ad Spend</div>
            <span style={{ fontSize:16, fontWeight:800 }}>{fmt$(unallocatedTotal)}</span>
          </div>
          <div style={{ fontSize:11, color:'var(--text3)' }}>
            Kept separate from product MER so Portable/Wooden/Metal are not artificially inflated.
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:10 }}>
            {unallocatedAgg.map(p => (
              <KpiCard
                key={p.line}
                label={p.line}
                value={fmt$(p.spend)}
                accent={PROD_COL[p.line] || '#94a3b8'}
              />
            ))}
          </div>
        </div>
      )}

      {/* Revenue pie + Channel spend stacked bar */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <ChartPanel title="Revenue Split by Product">
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
        </ChartPanel>
        <ChartPanel title="Channel Spend by Product">
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
        </ChartPanel>
      </div>

      {/* Aggregated product table */}
      <ChartPanel title="Period Totals by Product Line">
        <PaginatedSheetTable
          headers={PROD_AGG_HEADERS}
          rows={aggRows}
          defaultSortField="Revenue"
          defaultSortDir="desc"
          searchable={false}
          getCellCommentKey={(row, h) => aggCellKey('prod-agg', row, h, 'Product')}
        />
      </ChartPanel>

      {/* Daily product table */}
      <ChartPanel title="Daily Product Data — Every Day" subtitle="Each row = one day × one product line, with channel spend breakdown">
        <PaginatedSheetTable
          headers={PROD_DAILY_HEADERS}
          rows={dailyRows}
          defaultSortField="Date"
          defaultSortDir="desc"
          getCellCommentKey={(row, h) => entityDateCellKey('prod-daily', row, h, 'Product')}
          getCellCommentLabel={(row, h) => entityDateCellLabel('product', h, row, 'Product')}
          cellStatus={cellStatus}
          dateField="Date"
        />
      </ChartPanel>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SUBSCRIPTIONS TAB
════════════════════════════════════════════════════════════════════ */
const SUB_HEADERS = ['Date','New Subs','New Sub Rev','Rebill Rev','Total Sub Rev'];

function SubscriptionsTab({ subDaily, subStats, subTotals, cellStatus }) {
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
      <div className="section">
        <div className="section__title">In Date Range</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:12 }}>
          <KpiCard label="Subscription sales" sub="in date range" value={fmt$(subTotals.total)} tooltip={TIP.totalSubRevenue} color="teal"   />
          <KpiCard label={L.newSubs}           sub="in date range" value={fmtNum(subTotals.newSubCount)} tooltip={TIP.newSubs} color="teal"   />
          <KpiCard label={L.newSubRevenue}    sub="in date range" value={fmt$(subTotals.newSubRev)} tooltip={TIP.newSubRevenue} color="teal"   />
          <KpiCard label={L.rebillRevenue}     sub="in date range" value={fmt$(subTotals.rebill)} tooltip={TIP.rebillRevenue} color="blue"   />
        </div>
      </div>
      {/* All-time subscriber snapshot */}
      <div className="section">
        <div className="section__title">Subscriber Snapshot</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:12 }}>
          <KpiCard label={L.activeSubs}        sub="right now" value={fmtNum(subStats.active    || 0)} tooltip={TIP.activeSubs} color="teal"   />
          <KpiCard label={L.converted}          sub="right now" value={fmtNum(subStats.converted || 0)} tooltip={TIP.converted} color="blue"   />
          <KpiCard label={L.cancelled}          sub="right now" value={fmtNum(subStats.cancelled || 0)} tooltip={TIP.cancelled} color="warn"   />
          <KpiCard label={L.avgContract} sub="right now" value={fmt$(subStats.avg_order_amount || 0)} tooltip={TIP.avgContract} color="purple" />
        </div>
      </div>

      {/* Trend chart */}
      <ChartPanel title="Subscription Revenue — Daily">
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
            <defs>
              <linearGradient id="fGradSub" x1="0" y1="0" x2="0" y2="1">
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
            <Area type="monotone" dataKey="sub_revenue_actual" name="Total Sub Rev" stroke={FLO_ACCENT} fill="url(#fGradSub)" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="rebill_revenue"     name="Rebill"        stroke="#6366f1"   fill="none" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
            <Area type="monotone" dataKey="new_sub_revenue"    name="New Subs"      stroke={FLO_WARN}  fill="none" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartPanel>

      {/* Stacked breakdown */}
      <ChartPanel title="Rebill vs New Subscribers">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tickFormatter={fmtLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
            <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
            <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtLabel}
              contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            <Legend wrapperStyle={{ fontSize:12 }} />
            <Bar dataKey="rebill_revenue"  name="Rebill"  fill="#6366f1"   stackId="rev" />
            <Bar dataKey="new_sub_revenue" name="New Sub" fill={FLO_ACCENT} stackId="rev" />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>

      {/* Daily table */}
      <ChartPanel title="Daily Subscription Detail">
        <PaginatedSheetTable
          headers={SUB_HEADERS}
          rows={rows}
          defaultSortField="Date"
          defaultSortDir="desc"
          getCellCommentKey={(row, h) => dailyCellKey('subs', row, h, 'Date')}
          getCellCommentLabel={(row, h) => dailyCellLabel(h, row, 'Date')}
          cellStatus={cellStatus}
          dateField="Date"
        />
      </ChartPanel>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   EMAIL TAB
════════════════════════════════════════════════════════════════════ */
const EMAIL_HEADERS = ['Date','Sent','Opened','Clicked','Open Rate','Click Rate','Revenue'];

function EmailTab({ email, emailTotals, cellStatus }) {
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
      <div className="section">
        <div className="section__title">Email Performance</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:12 }}>
          <KpiCard label={L.emailSent}   value={fmtNum(emailTotals.sent)}    color="blue"   />
          <KpiCard label={L.emailOpened}        value={fmtNum(emailTotals.opened)}  color="teal"   />
          <KpiCard label={L.emailClicked}       value={fmtNum(emailTotals.clicked)} color="nobl"   />
          <KpiCard label={L.openRate} value={fmtPct(avgOpenRate)}         color="green"  />
          <KpiCard label={L.clickRate}value={fmtPct(avgClickRate)}        color="purple" />
          <KpiCard label={L.emailRevenue} value={fmt$(emailTotals.revenue)} tooltip={TIP.emailRevenue} color="teal"   />
        </div>
      </div>

      <ChartPanel title="Email Revenue — Daily">
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
      </ChartPanel>

      <ChartPanel title="Daily Email Stats">
        <PaginatedSheetTable
          headers={EMAIL_HEADERS}
          rows={rows}
          defaultSortField="Date"
          defaultSortDir="desc"
          getCellCommentKey={(row, h) => dailyCellKey('email', row, h, 'Date')}
          getCellCommentLabel={(row, h) => dailyCellLabel(h, row, 'Date')}
          cellStatus={cellStatus}
          dateField="Date"
        />
      </ChartPanel>
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
      <button onClick={onRetry} className="btn btn--primary">Retry</button>
    </div>
  );
}
