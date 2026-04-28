import React, { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getOverview, getSyncStatus, triggerSync, fmt$ } from '../utils/api';
import KpiCard from '../components/KpiCard';
import DateRangePicker from '../components/DateRangePicker';
import SheetTable from '../components/SheetTable';

function toISO(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return toISO(d); }
function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo)-1]} ${parseInt(dy)}`;
}

// column definitions for SheetTable
const OVERVIEW_HEADERS = [
  'Date',
  'NOBL Revenue', 'NOBL Spend', 'NOBL MER', 'NOBL Orders', 'NOBL NC Orders',
  'FLO Revenue',  'FLO Spend',  'FLO MER',  'FLO Orders',  'FLO NC Orders',
  'Total Revenue', 'Total Spend', 'Blended MER',
  'Sub Revenue',
];

function toTableRow(r) {
  const blendedMer = r.total_spend > 0 ? (r.total_revenue / r.total_spend) : null;
  return {
    'Date':           r.date,
    'NOBL Revenue':   r.nobl_revenue,
    'NOBL Spend':     r.nobl_spend,
    'NOBL MER':       r.nobl_mer,
    'NOBL Orders':    r.nobl_orders,
    'NOBL NC Orders': r.nobl_nc_orders,
    'FLO Revenue':    r.flo_revenue,
    'FLO Spend':      r.flo_spend,
    'FLO MER':        r.flo_mer,
    'FLO Orders':     r.flo_orders,
    'FLO NC Orders':  r.flo_nc_orders,
    'Total Revenue':  r.total_revenue,
    'Total Spend':    r.total_spend,
    'Blended MER':    blendedMer,
    'Sub Revenue':    r.nobl_sub_revenue,
    _date: r.date, // keep for sorting
  };
}

export default function OverviewPage({ showToast }) {
  const [range, setRange] = useState({ start: daysAgo(30), end: toISO(new Date()) });
  const [data, setData]     = useState(null);
  const [syncData, setSyncData] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [syncing, setSyncing]   = useState(false);
  const [error, setError]       = useState(null);
  const [lastSyncLabel, setLastSyncLabel] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [overview, sync] = await Promise.all([
        getOverview(range.start, range.end),
        getSyncStatus().catch(() => null),
      ]);
      setData(overview);
      setSyncData(sync);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    function updateLabel(syncD) {
      const rec = syncD?.recent?.[0];
      if (!rec?.finished_at) { setLastSyncLabel(null); return; }
      const diffMin = Math.floor((Date.now() - new Date(rec.finished_at).getTime()) / 60000);
      if (diffMin < 1) setLastSyncLabel('just now');
      else if (diffMin < 60) setLastSyncLabel(`${diffMin}m ago`);
      else setLastSyncLabel(`${Math.floor(diffMin / 60)}h ago`);
    }
    updateLabel(syncData);
    const id = setInterval(() => getSyncStatus().then(d => { setSyncData(d); updateLabel(d); }).catch(()=>{}), 60000);
    return () => clearInterval(id);
  }, [syncData]);

  async function handleSync() {
    setSyncing(true);
    try {
      await triggerSync();
      showToast?.('Sync triggered', 'success');
      setTimeout(() => getSyncStatus().then(setSyncData).catch(()=>{}), 1000);
    } catch { showToast?.('Sync failed', 'error'); }
    finally { setSyncing(false); }
  }

  const totals = data?.totals || {};
  const chartRows = data?.rows || [];

  // rows for SheetTable
  const tableRows = chartRows.map(toTableRow);

  return (
    <div>
      {/* ── header ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:800, margin:0, fontFamily:'var(--font-head)' }}>Overview</h1>
          <p style={{ fontSize:13, color:'var(--text3)', margin:'4px 0 0' }}>NOBL Air + Pilates FLO combined performance</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            {lastSyncLabel && (
              <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:11, color:'var(--text3)', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:20, padding:'3px 10px' }}>
                <span style={{ width:5, height:5, borderRadius:'50%', background:'var(--success)', flexShrink:0 }} />
                Last synced: {lastSyncLabel}
              </span>
            )}
            <button onClick={handleSync} disabled={syncing} style={{
              padding:'6px 14px', fontSize:12, fontWeight:600,
              background:'var(--accent)', color:'#fff', border:'none', borderRadius:7,
              cursor:syncing?'not-allowed':'pointer', opacity:syncing?.7:1,
            }}>{syncing ? 'Syncing…' : 'Sync Now'}</button>
          </div>
        </div>
      </div>

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          {/* ── KPI row ── */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(175px,1fr))', gap:12, marginBottom:24 }}>
            <KpiCard label="Total Revenue"   value={fmt$(totals.total_revenue   || 0)} color="blue" />
            <KpiCard label="Total Spend"     value={fmt$(totals.total_spend     || 0)} color="warn" />
            <KpiCard label="Blended MER"     value={(totals.blended_mer         || 0).toFixed(2)+'x'} color="green" />
            <KpiCard label="NOBL Revenue"    value={fmt$(totals.nobl_revenue    || 0)} color="nobl" />
            <KpiCard label="NOBL Orders"     value={(totals.nobl_orders         || 0).toLocaleString()} color="nobl" />
            <KpiCard label="FLO Revenue"     value={fmt$(totals.flo_revenue     || 0)} color="flo" />
            <KpiCard label="FLO Orders"      value={(totals.flo_orders          || 0).toLocaleString()} color="flo" />
            <KpiCard label="NOBL Sub Rev"    value={fmt$(totals.nobl_sub_revenue|| 0)} color="purple" />
          </div>

          {/* ── Charts row ── */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:20 }}>
            <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
              <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>Revenue Over Time</div>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={chartRows} margin={{ top:4, right:16, left:0, bottom:4 }}>
                  <defs>
                    <linearGradient id="gradNobl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="gradFlo" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#14b8a6" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                  <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtDateLabel}
                    contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  <Area type="monotone" dataKey="nobl_revenue" name="NOBL Revenue" stroke="#6366f1" fill="url(#gradNobl)" strokeWidth={2} dot={false} />
                  <Area type="monotone" dataKey="flo_revenue"  name="FLO Revenue"  stroke="#14b8a6" fill="url(#gradFlo)"  strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
              <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>Daily Spend Comparison</div>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartRows} margin={{ top:4, right:16, left:0, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                  <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtDateLabel}
                    contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  <Bar dataKey="nobl_spend" name="NOBL Spend" fill="#6366f1" radius={[2,2,0,0]} />
                  <Bar dataKey="flo_spend"  name="FLO Spend"  fill="#14b8a6" radius={[2,2,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── Daily Summary SheetTable ── */}
          <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>
              Daily Summary
              <span style={{ fontSize:11, fontWeight:400, color:'var(--text3)', marginLeft:8 }}>
                — click cells to select · shift+click range · ctrl+C copy
              </span>
            </div>
            <SheetTable
              headers={OVERVIEW_HEADERS}
              rows={tableRows}
              keyField="_date"
              maxHeight="520px"
              defaultSortField="Date"
              defaultSortDir="desc"
              searchable={true}
              stickyFirstCol={false}
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
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(175px,1fr))', gap:12, marginBottom:24 }}>
        {[...Array(8)].map((_,i) => <div key={i} style={{ height:90, background:'var(--bg3)', borderRadius:12, animation:'pulse 1.5s ease-in-out infinite' }} />)}
      </div>
      <div style={{ height:280, background:'var(--bg2)', borderRadius:12, marginBottom:20, animation:'pulse 1.5s ease-in-out infinite' }} />
      <div style={{ height:240, background:'var(--bg2)', borderRadius:12, marginBottom:20, animation:'pulse 1.5s ease-in-out infinite' }} />
      <div style={{ height:300, background:'var(--bg2)', borderRadius:12, animation:'pulse 1.5s ease-in-out infinite' }} />
    </div>
  );
}

function ErrorMsg({ msg, onRetry }) {
  return (
    <div style={{ padding:'40px 0', textAlign:'center' }}>
      <div style={{ color:'var(--danger)', marginBottom:12, fontSize:14 }}>Failed to load: {msg}</div>
      <button onClick={onRetry} style={{ padding:'8px 20px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontWeight:600 }}>Retry</button>
    </div>
  );
}
