import React, { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getSubscriptions, fmt$, fmtNum } from '../utils/api';
import KpiCard from '../components/KpiCard';
import ChartPanel from '../components/ChartPanel';
import PaginatedSheetTable from '../components/PaginatedSheetTable';
import { L, TIP } from '../copy/plainLanguage';
import { useDashboardFilters } from '../context/DashboardFilterContext';
import { TOOLTIP_STYLE } from '../utils/chartHelpers';

function toISO(d) { return d.toISOString().slice(0, 10); }
function startOfMonthISO() { const d = new Date(); d.setDate(1); return toISO(d); }
function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo)-1]} ${parseInt(dy)}`;
}

const STATUS_COLORS = { active: 'var(--success)', cancelled: 'var(--danger)', trialing: 'var(--warn)', converted: '#6366f1' };

const DAILY_HEADERS = [
  L.date, L.newSubs, L.newSubRevenue, L.rebillRevenue, 'Total subscription sales',
];

function toDailyRow(r) {
  return {
    [L.date]: r.date,
    [L.newSubs]: r.new_sub_count ?? 0,
    [L.newSubRevenue]: r.new_sub_revenue,
    [L.rebillRevenue]: r.rebill_revenue,
    'Total subscription sales': r.sub_revenue_actual,
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

export default function SubsPage({ showToast }) {
  const { dateRange, brandsApi } = useDashboardFilters();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getSubscriptions(dateRange.start, dateRange.end, brandsApi.subs)); }
    catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, [dateRange, brandsApi.subs]);

  useEffect(() => { load(); }, [load]);

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
    <div className="page-stack">
      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          {/* KPI cards.
              Top row: date-bounded metrics (move with the date picker).
              Bottom row: all-time subscriber counts (Appstle current state). */}
          <div className="section">
            <div className="section__title">IN DATE RANGE</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(165px, 1fr))', gap: 12 }}>
              <KpiCard label="Total subscription sales" sub="in date range" value={fmt$(totalSubRev)} tooltip={TIP.totalSubRevenue} color="purple" />
              <KpiCard label={L.newSubs} sub="in date range" value={fmtNum(newSubCount)} tooltip={TIP.newSubs} color="teal" />
              <KpiCard label={L.newSubRevenue} sub="in date range" value={fmt$(newSubTotal)} tooltip={TIP.newSubRevenue} color="teal" />
              <KpiCard label={L.rebillRevenue} sub="in date range" value={fmt$(rebillTotal)} tooltip={TIP.rebillRevenue} color="nobl" />
            </div>
          </div>
          <div className="section">
            <div className="section__title">SUBSCRIBER STATUS</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(165px, 1fr))', gap: 12 }}>
              <KpiCard label={L.activeSubs} sub="right now" value={fmtNum(summary.active || 0)} tooltip={TIP.activeSubs} color="green" />
              <KpiCard label={L.converted} sub="right now" value={fmtNum(summary.converted || 0)} tooltip={TIP.converted} color="nobl" />
              <KpiCard label={L.cancelled} sub="right now" value={fmtNum(summary.cancelled || 0)} tooltip={TIP.cancelled} color="danger" />
              <KpiCard label={L.avgContract} sub="right now" value={fmt$(summary.avg_order_amount || 0)} tooltip={TIP.avgContract} color="purple" />
            </div>
          </div>
          {trimmedCount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>
              Today's data isn't aggregated yet — daily sync runs at 11 AM PKT.
            </div>
          )}
          {daily.length === 0 && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
              No subscription activity in this date range.
            </div>
          )}

          {/* Charts: 2-column side by side */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
            {/* Sub Revenue Chart */}
            <ChartPanel title="Daily subscription sales">
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
                  <Area type="monotone" dataKey="sub_revenue_actual" name="Total subscription sales" stroke="#8b5cf6" fill="url(#gradSubTotal)" strokeWidth={2} dot={false} />
                  <Area type="monotone" dataKey="rebill_revenue" name="Renewals" stroke="#6366f1" fill="none" strokeWidth={2} strokeDasharray="4 2" dot={false} />
                  <Area type="monotone" dataKey="new_sub_revenue" name="New signups" stroke="#14b8a6" fill="none" strokeWidth={2} strokeDasharray="4 2" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartPanel>

            {/* Stacked breakdown: rebill vs new sub revenue per day */}
            <ChartPanel title="Renewals vs new signups">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={daily} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
                  <Tooltip formatter={(v,n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="rebill_revenue" name="Renewals" fill="#6366f1" stackId="rev" />
                  <Bar dataKey="new_sub_revenue" name="New signups" fill="#14b8a6" stackId="rev" />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>
          </div>

          <ChartPanel title="Daily Subscription Detail">
            <PaginatedSheetTable
              headers={DAILY_HEADERS}
              rows={dailyRows}
              keyField="_date"
              resetDeps={[dateRange.start, dateRange.end]}
              defaultSortField="Date"
              defaultSortDir="desc"
            />
          </ChartPanel>
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
      <button onClick={onRetry} className="btn btn--primary">Retry</button>
    </div>
  );
}
