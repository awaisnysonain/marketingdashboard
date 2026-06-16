import React, { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getNoblTopline, fmt$, fmtRatio } from '../utils/api';
import KpiCard from '../components/KpiCard';
import DateRangePicker from '../components/DateRangePicker';
import PaginatedSheetTable from '../components/PaginatedSheetTable';
import PageIntro from '../components/PageIntro';
import { CommentProvider } from '../components/CommentProvider';
import { commentTargetKey } from '../utils/commentKeys';
import { aggCellKey, dailyCellKey, dailyCellLabel } from '../utils/sheetComments';
import { L, TIP } from '../copy/plainLanguage';

function toISO(d) { return d.toISOString().slice(0, 10); }
function startOfMonthISO() { const d = new Date(); d.setDate(1); return toISO(d); }
function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo)-1]} ${parseInt(dy)}`;
}

const CHANNEL_COLORS = {
  META: '#1877f2', GOOGLE: '#ea4335', TIKTOK: '#010101',
  SNAPCHAT: '#fffc00', PINTEREST: '#e60023', APPLOVIN: '#ff8c00',
  BING: '#00809d', X: '#000000',
};

const GEO_COLORS = ['#6366f1','#14b8a6','#f59e0b','#ef4444','#8b5cf6','#06b6d4'];

const TABS = ['Topline', 'Channels', 'Geography', 'Subscriptions'];

function SortTh({ label, field, sortBy, sortDir, onSort }) {
  return (
    <th onClick={() => onSort(field)} style={{ cursor: 'pointer', padding: '8px 12px', textAlign: 'right',
      fontSize: 11, fontWeight: 600, color: sortBy === field ? 'var(--accent)' : 'var(--text3)', whiteSpace: 'nowrap', userSelect: 'none' }}>
      {label} {sortBy === field ? (sortDir === 'asc' ? '▲' : '▼') : ''}
    </th>
  );
}

function useSortedRows(rows, defaultField = 'date', defaultDir = 'desc') {
  const [sortBy, setSortBy] = useState(defaultField);
  const [sortDir, setSortDir] = useState(defaultDir);
  function handleSort(field) {
    if (sortBy === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortDir('desc'); }
  }
  const sorted = [...rows].sort((a, b) => {
    const va = a[sortBy]; const vb = b[sortBy];
    if (va == null) return 1; if (vb == null) return -1;
    if (typeof va === 'string') return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    return sortDir === 'asc' ? va - vb : vb - va;
  });
  return { sorted, sortBy, sortDir, handleSort };
}

export default function NoblPage({ showToast }) {
  const [range, setRange] = useState({ start: startOfMonthISO(), end: toISO(new Date()) });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('Topline');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getNoblTopline(range.start, range.end)); }
    catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const summary = data?.summary || [];
  const channels = data?.channels || [];
  const geo = data?.geo || [];
  const subs = data?.subs || [];

  // Aggregate KPIs from summary
  const totals = summary.reduce((acc, r) => ({
    revenue: (acc.revenue || 0) + (r.total_revenue || 0),
    spend: (acc.spend || 0) + (r.total_spend || 0),
  }), {});
  const totalSubRev = subs.reduce((s, r) => s + (r.sub_revenue_actual || 0), 0);
  const avgMer = totals.spend > 0 ? (totals.revenue / totals.spend) : 0;

  // Best channel by revenue
  const channelAgg = {};
  for (const r of channels) {
    if (!channelAgg[r.channel]) channelAgg[r.channel] = { revenue: 0, spend: 0, roas: [], orders: 0 };
    channelAgg[r.channel].revenue += r.revenue_1d || 0;
    channelAgg[r.channel].spend += r.spend_1d || 0;
    if (r.roas_1d) channelAgg[r.channel].roas.push(r.roas_1d);
    channelAgg[r.channel].orders += r.new_cust_orders || 0;
  }
  const channelList = Object.entries(channelAgg)
    .map(([ch, v]) => ({ channel: ch, ...v, avg_roas: v.roas.length ? v.roas.reduce((a,b)=>a+b,0)/v.roas.length : 0 }))
    .sort((a,b) => b.revenue - a.revenue);
  const topChannelByRev = channelList[0]?.channel || '—';
  const bestROASChannel = [...channelList].sort((a,b) => b.avg_roas - a.avg_roas)[0]?.channel || '—';

  // Geo aggregated
  const geoAgg = {};
  for (const r of geo) {
    if (!geoAgg[r.region]) geoAgg[r.region] = { revenue: 0, spend: 0 };
    geoAgg[r.region].revenue += r.revenue_actual || 0;
    geoAgg[r.region].spend += r.spend_actual || 0;
  }
  const geoList = Object.entries(geoAgg)
    .filter(([r]) => r !== 'TOTAL')
    .map(([region, v]) => ({ region, ...v }))
    .sort((a,b) => b.revenue - a.revenue);

  // Sub summary stats
  const subStats = {
    total_rev: totalSubRev,
    rebill: subs.reduce((s,r) => s + (r.rebill_revenue || 0), 0),
    new_sub: subs.reduce((s,r) => s + (r.new_sub_revenue || 0), 0),
  };

  return (
    <CommentProvider pageKey="app-nobl">
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <PageIntro title="NOBL Air" desc="Sales, ad spend, channels, regions, and subscriptions for the NOBL Air brand." accent="#6366f1" />
        <DateRangePicker start={range.start} end={range.end} onChange={setRange} scope="nobl" />
      </div>

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          {/* KPI Row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label={`Total ${L.sales}`} value={fmt$(totals.revenue)} fullValue={fmt$(totals.revenue)} tooltip={TIP.revenue} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_revenue'), targetLabel: `Total ${L.sales}` }} />
            <KpiCard label={`Total ${L.spend}`} value={fmt$(totals.spend)} fullValue={fmt$(totals.spend)} tooltip={TIP.spend} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_spend'), targetLabel: `Total ${L.spend}` }} />
            <KpiCard label={L.mer} value={fmtRatio(avgMer)} copyValue={avgMer.toFixed(4)} tooltip={TIP.mer} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('mer'), targetLabel: L.mer }} />
            <KpiCard label={L.subRevenue} value={fmt$(totalSubRev)} fullValue={fmt$(totalSubRev)} tooltip={TIP.subRevenue} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('sub_revenue'), targetLabel: L.subRevenue }} />
            <KpiCard label="Top channel" value={topChannelByRev} copyValue={topChannelByRev} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('top_channel'), targetLabel: 'Top Channel' }} />
            <KpiCard label={`Best ${L.roas} channel`} value={bestROASChannel} copyValue={bestROASChannel} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('best_roas_channel'), targetLabel: `Best ${L.roas} Channel` }} />
          </div>

          {/* Inner Tabs */}
          <div style={{ display: 'flex', gap: 2, marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
            {TABS.map(t => (
              <button key={t} onClick={() => setActiveTab(t)} style={{
                padding: '8px 16px', fontSize: 13, fontWeight: 600,
                border: 'none', background: 'none', cursor: 'pointer',
                color: activeTab === t ? 'var(--accent)' : 'var(--text3)',
                borderBottom: activeTab === t ? '2px solid var(--accent)' : '2px solid transparent',
                transition: 'color .15s',
              }}>{t}</button>
            ))}
          </div>

          {activeTab === 'Topline' && <ToplineTab summary={summary} />}
          {activeTab === 'Channels' && <ChannelsTab channels={channels} channelList={channelList} />}
          {activeTab === 'Geography' && <GeoTab geoList={geoList} geo={geo} />}
          {activeTab === 'Subscriptions' && <SubsTab subs={subs} subStats={subStats} />}
        </>
      )}
    </div>
    </CommentProvider>
  );
}

const NOBL_TOPLINE_HEADERS = [L.date, L.sales, L.spend, L.mer, L.orders, L.ncOrders, 'Repeat customer orders'];
function ToplineTab({ summary }) {
  const sheetRows = summary.map(r => ({
    [L.date]:      r.date,
    [L.sales]:   r.total_revenue,
    [L.spend]:     r.total_spend,
    [L.mer]:       r.total_spend > 0 ? parseFloat((r.total_revenue / r.total_spend).toFixed(4)) : null,
    [L.orders]:    r.total_orders,
    [L.ncOrders]: r.new_customer_orders,
    'Repeat customer orders': r.returning_customer_orders,
    _date: r.date,
  }));
  return (
    <div>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20, marginBottom:20 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>{L.sales} & {L.spend.toLowerCase()} over time</div>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={summary} margin={{ top:4, right:16, left:0, bottom:4 }}>
            <defs>
              <linearGradient id="gradRev" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
            <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={70} stroke="var(--border2)" />
            <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtDateLabel} contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            <Legend wrapperStyle={{ fontSize:12 }} />
            <Area type="monotone" dataKey="total_revenue" name={L.sales} stroke="#6366f1" fill="url(#gradRev)" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="total_spend" name={L.spend} stroke="#f59e0b" fill="none" strokeWidth={2} strokeDasharray="4 2" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Daily Summary</div>
        <PaginatedSheetTable
          headers={NOBL_TOPLINE_HEADERS}
          rows={sheetRows}
          defaultSortField={L.date}
          defaultSortDir="desc"
          getCellCommentKey={(row, h) => dailyCellKey('topline', row, h)}
          getCellCommentLabel={(row, h) => dailyCellLabel(h, row)}
        />
      </div>
    </div>
  );
}

const NOBL_CH_HEADERS = ['Channel', L.spend, L.sales, `Avg ${L.roas}`, L.ncOrders];
function ChannelsTab({ channels, channelList }) {
  const chRows = channelList.map(r => ({
    'Channel':   r.channel,
    [L.spend]:     r.spend,
    [L.sales]:   r.revenue,
    [`Avg ${L.roas}`]:  r.avg_roas,
    [L.ncOrders]: r.orders,
  }));
  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>{L.spend} by channel</div>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={channelList} margin={{ top:4, right:16, left:0, bottom:4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="channel" tick={{ fontSize:11 }} stroke="var(--border2)" />
            <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={70} stroke="var(--border2)" />
            <Tooltip formatter={(v,n) => [fmt$(v),n]} contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            <Bar dataKey="spend" name={L.spend} fill="#6366f1" radius={[3,3,0,0]}>
              {channelList.map((entry, i) => <Cell key={i} fill={CHANNEL_COLORS[entry.channel] || '#6366f1'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Channel Performance</div>
        <PaginatedSheetTable
          headers={NOBL_CH_HEADERS}
          rows={chRows}
          defaultSortField={L.sales}
          defaultSortDir="desc"
          searchable={false}
          getCellCommentKey={(row, h) => aggCellKey('channel', row, h, 'Channel')}
        />
      </div>
    </div>
  );
}

const NOBL_GEO_HEADERS = ['Region', L.sales, L.spend, L.mer];
function GeoTab({ geoList, geo }) {
  const geoSheetRows = geoList.map(r => ({
    'Region':  r.region,
    [L.sales]: r.revenue,
    [L.spend]:   r.spend,
    [L.mer]:     r.spend > 0 ? parseFloat((r.revenue / r.spend).toFixed(4)) : null,
  }));
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>{L.sales} by region</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={geoList} dataKey="revenue" nameKey="region" cx="50%" cy="50%" outerRadius={80} label={({ region, percent }) => `${region} ${(percent*100).toFixed(0)}%`} labelLine={false}>
                {geoList.map((entry, i) => <Cell key={i} fill={GEO_COLORS[i % GEO_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => fmt$(v)} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>{L.spend} by region</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={geoList} layout="vertical" margin={{ top: 4, right: 16, left: 40, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" tickFormatter={v => fmt$(v)} tick={{ fontSize: 11 }} stroke="var(--border2)" />
              <YAxis type="category" dataKey="region" tick={{ fontSize: 11 }} stroke="var(--border2)" />
              <Tooltip formatter={(v) => fmt$(v)} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="spend" name={L.spend} fill="#6366f1" radius={[0,3,3,0]}>
                {geoList.map((entry, i) => <Cell key={i} fill={GEO_COLORS[i % GEO_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Geographic Breakdown</div>
        <PaginatedSheetTable
          headers={NOBL_GEO_HEADERS}
          rows={geoSheetRows}
          defaultSortField={L.sales}
          defaultSortDir="desc"
          searchable={false}
          getCellCommentKey={(row, h) => aggCellKey('geo', row, h, 'Region')}
        />
      </div>
    </div>
  );
}

const NOBL_SUBS_HEADERS = [L.date, 'Total subscription sales', L.rebillRevenue, L.newSubRevenue, 'Gross', 'Discount', 'Refunds'];
function SubsTab({ subs, subStats }) {
  const subSheetRows = subs.map(r => ({
    [L.date]:        r.date,
    'Total subscription sales': r.sub_revenue_actual,
    [L.rebillRevenue]:  r.rebill_revenue,
    [L.newSubRevenue]: r.new_sub_revenue,
    'Gross':       r.shopify_sub_gross,
    'Discount':    r.shopify_sub_disc,
    'Refunds':     r.shopify_sub_refunds,
    _date: r.date,
  }));
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Total subscription sales" value={fmt$(subStats.total_rev)} tooltip={TIP.totalSubRevenue} color="purple" />
        <KpiCard label={L.rebillRevenue} value={fmt$(subStats.rebill)} tooltip={TIP.rebillRevenue} color="nobl" />
        <KpiCard label={L.newSubRevenue} value={fmt$(subStats.new_sub)} tooltip={TIP.newSubRevenue} color="teal" />
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Subscription sales over time</div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={subs} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
              <defs>
                <linearGradient id="gradSub" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
              <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
              <Tooltip formatter={(v,n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="sub_revenue_actual" name="Total subscription sales" stroke="#8b5cf6" fill="url(#gradSub)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="rebill_revenue" name="Renewals" stroke="#6366f1" fill="none" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
              <Area type="monotone" dataKey="new_sub_revenue" name="New Subs" stroke="#14b8a6" fill="none" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Daily Subscription Detail</div>
          <PaginatedSheetTable
            headers={NOBL_SUBS_HEADERS}
            rows={subSheetRows}
            defaultSortField={L.date}
            defaultSortDir="desc"
            getCellCommentKey={(row, h) => dailyCellKey('subs', row, h, L.date)}
            getCellCommentLabel={(row, h) => dailyCellLabel(h, row, L.date)}
          />
        </div>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[...Array(6)].map((_, i) => <div key={i} style={{ height: 80, background: 'var(--bg3)', borderRadius: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />)}
      </div>
      <div style={{ height: 260, background: 'var(--bg2)', borderRadius: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />
    </div>
  );
}

function ErrorMsg({ msg, onRetry }) {
  return (
    <div style={{ padding: '40px 0', textAlign: 'center' }}>
      <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 14 }}>Failed to load: {msg}</div>
      <button onClick={onRetry} style={{ padding: '8px 20px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>Retry</button>
    </div>
  );
}
