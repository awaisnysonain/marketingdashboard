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
  'Date', 'New Subs', 'New Sub Revenue', 'Rebill Revenue', 'Total Sub Revenue',
];

function toDailyRow(r) {
  return {
    'Date': r.date,
    'New Subs': r.new_sub_count ?? 0,
    'New Sub Revenue': r.new_sub_revenue,
    'Rebill Revenue': r.rebill_revenue,
    'Total Sub Revenue': r.sub_revenue_actual,
    _date: r.date,
  };
}

function isZeroDay(r) {
  return (
    Number(r.new_sub_revenue || 0) === 0 &&
    Number(r.rebill_revenue || 0) === 0 &&
    Number(r.sub_revenue_actual || 0) === 0
  );
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
  const [brands, setBrands] = useState(['NOBL']);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('activated_on');
  const [sortDir, setSortDir] = useState('desc');

  function toggleBrand(b) {
    setBrands(prev => {
      const has = prev.includes(b);
      if (has) {
        // Don't allow zero selected — keep current if user is deselecting the only one
        return prev.length === 1 ? prev : prev.filter(x => x !== b);
      }
      // Keep canonical order: NOBL before FLO
      const next = [...prev, b];
      return ['NOBL', 'FLO'].filter(x => next.includes(x));
    });
  }

  const brandParam = brands.join(',');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getSubscriptions(range.start, range.end, brandParam)); }
    catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, [range, brandParam]);

  useEffect(() => { load(); }, [load]);

  function handleSort(field) {
    if (sortBy === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortDir('desc'); }
  }

  const rawDaily = data?.daily || [];
  // Drop trailing zero-only rows (today's pending data before cron runs)
  let trimEnd = rawDaily.length;
  while (trimEnd > 0 && isZeroDay(rawDaily[trimEnd - 1])) trimEnd--;
  const daily = rawDaily.slice(0, trimEnd);
  const trimmedCount = rawDaily.length - daily.length;
  const summary = data?.summary || {};
  const dailyRows = daily.map(toDailyRow);

  const rebillTotal = daily.reduce((s,r) => s + Number(r.rebill_revenue || 0), 0);
  const newSubTotal = daily.reduce((s,r) => s + Number(r.new_sub_revenue || 0), 0);
  const totalSubRev = daily.reduce((s,r) => s + Number(r.sub_revenue_actual || 0), 0);
  const newSubCount = daily.reduce((s,r) => s + Number(r.new_sub_count || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, fontFamily: 'var(--font-head)', color: '#8b5cf6' }}>Subscriptions</h1>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: '4px 0 0' }}>
            {brands.length === 2
              ? 'NOBL Air + Pilates FLO — combined subscription program'
              : brands[0] === 'FLO'
                ? 'FLO subscription program deep dive'
                : 'NOBL Air subscription program deep dive'}
          </p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          <div style={{ display:'inline-flex', background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:10, padding:3, gap:2 }} title="Click to toggle. Select both to view combined.">
            {['NOBL','FLO'].map(b => {
              const on = brands.includes(b);
              return (
                <button key={b} onClick={() => toggleBrand(b)} style={{
                  padding:'7px 14px', border:'none', borderRadius:8, cursor:'pointer', fontWeight:700,
                  background: on ? 'var(--accent)' : 'transparent',
                  color: on ? '#fff' : 'var(--text2)',
                }}>{b}</button>
              );
            })}
          </div>
          <DateRangePicker start={range.start} end={range.end} onChange={setRange} scope="subs" />
        </div>
      </div>

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          {/* KPI cards.
              Top row: date-bounded metrics (move with the date picker).
              Bottom row: all-time subscriber counts (Appstle current state). */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
            <KpiCard label="Total Sub Revenue" sub="in range" value={fmt$(totalSubRev)} color="purple" />
            <KpiCard label="New Subs" sub="in range" value={newSubCount.toLocaleString()} color="teal" />
            <KpiCard label="New Sub Revenue" sub="in range" value={fmt$(newSubTotal)} color="teal" />
            <KpiCard label="Rebill Revenue" sub="in range" value={fmt$(rebillTotal)} color="nobl" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
            <KpiCard label="Active Subscribers" sub="all-time" value={(summary.active || 0).toLocaleString()} color="green" />
            <KpiCard label="Converted" sub="all-time" value={(summary.converted || 0).toLocaleString()} color="nobl" />
            <KpiCard label="Cancelled" sub="all-time" value={(summary.cancelled || 0).toLocaleString()} color="danger" />
            <KpiCard label="Avg Contract Value" sub="all-time" value={fmt$(summary.avg_order_amount || 0)} color="purple" />
          </div>
          {trimmedCount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 12, fontStyle: 'italic' }}>
              Today's data isn't aggregated yet — daily sync runs at 11 AM PKT.
            </div>
          )}
          {daily.length === 0 && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
              No subscription activity in this date range.
            </div>
          )}

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

            {/* Stacked breakdown: rebill vs new sub revenue per day */}
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Rebill vs New Subscribers</div>
              <ResponsiveContainer width="100%" height={240}>
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
