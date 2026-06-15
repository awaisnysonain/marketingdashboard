import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import PageIntro from '../components/PageIntro';
import PageFilterBar from '../components/PageFilterBar';
import KpiCard from '../components/KpiCard';
import ChartCard from '../components/ChartCard';
import { getChannels, fmt$, fmtFull$, fmtNum, fmtFullNum } from '../utils/api';
import { mtdRange, sortByRevenueDesc } from '../utils/dateRange';
import { NOBL_ACCENT, TOOLTIP_STYLE, CHART_GRID, mer, chColor } from '../utils/chartHelpers';
function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo, 10) - 1]} ${parseInt(dy, 10)}`;
}

function fmtVal(v, type) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (type === '$') return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (type === 'x') return n.toFixed(2);
  return Math.round(n).toLocaleString('en-US');
}

function Card({ title, subtitle, children, style }) {
  return (
    <section style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', boxShadow: '0 8px 22px rgba(15,23,42,.04)', ...style }}>
      {(title || subtitle) && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
          {title && <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{title}</div>}
          {subtitle && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{subtitle}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

function PillTab({ label, active, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{
      border: '1px solid var(--border2)',
      background: active ? 'var(--accent)' : 'var(--bg2)',
      color: active ? '#fff' : 'var(--text2)',
      borderRadius: 999, padding: '7px 16px', fontSize: 12, fontWeight: 700,
      cursor: 'pointer', transition: 'all .15s',
    }}>{label}</button>
  );
}

const METRICS = [
  { key: 'spend_1d',        label: 'Spend',           type: '$' },
  { key: 'revenue_1d',      label: 'Revenue',         type: '$' },
  { key: 'purchases_1d',    label: 'Purchases',       type: 'num' },
  { key: 'roas_1d',         label: 'ROAS',            type: 'x' },
  { key: 'cac',             label: 'CAC',             type: '$' },
  { key: 'new_cust_orders', label: 'New Cust Orders', type: 'num' },
];

function Skeleton() {
  return (
    <div style={{ padding: '60px 0', textAlign: 'center' }}>
      <div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .8s linear infinite', margin: '0 auto 12px' }} />
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>Loading NOBL Channel data...</div>
    </div>
  );
}

function ErrorBox({ msg, onRetry }) {
  return (
    <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.25)', borderRadius: 12, padding: '16px 20px', fontSize: 13, color: 'var(--danger)' }}>
      Failed to load data: {msg}
      {onRetry && <button onClick={onRetry} style={{ marginLeft: 12, fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>}
    </div>
  );
}

export default function NoblChannelDailyPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [range, setRange] = useState(mtdRange());
  const [activeChannel, setActiveChannel] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getChannels(range.start, range.end, 'NOBL')
      .then(d => { setRows(d.rows || []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const { channelNames, dates, byDateCh, chKpi, spendChartData, revChartData, channelTotals } = useMemo(() => {
    const chSet = new Set(), dateSet = new Set(), byDateCh = {}, chTotals = {};
    const dateMapSpend = {}, dateMapRev = {};
    for (const r of rows) {
      chSet.add(r.channel); dateSet.add(r.date);
      byDateCh[`${r.date}|${r.channel}`] = r;
      if (!chTotals[r.channel]) chTotals[r.channel] = { spend: 0, revenue: 0, purchases: 0 };
      chTotals[r.channel].spend += Number(r.spend_1d) || 0;
      chTotals[r.channel].revenue += Number(r.revenue_1d) || 0;
      chTotals[r.channel].purchases += Number(r.purchases_1d) || 0;
      if (!dateMapSpend[r.date]) dateMapSpend[r.date] = { date: r.date };
      if (!dateMapRev[r.date]) dateMapRev[r.date] = { date: r.date };
      dateMapSpend[r.date][r.channel] = (dateMapSpend[r.date][r.channel] || 0) + (Number(r.spend_1d) || 0);
      dateMapRev[r.date][r.channel] = (dateMapRev[r.date][r.channel] || 0) + (Number(r.revenue_1d) || 0);
    }
    const channelRev = {};
    for (const r of rows) {
      channelRev[r.channel] = (channelRev[r.channel] || 0) + (Number(r.revenue_1d) || 0);
    }
    const sortDates = (a, b) => String(a.date).localeCompare(String(b.date));
    const channelTotals = Object.entries(chTotals)
      .map(([channel, v]) => ({ channel, ...v, roas: mer(v.revenue, v.spend) }))
      .sort((a, b) => b.revenue - a.revenue);
    return {
      channelNames: sortByRevenueDesc(chSet, channelRev),
      dates: [...dateSet].sort(),
      byDateCh,
      chKpi: chTotals,
      spendChartData: Object.values(dateMapSpend).sort(sortDates),
      revChartData: Object.values(dateMapRev).sort(sortDates),
      channelTotals,
    };
  }, [rows]);

  useEffect(() => { if (channelNames.length && !activeChannel) setActiveChannel(channelNames[0]); }, [channelNames, activeChannel]);

  const t = chKpi[activeChannel] || { spend: 0, revenue: 0, purchases: 0 };
  const roas = t.spend > 0 ? t.revenue / t.spend : 0;

  return (
    <div className="page-stack">
      <PageFilterBar start={range.start} end={range.end} onChange={setRange} />
      <PageIntro title="NOBL Channel Level Daily" desc="Per-channel daily performance metrics for NOBL Travel — Spend, Revenue, Purchases, ROAS, CAC across all paid channels." />

      {loading ? <Skeleton /> : error ? <ErrorBox msg={error} onRetry={load} /> : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
            {channelNames.map(ch => <PillTab key={ch} label={ch} active={activeChannel === ch} onClick={() => setActiveChannel(ch)} />)}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Total Spend" value={fmt$(t.spend)} fullValue={fmtFull$(t.spend)} />
            <KpiCard label="Total Revenue" value={fmt$(t.revenue)} fullValue={fmtFull$(t.revenue)} />
            <KpiCard label="Avg ROAS" value={roas.toFixed(2) + 'x'} />
            <KpiCard label="Total Purchases" value={fmtNum(t.purchases)} fullValue={fmtFullNum(t.purchases)} />
          </div>

          <ChartCard title="Daily Spend by Channel" subtitle="Stacked area — all channels">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={spendChartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                <YAxis tickFormatter={(v) => fmt$(v)} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
                <Tooltip formatter={(v, n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {channelNames.map((ch) => (
                  <Area key={ch} type="monotone" dataKey={ch} name={ch} stackId="spend" stroke={chColor(ch)} fill={chColor(ch)} fillOpacity={0.65} strokeWidth={1} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Daily Revenue by Channel" subtitle="Attribution revenue_1d">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={revChartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                <YAxis tickFormatter={(v) => fmt$(v)} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
                <Tooltip formatter={(v, n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {channelNames.map((ch) => (
                  <Area key={ch} type="monotone" dataKey={ch} name={ch} stackId="rev" stroke={chColor(ch)} fill={chColor(ch)} fillOpacity={0.65} strokeWidth={1} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <div style={CHART_GRID}>
            <ChartCard title="Period Totals by Channel" subtitle="Spend vs revenue">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={channelTotals} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="channel" tick={{ fontSize: 11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={(v) => fmt$(v)} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
                  <Tooltip formatter={(v, n) => [fmt$(v), n]} contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="spend" name="Spend" radius={[4, 4, 0, 0]}>
                    {channelTotals.map((e, i) => <Cell key={i} fill={chColor(e.channel, '#f59e0b')} />)}
                  </Bar>
                  <Bar dataKey="revenue" name="Revenue" radius={[4, 4, 0, 0]}>
                    {channelTotals.map((e, i) => <Cell key={i} fill={chColor(e.channel)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="ROAS by Channel" subtitle="Period attribution">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={channelTotals} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="channel" tick={{ fontSize: 11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={(v) => v.toFixed(1) + 'x'} tick={{ fontSize: 11 }} width={44} stroke="var(--border2)" />
                  <Tooltip formatter={(v) => [v.toFixed(2) + 'x', 'ROAS']} contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="roas" name="ROAS" radius={[4, 4, 0, 0]}>
                    {channelTotals.map((e, i) => <Cell key={i} fill={chColor(e.channel, NOBL_ACCENT)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <Card title={activeChannel} subtitle={`${dates.length} days`}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--bg3)' }}>
                    <th style={{
                      padding: '9px 12px', textAlign: 'left', borderBottom: '2px solid var(--border)',
                      color: 'var(--text3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '.05em', whiteSpace: 'nowrap', position: 'sticky', left: 0,
                      background: 'var(--bg3)', zIndex: 2, minWidth: 90,
                    }}>Date</th>
                    {METRICS.map((m, i) => (
                      <th key={i} style={{
                        padding: '9px 12px', textAlign: 'right', borderBottom: '2px solid var(--border)',
                        color: 'var(--text3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '.05em', whiteSpace: 'nowrap',
                      }}>{m.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...dates].reverse().map((d, di) => {
                    const row = byDateCh[`${d}|${activeChannel}`];
                    return (
                      <tr key={d}
                          style={{ background: di % 2 === 0 ? 'transparent' : 'var(--bg3)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,.06)'}
                          onMouseLeave={e => e.currentTarget.style.background = di % 2 === 0 ? 'transparent' : 'var(--bg3)'}>
                        <td style={{
                          padding: '8px 12px', fontWeight: 600, color: 'var(--text)',
                          borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
                          position: 'sticky', left: 0,
                          background: di % 2 === 0 ? 'var(--bg2)' : 'var(--bg3)', zIndex: 1, fontSize: 11,
                        }}>{fmtDateLabel(d)}</td>
                        {METRICS.map((m) => (
                          <td key={m.key} style={{
                            padding: '8px 12px', textAlign: 'right', borderBottom: '1px solid var(--border)',
                            color: 'var(--text)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                          }}>{fmtVal(row?.[m.key], m.type)}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
