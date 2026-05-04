import React, { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getSubscriptions, fmt$ } from '../utils/api';
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

const STATUS_COLORS = { active: 'var(--success)', cancelled: 'var(--danger)', trialing: 'var(--warn)', converted: '#6366f1' };

const DAILY_HEADERS = [
  'Date', 'Sub Gross', 'Sub Discounts', 'Sub Refunds', 'New Sub Revenue', 'Rebill Revenue', 'Total Sub Revenue',
];

function toDailyRow(r) {
  return {
    'Date': r.date,
    'Sub Gross': r.shopify_sub_gross,
    'Sub Discounts': r.shopify_sub_disc,
    'Sub Refunds': r.shopify_sub_refunds,
    'New Sub Revenue': r.new_sub_revenue,
    'Rebill Revenue': r.rebill_revenue,
    'Total Sub Revenue': r.sub_revenue_actual,
    _date: r.date,
  };
}

function SortTh({ label, field, sortBy, sortDir, onSort }) {
  return (
    <th onClick={() => onSort(field)} style={{ cursor: 'pointer', padding: '8px 12px', textAlign: 'right',
      fontSize: 11, fontWeight: 600, color: sortBy === field ? 'var(--accent)' : 'var(--text3)', whiteSpace: 'nowrap', userSelect: 'none' }}>
      {label} {sortBy === field ? (sortDir === 'asc' ? '▲' : '▼') : ''}
    </th>
  );
}

export default function SubsPage({ showToast }) {
  const [range, setRange] = useState({ start: startOfMonthISO(), end: toISO(new Date()) });
  const [brand, setBrand] = useState('NOBL');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('activated_on');
  const [sortDir, setSortDir] = useState('desc');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getSubscriptions(range.start, range.end, brand)); }
    catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, [range, brand]);

  useEffect(() => { load(); }, [load]);

  function handleSort(field) {
    if (sortBy === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortDir('desc'); }
  }

  const daily = data?.daily || [];
  const summary = data?.summary || {};
  const dailyRows = daily.map(toDailyRow);

  const rebillTotal = daily.reduce((s,r) => s + (r.rebill_revenue || 0), 0);
  const newSubTotal = daily.reduce((s,r) => s + (r.new_sub_revenue || 0), 0);
  const totalSubRev = daily.reduce((s,r) => s + (r.sub_revenue_actual || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, fontFamily: 'var(--font-head)', color: '#8b5cf6' }}>Subscriptions</h1>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: '4px 0 0' }}>{brand === 'FLO' ? 'FLO subscription program deep dive' : 'NOBL Air subscription program deep dive'}</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          <div style={{ display:'inline-flex', background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:10, padding:3 }}>
            {['NOBL','FLO'].map(b => (
              <button key={b} onClick={() => setBrand(b)} style={{ padding:'7px 14px', border:'none', borderRadius:8, cursor:'pointer', fontWeight:700, background:brand === b ? 'var(--accent)' : 'transparent', color:brand === b ? '#fff' : 'var(--text2)' }}>{b}</button>
            ))}
          </div>
          <DateRangePicker start={range.start} end={range.end} onChange={setRange} scope="subs" />
        </div>
      </div>

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          {/* KPI cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
            <KpiCard label="Active Subscribers" value={(summary.active || 0).toLocaleString()} color="green" />
            <KpiCard label="Trialing" value={(summary.trialing || 0).toLocaleString()} color="warn" />
            <KpiCard label="Converted" value={(summary.converted || 0).toLocaleString()} color="nobl" />
            <KpiCard label="Cancelled" value={(summary.cancelled || 0).toLocaleString()} color="danger" />
            <KpiCard label="Total Sub Revenue" value={fmt$(totalSubRev)} color="purple" />
            <KpiCard label="Avg Order Amount" value={fmt$(summary.avg_order_amount || 0)} color="teal" />
          </div>

          {/* Charts: 2-column side by side */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:20 }}>
            {/* Sub Revenue Chart */}
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Daily Subscription Revenue</div>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={daily} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                  <defs>
                    <linearGradient id="gradSubTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
                  <Tooltip formatter={(v,n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="sub_revenue_actual" name="Total Sub Revenue" stroke="#8b5cf6" fill="url(#gradSubTotal)" strokeWidth={2} dot={false} />
                  <Area type="monotone" dataKey="rebill_revenue" name="Rebill" stroke="#6366f1" fill="none" strokeWidth={2} strokeDasharray="4 2" dot={false} />
                  <Area type="monotone" dataKey="new_sub_revenue" name="New Sub" stroke="#14b8a6" fill="none" strokeWidth={2} strokeDasharray="4 2" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Revenue breakdown */}
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Rebill vs New Subscribers</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                <div style={{ background: 'var(--bg3)', borderRadius: 10, padding: '12px 14px', borderLeft: '3px solid #6366f1' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>REBILL REVENUE</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#6366f1' }}>{fmt$(rebillTotal)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>{totalSubRev > 0 ? ((rebillTotal/totalSubRev)*100).toFixed(1) + '%' : '—'} of total</div>
                </div>
                <div style={{ background: 'var(--bg3)', borderRadius: 10, padding: '12px 14px', borderLeft: '3px solid #14b8a6' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>NEW SUB REVENUE</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#14b8a6' }}>{fmt$(newSubTotal)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>{totalSubRev > 0 ? ((newSubTotal/totalSubRev)*100).toFixed(1) + '%' : '—'} of total</div>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={158}>
                <BarChart data={daily} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
                  <Tooltip formatter={(v,n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="rebill_revenue" name="Rebill" fill="#6366f1" stackId="rev" />
                  <Bar dataKey="new_sub_revenue" name="New Sub" fill="#14b8a6" stackId="rev" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Daily Subscription Detail</div>
            <SheetTable
              headers={DAILY_HEADERS}
              rows={dailyRows}
              keyField="_date"
              maxHeight="560px"
              defaultSortField="Date"
              defaultSortDir="desc"
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
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
