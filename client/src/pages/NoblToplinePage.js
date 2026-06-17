import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, Line, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import PageIntro from '../components/PageIntro';
import PageFilterBar from '../components/PageFilterBar';
import KpiCard from '../components/KpiCard';
import ChartCard from '../components/ChartCard';
import VerticalDataTable from '../components/VerticalDataTable';
import { CommentProvider } from '../components/CommentProvider';
import { commentTargetKey } from '../utils/commentKeys';
import { getNoblTopline, fmt$, fmtFull$, fmtNum, fmtFullNum, fmtRatio } from '../utils/api';
import { TIP } from '../copy/plainLanguage';
import { mtdRange, sortByRevenueDesc } from '../utils/dateRange';
import {
  enrichSummaryRow, enrichChannelRow, enrichGeoRow, enrichSubsRow, mergeToplineDates,
} from '../utils/toplineData';
import {
  NOBL_ACCENT, NOBL_WARN, GEO_COL, TOOLTIP_STYLE, CHART_GRID, mer, chColor,
  Y_AXIS_WIDTH_CURRENCY, Y_AXIS_WIDTH_RATIO, fmtChartTooltip, fmtAxisCurrency, fmtAxisRatio,
} from '../utils/chartHelpers';

const PAGE_KEY = 'nobl-topline';

function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo, 10) - 1]} ${parseInt(dy, 10)}`;
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

const SUMMARY_METRICS = [
  { key: 'order_revenue',             label: 'Order Revenue',    type: '$', tip: TIP.orderRevenue },
  { key: 'total_spend',               label: 'Spend',            type: '$' },
  { key: 'mer',                       label: 'MER',              type: 'x' },
  { key: 'total_orders',              label: 'Orders',           type: 'num' },
  { key: 'new_customer_orders',       label: 'New Cust',         type: 'num' },
  { key: 'returning_customer_orders', label: 'Returning',        type: 'num' },
  { key: 'shopify_revenue',           label: 'Shopify Rev',      type: '$', tip: TIP.shopifyRevenue },
  { key: 'amazon_revenue',            label: 'Amazon Rev',       type: '$', tip: TIP.amazonToplineRevenue },
  { key: 'refund_amount',             label: 'Refunds',          type: '$' },
];
const CHANNEL_METRICS = [
  { key: 'spend_1d',        label: 'Spend',     type: '$' },
  { key: 'revenue_1d',      label: 'Revenue',   type: '$' },
  { key: 'roas_1d',         label: 'ROAS',      type: 'x' },
  { key: 'purchases_1d',    label: 'Purchases', type: 'num' },
  { key: 'new_cust_orders', label: 'New Cust',  type: 'num' },
  { key: 'cac',             label: 'CAC',       type: '$' },
];
const GEO_METRICS = [
  { key: 'revenue_actual', label: 'Revenue', type: '$' },
  { key: 'spend_actual',   label: 'Spend',   type: '$' },
  { key: 'mer',            label: 'MER',     type: 'x' },
];
const SUB_METRICS = [
  { key: 'sub_revenue_actual',  label: 'Sub Revenue',  type: '$' },
  { key: 'rebill_revenue',      label: 'Rebill Rev',   type: '$' },
  { key: 'new_sub_revenue',     label: 'New Sub Rev',  type: '$' },
  { key: 'shopify_sub_gross',   label: 'Sub Gross',    type: '$' },
  { key: 'shopify_sub_refunds', label: 'Sub Refunds',  type: '$' },
];

function Skeleton() {
  return (
    <div style={{ padding: '60px 0', textAlign: 'center' }}>
      <div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .8s linear infinite', margin: '0 auto 12px' }} />
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>Loading NOBL Topline...</div>
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

export default function NoblToplinePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [range, setRange] = useState(mtdRange());
  const [activeView, setActiveView] = useState('summary');
  const [activeChannel, setActiveChannel] = useState(null);
  const [activeRegion, setActiveRegion] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getNoblTopline(range.start, range.end)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const { dates, summaryByDate, channelNames, channelByDateCh, regionNames, geoByDateRg, subsByDate, kpi, chartData, chAgg, geoAgg, subChartData } = useMemo(() => {
    if (!data) return { dates: [], summaryByDate: {}, channelNames: [], channelByDateCh: {}, regionNames: [], geoByDateRg: {}, subsByDate: {}, kpi: {}, chartData: [], chAgg: [], geoAgg: [], subChartData: [] };
    const summaryByDate = {};
    let totalRev = 0, totalSpend = 0, totalOrders = 0, totalNew = 0;
    for (const r of (data.summary || [])) {
      summaryByDate[r.date] = r;
      totalRev += Number(r.order_revenue || r.total_revenue) || 0;
      totalSpend += Number(r.total_spend) || 0;
      totalOrders += Number(r.total_orders) || 0;
      totalNew += Number(r.new_customer_orders) || 0;
    }
    const chSet = new Set(), channelByDateCh = {}, channelRev = {};
    for (const r of (data.channels || [])) {
      chSet.add(r.channel);
      channelByDateCh[`${r.date}|${r.channel}`] = r;
      channelRev[r.channel] = (channelRev[r.channel] || 0) + (Number(r.revenue_1d) || 0);
    }
    const rgSet = new Set(), geoByDateRg = {}, regionRev = {};
    for (const r of (data.geo || [])) {
      rgSet.add(r.region);
      geoByDateRg[`${r.date}|${r.region}`] = r;
      regionRev[r.region] = (regionRev[r.region] || 0) + (Number(r.revenue_actual || r.revenue) || 0);
    }
    const subsByDate = {};
    let totalSubRev = 0;
    for (const r of (data.subs || [])) { subsByDate[r.date] = r; totalSubRev += Number(r.sub_revenue_actual) || 0; }
    const allDates = mergeToplineDates(data.summary, data.channels, data.geo, data.subs);
    const periodMer = totalSpend > 0 ? totalRev / totalSpend : 0;

    const chartData = allDates.map((d) => {
      const r = summaryByDate[d] || {};
      const rev = Number(r.order_revenue || r.total_revenue) || 0;
      const spend = Number(r.total_spend) || 0;
      return {
        date: d,
        order_revenue: rev,
        total_spend: spend,
        mer: Number(r.mer) || mer(rev, spend),
      };
    });

    const chMap = {};
    for (const r of (data.channels || [])) {
      if (!chMap[r.channel]) chMap[r.channel] = { channel: r.channel, spend: 0, revenue: 0 };
      chMap[r.channel].spend += Number(r.spend_1d) || 0;
      chMap[r.channel].revenue += Number(r.revenue_1d) || 0;
    }
    const chAgg = Object.values(chMap)
      .map((v) => ({ ...v, roas: mer(v.revenue, v.spend) }))
      .sort((a, b) => b.revenue - a.revenue);

    const geoMap = {};
    for (const r of (data.geo || [])) {
      if (!geoMap[r.region]) geoMap[r.region] = { region: r.region, revenue: 0, spend: 0 };
      geoMap[r.region].revenue += Number(r.revenue_actual || r.revenue) || 0;
      geoMap[r.region].spend += Number(r.spend_actual || r.spend) || 0;
    }
    const geoAgg = Object.values(geoMap)
      .map((v) => ({ ...v, mer: mer(v.revenue, v.spend) }))
      .sort((a, b) => b.revenue - a.revenue);

    const subChartData = allDates
      .filter((d) => subsByDate[d])
      .map((d) => {
        const r = subsByDate[d];
        return {
          date: d,
          sub_revenue: Number(r.sub_revenue_actual) || 0,
          rebill_revenue: Number(r.rebill_revenue) || 0,
          new_sub_revenue: Number(r.new_sub_revenue) || 0,
        };
      });

    return {
      dates: allDates,
      summaryByDate,
      channelNames: sortByRevenueDesc(chSet, channelRev),
      channelByDateCh,
      regionNames: sortByRevenueDesc(rgSet, regionRev),
      geoByDateRg,
      subsByDate,
      kpi: { totalRev, totalSpend, mer: periodMer, totalOrders, totalNew, totalSubRev },
      chartData,
      chAgg,
      geoAgg,
      subChartData,
    };
  }, [data]);

  useEffect(() => { if (channelNames.length && !activeChannel) setActiveChannel(channelNames[0]); }, [channelNames, activeChannel]);
  useEffect(() => { if (regionNames.length && !activeRegion) setActiveRegion(regionNames[0]); }, [regionNames, activeRegion]);

  const VIEWS = [
    { id: 'summary', label: 'Summary' },
    { id: 'channels', label: 'Channels' },
    { id: 'geo', label: 'Geography' },
    { id: 'subs', label: 'Subscriptions' },
  ];

  return (
    <CommentProvider pageKey={PAGE_KEY}>
    <div className="page-stack">
      <PageFilterBar start={range.start} end={range.end} onChange={setRange} />

      <PageIntro title="NOBL Topline" desc="Daily topline performance for NOBL Travel — revenue, spend, MER, channel breakdowns, geo splits, and subscription data." />

      {loading ? <Skeleton /> : error ? <ErrorBox msg={error} onRetry={load} /> : (
        <>
          <div className="page-kpi-grid">
            <KpiCard label="Order Revenue" value={fmt$(kpi.totalRev)} fullValue={fmtFull$(kpi.totalRev)} tooltip={TIP.orderRevenue} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('order_revenue'), targetLabel: 'Order Revenue' }} />
            <KpiCard label="Total Spend" value={fmt$(kpi.totalSpend)} fullValue={fmtFull$(kpi.totalSpend)} tooltip={TIP.spend} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_spend'), targetLabel: 'Total Spend' }} />
            <KpiCard label="MER" value={fmtRatio(kpi.mer)} copyValue={kpi.mer != null ? Number(kpi.mer).toFixed(4) : undefined} tooltip={TIP.mer} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('mer'), targetLabel: 'MER' }} />
            <KpiCard label="Total Orders" value={fmtNum(kpi.totalOrders)} fullValue={fmtFullNum(kpi.totalOrders)} tooltip={TIP.orders} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_orders'), targetLabel: 'Total Orders' }} />
            <KpiCard label="New Customers" value={fmtNum(kpi.totalNew)} fullValue={fmtFullNum(kpi.totalNew)} tooltip={TIP.ncOrders} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('new_customers'), targetLabel: 'New Customers' }} />
            <KpiCard label="Sub Revenue" value={fmt$(kpi.totalSubRev)} fullValue={fmtFull$(kpi.totalSubRev)} tooltip={TIP.subRevenue} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('sub_revenue'), targetLabel: 'Sub Revenue' }} />
          </div>

          <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
            {VIEWS.map(v => <PillTab key={v.id} label={v.label} active={activeView === v.id} onClick={() => setActiveView(v.id)} />)}
          </div>

          {activeView === 'summary' && (
            <>
              <div style={CHART_GRID}>
                <ChartCard title="Order Revenue" subtitle="Daily trend">
                  <ResponsiveContainer width="100%" height={240}>
                    <AreaChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <defs>
                        <linearGradient id="noblGradRev" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={NOBL_ACCENT} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={NOBL_ACCENT} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize: 11 }} width={Y_AXIS_WIDTH_CURRENCY} stroke="var(--border2)" />
                      <Tooltip formatter={(v, n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="order_revenue" name="Order Revenue" stroke={NOBL_ACCENT} fill="url(#noblGradRev)" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>
                <ChartCard title="Spend vs Revenue" subtitle="MER context">
                  <ResponsiveContainer width="100%" height={240}>
                    <ComposedChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize: 11 }} width={Y_AXIS_WIDTH_CURRENCY} stroke="var(--border2)" />
                      <Tooltip formatter={(v, n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="order_revenue" name="Order Revenue" stroke={NOBL_ACCENT} fill="rgba(99,102,241,.12)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="total_spend" name="Spend" stroke={NOBL_WARN} strokeWidth={2} strokeDasharray="5 3" dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
              <Card title="Daily Summary" subtitle={`${dates.length} days`}>
                <VerticalDataTable dates={dates} getRow={d => enrichSummaryRow(summaryByDate[d])} metrics={SUMMARY_METRICS} tableScope="summary" />
              </Card>
            </>
          )}

          {activeView === 'channels' && (
            <>
              <div style={CHART_GRID}>
                <ChartCard title="Channel Revenue" subtitle="Period totals, sorted by revenue">
                  <ResponsiveContainer width="100%" height={Math.max(180, chAgg.length * 36)}>
                    <BarChart data={chAgg} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis type="number" tickFormatter={fmtAxisCurrency} tick={{ fontSize: 10 }} stroke="var(--border2)" />
                      <YAxis dataKey="channel" type="category" tick={{ fontSize: 11, fontWeight: 600 }} width={72} stroke="var(--border2)" />
                      <Tooltip formatter={(v) => [fmt$(v), 'Revenue']} contentStyle={TOOLTIP_STYLE} />
                      <Bar dataKey="revenue" name="Revenue" radius={[0, 4, 4, 0]} maxBarSize={20}>
                        {chAgg.map((e, i) => <Cell key={i} fill={chColor(e.channel)} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
                <ChartCard title="Spend & ROAS by Channel" subtitle="Period totals">
                  <ResponsiveContainer width="100%" height={240}>
                    <ComposedChart data={chAgg} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="channel" tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis yAxisId="left" tickFormatter={fmtAxisCurrency} tick={{ fontSize: 10 }} width={Y_AXIS_WIDTH_CURRENCY} stroke="var(--border2)" />
                      <YAxis yAxisId="right" orientation="right" tickFormatter={fmtAxisRatio} tick={{ fontSize: 10 }} width={Y_AXIS_WIDTH_RATIO} stroke="var(--border2)" />
                      <Tooltip formatter={fmtChartTooltip} contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar yAxisId="left" dataKey="spend" name="Spend" radius={[4, 4, 0, 0]}>
                        {chAgg.map((e, i) => <Cell key={i} fill={chColor(e.channel, NOBL_WARN)} />)}
                      </Bar>
                      <Line yAxisId="right" type="monotone" dataKey="roas" name="ROAS" stroke={NOBL_ACCENT} strokeWidth={2} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {channelNames.map(ch => <PillTab key={ch} label={ch} active={activeChannel === ch} onClick={() => setActiveChannel(ch)} />)}
              </div>
              <Card title={activeChannel || 'Channel'} subtitle={`${dates.length} days`}>
                <VerticalDataTable dates={dates} getRow={d => enrichChannelRow(channelByDateCh[`${d}|${activeChannel}`], activeChannel)} metrics={CHANNEL_METRICS} tableScope={commentTargetKey('channel', activeChannel)} />
              </Card>
            </>
          )}

          {activeView === 'geo' && (
            <>
              <div style={CHART_GRID}>
                <ChartCard title="Revenue by Region" subtitle="Period totals">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={geoAgg} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="region" tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize: 11 }} width={Y_AXIS_WIDTH_CURRENCY} stroke="var(--border2)" />
                      <Tooltip formatter={(v, n) => [fmt$(v), n]} contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="revenue" name="Revenue" radius={[4, 4, 0, 0]}>
                        {geoAgg.map((e, i) => <Cell key={i} fill={GEO_COL[i % GEO_COL.length]} />)}
                      </Bar>
                      <Bar dataKey="spend" name="Spend" radius={[4, 4, 0, 0]} fill="rgba(245,158,11,.7)" />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
                <ChartCard title="Regional MER" subtitle="Revenue ÷ spend">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={geoAgg} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="region" tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis tickFormatter={fmtAxisRatio} tick={{ fontSize: 11 }} width={Y_AXIS_WIDTH_RATIO} stroke="var(--border2)" />
                      <Tooltip formatter={(v) => fmtChartTooltip(v, 'MER')} contentStyle={TOOLTIP_STYLE} />
                      <Bar dataKey="mer" name="MER" radius={[4, 4, 0, 0]}>
                        {geoAgg.map((e, i) => <Cell key={i} fill={GEO_COL[i % GEO_COL.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {regionNames.map(r => <PillTab key={r} label={r} active={activeRegion === r} onClick={() => setActiveRegion(r)} />)}
              </div>
              <Card title={activeRegion || 'Region'} subtitle={`${dates.length} days`}>
                <VerticalDataTable dates={dates} getRow={d => enrichGeoRow(geoByDateRg[`${d}|${activeRegion}`])} metrics={GEO_METRICS} tableScope={commentTargetKey('geo', activeRegion)} />
              </Card>
            </>
          )}

          {activeView === 'subs' && (
            <>
              {subChartData.length > 0 && (
                <ChartCard title="Subscription Revenue Trend" subtitle="Daily sub, rebill & new sub revenue">
                  <ResponsiveContainer width="100%" height={240}>
                    <AreaChart data={subChartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize: 11 }} width={Y_AXIS_WIDTH_CURRENCY} stroke="var(--border2)" />
                      <Tooltip formatter={(v, n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="sub_revenue" name="Sub Revenue" stackId="sub" stroke={NOBL_ACCENT} fill="rgba(99,102,241,.35)" strokeWidth={1.5} />
                      <Area type="monotone" dataKey="rebill_revenue" name="Rebill Rev" stackId="sub" stroke="#14b8a6" fill="rgba(20,184,166,.35)" strokeWidth={1.5} />
                      <Area type="monotone" dataKey="new_sub_revenue" name="New Sub Rev" stackId="sub" stroke="#8b5cf6" fill="rgba(139,92,246,.35)" strokeWidth={1.5} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>
              )}
              <Card title="NOBL Air Subscriptions" subtitle={`${dates.length} days`}>
                <VerticalDataTable dates={dates} getRow={d => enrichSubsRow(subsByDate[d])} metrics={SUB_METRICS} tableScope="subs" />
              </Card>
            </>
          )}
        </>
      )}
    </div>
    </CommentProvider>
  );
}
