import React, { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getNoblTopline, fmt$ } from '../utils/api';
import KpiCard from '../components/KpiCard';
import DateRangePicker from '../components/DateRangePicker';
import SheetTable from '../components/SheetTable';

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
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, fontFamily: 'var(--font-head)', color: '#6366f1' }}>NOBL Air</h1>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: '4px 0 0' }}>Analytics dashboard for NOBL Air brand</p>
        </div>
        <DateRangePicker start={range.start} end={range.end} onChange={setRange} scope="nobl" />
      </div>

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          {/* KPI Row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Total Revenue" value={fmt$(totals.revenue)} color="nobl" />
            <KpiCard label="Total Spend" value={fmt$(totals.spend)} color="warn" />
            <KpiCard label="MER" value={avgMer.toFixed(2) + 'x'} color="green" />
            <KpiCard label="Sub Revenue" value={fmt$(totalSubRev)} color="purple" />
            <KpiCard label="Top Channel" value={topChannelByRev} color="blue" />
            <KpiCard label="Best ROAS Channel" value={bestROASChannel} color="teal" />
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
  );
}

const NOBL_TOPLINE_HEADERS = ['Date','Revenue','Spend','MER','Orders','NC Orders','RC Orders'];
function ToplineTab({ summary }) {
  const sheetRows = summary.map(r => ({
    'Date':      r.date,
    'Revenue':   r.total_revenue,
    'Spend':     r.total_spend,
    'MER':       r.total_spend > 0 ? parseFloat((r.total_revenue / r.total_spend).toFixed(4)) : null,
    'Orders':    r.total_orders,
    'NC Orders': r.new_customer_orders,
    'RC Orders': r.returning_customer_orders,
  }));
  return (
    <div>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20, marginBottom:20 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>Revenue & Spend Over Time</div>
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
            <Area type="monotone" dataKey="total_revenue" name="Revenue" stroke="#6366f1" fill="url(#gradRev)" strokeWidth={2} dot={false} />
            <Area type="monotone" dataKey="total_spend" name="Spend" stroke="#f59e0b" fill="none" strokeWidth={2} strokeDasharray="4 2" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Daily Summary</div>
        <SheetTable headers={NOBL_TOPLINE_HEADERS} rows={sheetRows} maxHeight="460px" defaultSortField="Date" defaultSortDir="desc" />
      </div>
    </div>
  );
}

const NOBL_CH_HEADERS = ['Channel','Spend','Revenue','Avg ROAS','NC Orders'];
function ChannelsTab({ channels, channelList }) {
  const chRows = channelList.map(r => ({
    'Channel':   r.channel,
    'Spend':     r.spend,
    'Revenue':   r.revenue,
    'Avg ROAS':  r.avg_roas,
    'NC Orders': r.orders,
  }));
  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>Spend by Channel</div>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={channelList} margin={{ top:4, right:16, left:0, bottom:4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="channel" tick={{ fontSize:11 }} stroke="var(--border2)" />
            <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={70} stroke="var(--border2)" />
            <Tooltip formatter={(v,n) => [fmt$(v),n]} contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
            <Bar dataKey="spend" name="Spend" fill="#6366f1" radius={[3,3,0,0]}>
              {channelList.map((entry, i) => <Cell key={i} fill={CHANNEL_COLORS[entry.channel] || '#6366f1'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Channel Performance</div>
        <SheetTable headers={NOBL_CH_HEADERS} rows={chRows} maxHeight="340px" defaultSortField="Revenue" defaultSortDir="desc" searchable={false} />
      </div>
    </div>
  );
}

const NOBL_GEO_HEADERS = ['Region', 'Revenue', 'Spend', 'MER'];
function GeoTab({ geoList, geo }) {
  const geoSheetRows = geoList.map(r => ({
    'Region':  r.region,
    'Revenue': r.revenue,
    'Spend':   r.spend,
    'MER':     r.spend > 0 ? parseFloat((r.revenue / r.spend).toFixed(4)) : null,
  }));
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Revenue by Region</div>
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
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Spend by Region</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={geoList} layout="vertical" margin={{ top: 4, right: 16, left: 40, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" tickFormatter={v => fmt$(v)} tick={{ fontSize: 11 }} stroke="var(--border2)" />
              <YAxis type="category" dataKey="region" tick={{ fontSize: 11 }} stroke="var(--border2)" />
              <Tooltip formatter={(v) => fmt$(v)} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="spend" name="Spend" fill="#6366f1" radius={[0,3,3,0]}>
                {geoList.map((entry, i) => <Cell key={i} fill={GEO_COLORS[i % GEO_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Geographic Breakdown</div>
        <SheetTable
          headers={NOBL_GEO_HEADERS}
          rows={geoSheetRows}
          maxHeight="400px"
          defaultSortField="Revenue"
          defaultSortDir="desc"
          searchable={false}
        />
      </div>
    </div>
  );
}

const NOBL_SUBS_HEADERS = ['Date', 'Total Sub Rev', 'Rebill Rev', 'New Sub Rev', 'Gross', 'Discount', 'Refunds'];
function SubsTab({ subs, subStats }) {
  const subSheetRows = subs.map(r => ({
    'Date':        r.date,
    'Total Sub Rev': r.sub_revenue_actual,
    'Rebill Rev':  r.rebill_revenue,
    'New Sub Rev': r.new_sub_revenue,
    'Gross':       r.shopify_sub_gross,
    'Discount':    r.shopify_sub_disc,
    'Refunds':     r.shopify_sub_refunds,
  }));
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Total Sub Revenue" value={fmt$(subStats.total_rev)} color="purple" />
        <KpiCard label="Rebill Revenue" value={fmt$(subStats.rebill)} color="nobl" />
        <KpiCard label="New Sub Revenue" value={fmt$(subStats.new_sub)} color="teal" />
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Subscription Revenue Over Time</div>
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
              <Area type="monotone" dataKey="sub_revenue_actual" name="Total Sub Revenue" stroke="#8b5cf6" fill="url(#gradSub)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="rebill_revenue" name="Rebill" stroke="#6366f1" fill="none" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
              <Area type="monotone" dataKey="new_sub_revenue" name="New Subs" stroke="#14b8a6" fill="none" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Daily Subscription Detail</div>
          <SheetTable
            headers={NOBL_SUBS_HEADERS}
            rows={subSheetRows}
            maxHeight="300px"
            defaultSortField="Date"
            defaultSortDir="desc"
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
