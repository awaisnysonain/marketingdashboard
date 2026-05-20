import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import { getChannels, fmt$ } from '../utils/api';
import KpiCard from '../components/KpiCard';
import DateRangePicker from '../components/DateRangePicker';
import PaginatedSheetTable from '../components/PaginatedSheetTable';
import PageIntro from '../components/PageIntro';
import { L, TIP, PAGE } from '../copy/plainLanguage';

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

const BRANDS = ['Both', 'NOBL', 'FLO'];

function SortTh({ label, field, sortBy, sortDir, onSort }) {
  return (
    <th onClick={() => onSort(field)} style={{ cursor: 'pointer', padding: '8px 12px', textAlign: 'right',
      fontSize: 11, fontWeight: 600, color: sortBy === field ? 'var(--accent)' : 'var(--text3)', whiteSpace: 'nowrap', userSelect: 'none' }}>
      {label} {sortBy === field ? (sortDir === 'asc' ? '▲' : '▼') : ''}
    </th>
  );
}

export default function ChannelsPage({ showToast }) {
  const [range, setRange] = useState({ start: startOfMonthISO(), end: toISO(new Date()) });
  const [brandFilter, setBrandFilter] = useState('Both');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const brand = brandFilter === 'Both' ? '' : brandFilter;
      const data = await getChannels(range.start, range.end, brand);
      setRows(data.rows || []);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, [range, brandFilter]);

  useEffect(() => { load(); }, [load]);

  function handleSort(field) {
    if (sortBy === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortDir('desc'); }
  }

  // Aggregate KPIs by channel
  const channelAgg = {};
  for (const r of rows) {
    const ch = r.channel;
    if (!channelAgg[ch]) channelAgg[ch] = { spend: 0, revenue: 0, roas_vals: [], orders: 0 };
    channelAgg[ch].spend += r.spend_1d || 0;
    channelAgg[ch].revenue += r.revenue_1d || 0;
    if (r.roas_1d) channelAgg[ch].roas_vals.push(r.roas_1d);
    channelAgg[ch].orders += r.new_cust_orders || 0;
  }
  const channelKpis = Object.entries(channelAgg).map(([ch, v]) => ({
    channel: ch,
    total_spend: v.spend,
    total_revenue: v.revenue,
    avg_roas: v.roas_vals.length ? v.roas_vals.reduce((a,b)=>a+b,0)/v.roas_vals.length : 0,
    total_orders: v.orders,
  })).sort((a,b) => b.total_spend - a.total_spend);

  // Spend stacked bar: group by date, series by channel
  const dateMap = {};
  for (const r of rows) {
    if (!dateMap[r.date]) dateMap[r.date] = { date: r.date };
    dateMap[r.date][r.channel] = (dateMap[r.date][r.channel] || 0) + (r.spend_1d || 0);
  }
  const chartData = Object.values(dateMap).sort((a,b) => String(a.date).localeCompare(String(b.date)));
  const channels = [...new Set(rows.map(r => r.channel))];

  // Filter + sort table
  const filtered = rows.filter(r => {
    if (!search) return true;
    return String(r.channel).toLowerCase().includes(search.toLowerCase()) ||
           String(r.brand || '').toLowerCase().includes(search.toLowerCase()) ||
           String(r.date).includes(search);
  });
  const sorted = [...filtered].sort((a, b) => {
    const va = a[sortBy]; const vb = b[sortBy];
    if (va == null) return 1; if (vb == null) return -1;
    if (typeof va === 'string') return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    return sortDir === 'asc' ? va - vb : vb - va;
  });

  const totSpend = channelKpis.reduce((s,r) => s + r.total_spend, 0);
  const totRev = channelKpis.reduce((s,r) => s + r.total_revenue, 0);

  // Prepare rows for SheetTable
  const CH_HEADERS = [L.date, 'Brand', 'Channel', L.spend, L.revenue, L.roas, 'Ad spend (7 days)', L.newOrders, L.cac];
  const sheetRows = sorted.map(r => ({
    [L.date]:       r.date,
    'Brand':      r.brand,
    'Channel':    r.channel,
    [L.spend]:      r.spend_1d,
    [L.revenue]:    r.revenue_1d,
    [L.roas]:       r.roas_1d,
    'Ad spend (7 days)':   r.spend_7d,
    [L.newOrders]: r.new_cust_orders,
    [L.cac]:        r.cac,
  }));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <PageIntro title={PAGE.channels.title} desc={PAGE.channels.desc} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {BRANDS.map(b => (
              <button key={b} onClick={() => setBrandFilter(b)} style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 600,
                borderRadius: 6, border: '1px solid var(--border)',
                background: brandFilter === b ? 'var(--accent)' : 'var(--bg2)',
                color: brandFilter === b ? '#fff' : 'var(--text2)',
                cursor: 'pointer',
              }}>{b}</button>
            ))}
          </div>
          <DateRangePicker start={range.start} end={range.end} onChange={setRange} scope="channels" />
        </div>
      </div>

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          {/* KPI cards by channel */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
            {channelKpis.slice(0, 6).map(ch => (
              <div key={ch.channel} style={{
                background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px',
                position: 'relative', overflow: 'hidden',
              }}>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: CHANNEL_COLORS[ch.channel] || '#888', borderRadius: '2px 2px 0 0' }} />
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>{ch.channel}</div>
                <div style={{ fontSize: 17, fontWeight: 700 }}>{fmt$(ch.total_spend)}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>Sales: {fmt$(ch.total_revenue)} &middot; Return: {ch.avg_roas.toFixed(2)}x per ad $</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Total ad spend" value={fmt$(totSpend)} tooltip={TIP.spend} color="warn" />
            <KpiCard label="Total sales" value={fmt$(totRev)} tooltip={TIP.revenue} color="blue" />
            <KpiCard label={L.blendedMer} value={totSpend > 0 ? (totRev/totSpend).toFixed(2)+'x' : '—'} tooltip={TIP.mer} color="green" />
          </div>

          {/* Stacked spend chart */}
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Ad spend by channel over time</div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
                <Tooltip formatter={(v,n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {channels.map(ch => (
                  <Bar key={ch} dataKey={ch} name={ch} stackId="spend" fill={CHANNEL_COLORS[ch] || '#888'} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Channel Detail Table */}
          <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>
              Channel Detail
              <span style={{ fontSize:11, fontWeight:400, color:'var(--text3)', marginLeft:8 }}>
                — click cells · shift+click range · ctrl+C copy
              </span>
            </div>
            <PaginatedSheetTable
              headers={CH_HEADERS}
              rows={sheetRows}
              resetDeps={[range.start, range.end]}
              defaultSortField={L.date}
              defaultSortDir="desc"
              searchable={true}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[...Array(6)].map((_, i) => <div key={i} style={{ height: 80, background: 'var(--bg3)', borderRadius: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />)}
      </div>
      <div style={{ height: 280, background: 'var(--bg2)', borderRadius: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />
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
