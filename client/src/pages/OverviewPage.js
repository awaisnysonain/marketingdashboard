import React, { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getOverview, getSyncStatus, triggerSync, fmt$ } from '../utils/api';
import KpiCard from '../components/KpiCard';
import PageFilterBar from '../components/PageFilterBar';
import PaginatedSheetTable from '../components/PaginatedSheetTable';
import PageIntro from '../components/PageIntro';
import { L, TIP, PAGE } from '../copy/plainLanguage';
import { mtdRange } from '../utils/dateRange';
function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo)-1]} ${parseInt(dy)}`;
}

// column definitions for SheetTable
const OVERVIEW_HEADERS = [
  L.date,
  'NOBL Gross − Discounts', 'NOBL Order Revenue', 'NOBL ad spend', 'NOBL sales per ad $', 'NOBL orders', 'NOBL new customers',
  'FLO Gross − Discounts', 'FLO Order Revenue', 'FLO ad spend', 'FLO sales per ad $', 'FLO orders', 'FLO new customers',
  'Total Gross − Discounts', 'Total Order Revenue', 'Total ad spend', L.blendedMer,
  L.subRevenue,
];

function toTableRow(r) {
  const blendedMer = r.total_spend > 0 ? (r.total_revenue / r.total_spend) : null;
  const totalGmd = (r.nobl_gross_minus_discounts || 0) + (r.flo_gross_minus_discounts || 0);
  return {
    [L.date]:           r.date,
    'NOBL Gross − Discounts': r.nobl_gross_minus_discounts,
    'NOBL Order Revenue':     r.nobl_revenue,
    'NOBL ad spend':          r.nobl_spend,
    'NOBL sales per ad $':    r.nobl_mer,
    'NOBL orders':            r.nobl_orders,
    'NOBL new customers':     r.nobl_nc_orders,
    'FLO Gross − Discounts':  r.flo_gross_minus_discounts,
    'FLO Order Revenue':      r.flo_revenue,
    'FLO ad spend':           r.flo_spend,
    'FLO sales per ad $':     r.flo_mer,
    'FLO orders':             r.flo_orders,
    'FLO new customers':      r.flo_nc_orders,
    'Total Gross − Discounts': totalGmd,
    'Total Order Revenue':    r.total_revenue,
    'Total ad spend':         r.total_spend,
    [L.blendedMer]:           blendedMer,
    [L.subRevenue]:           r.nobl_sub_revenue,
    _date: r.date,
  };
}

export default function OverviewPage({ showToast }) {
  const [range, setRange] = useState(mtdRange());
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
    <div className="page-stack">
      <PageFilterBar start={range.start} end={range.end} onChange={setRange}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginLeft:'auto' }}>
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
      </PageFilterBar>

      <PageIntro title={PAGE.overview.title} desc={PAGE.overview.desc} />

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          <div className="page-kpi-grid">
            <KpiCard label="Gross − Discounts (NOBL)" value={fmt$(totals.nobl_gross_minus_discounts || 0)} tooltip={TIP.grossMinusDiscounts} color="nobl" />
            <KpiCard label="Order Revenue (NOBL)" value={fmt$(totals.nobl_revenue || 0)} tooltip={TIP.orderRevenue} color="nobl" />
            <KpiCard label="Gross − Discounts (FLO)" value={fmt$(totals.flo_gross_minus_discounts || 0)} tooltip={TIP.grossMinusDiscounts} color="flo" />
            <KpiCard label="Order Revenue (FLO)" value={fmt$(totals.flo_revenue || 0)} tooltip={TIP.orderRevenue} color="flo" />
            <KpiCard label="Total sales" value={fmt$(totals.total_revenue || 0)} fullValue={fmt$(totals.total_revenue || 0)} tooltip={TIP.orderRevenue} color="blue" />
            <KpiCard label="Total ad spend" value={fmt$(totals.total_spend || 0)} fullValue={fmt$(totals.total_spend || 0)} tooltip={TIP.spend} color="warn" />
            <KpiCard label={L.blendedMer} value={(totals.blended_mer || 0).toFixed(2) + 'x'} tooltip={TIP.mer} color="green" />
            <KpiCard label="NOBL sales" value={fmt$(totals.nobl_revenue || 0)} tooltip={TIP.revenue} color="nobl" />
            <KpiCard label="NOBL orders" value={(totals.nobl_orders || 0).toLocaleString()} tooltip={TIP.orders} color="nobl" />
            <KpiCard label="FLO sales" value={fmt$(totals.flo_revenue || 0)} tooltip={TIP.revenue} color="flo" />
            <KpiCard label="FLO orders" value={(totals.flo_orders || 0).toLocaleString()} tooltip={TIP.orders} color="flo" />
            <KpiCard label="NOBL subscription sales" value={fmt$(totals.nobl_sub_revenue || 0)} tooltip={TIP.subRevenue} color="purple" />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
            <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
              <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>Sales over time</div>
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
                  <Area type="monotone" dataKey="nobl_revenue" name="NOBL sales" stroke="#6366f1" fill="url(#gradNobl)" strokeWidth={2} dot={false} />
                  <Area type="monotone" dataKey="flo_revenue"  name="FLO sales"  stroke="#14b8a6" fill="url(#gradFlo)"  strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
              <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>Daily ad spend comparison</div>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartRows} margin={{ top:4, right:16, left:0, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                  <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtDateLabel}
                    contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  <Bar dataKey="nobl_spend" name="NOBL ad spend" fill="#6366f1" radius={[2,2,0,0]} />
                  <Bar dataKey="flo_spend"  name="FLO ad spend"  fill="#14b8a6" radius={[2,2,0,0]} />
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
            <PaginatedSheetTable
              headers={OVERVIEW_HEADERS}
              rows={tableRows}
              keyField="_date"
              resetDeps={[range.start, range.end]}
              defaultSortField={L.date}
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
