import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Area, BarChart, Bar, Line, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import PageIntro from '../components/PageIntro';
import { useDashboardFilters } from '../context/DashboardFilterContext';
import KpiCard from '../components/KpiCard';
import ChartCard from '../components/ChartCard';
import VerticalDataTable from '../components/VerticalDataTable';
import { CommentProvider } from '../components/CommentProvider';
import { commentTargetKey } from '../utils/commentKeys';
import { getFloTopline, fmt$, fmtFull$, fmtNum, fmtFullNum, fmtRatio } from '../utils/api';
import useDailyForecast from '../hooks/useDailyForecast';
import { ForecastVsBadge } from '../components/ForecastIndicator';
import ForecastChartTooltip from '../components/ForecastChartTooltip';
import { buildOrderRevenueCellStatus } from '../utils/forecastCellStatus';
import { TIP } from '../copy/plainLanguage';
import { sortByRevenueDesc } from '../utils/dateRange';
import {
  enrichSummaryRow, enrichChannelRow, enrichGeoRow, enrichProductRow, mergeToplineDates,
} from '../utils/toplineData';
import {
  FLO_ACCENT, FLO_WARN, GEO_COL, PROD_COL, TOOLTIP_STYLE, CHART_GRID, mer, chColor,
  Y_AXIS_WIDTH_CURRENCY, Y_AXIS_WIDTH_RATIO, fmtChartTooltip, fmtAxisCurrency, fmtAxisRatio,
} from '../utils/chartHelpers';

const PAGE_KEY = 'flo-topline';

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

const SUMMARY_METRICS = [
  { key: 'order_revenue',             label: 'Order Revenue',    type: '$', tip: TIP.orderRevenue },
  { key: 'total_spend',               label: 'Spend',            type: '$' },
  { key: 'mer',                       label: 'MER',              type: 'x' },
  { key: 'total_orders',              label: 'Orders',           type: 'num' },
  { key: 'new_customer_orders',       label: 'New Cust',         type: 'num' },
  { key: 'returning_customer_orders', label: 'Returning',        type: 'num' },
  { key: 'shopify_revenue',           label: 'Shopify Rev',      type: '$' },
  { key: 'amazon_revenue',            label: 'Amazon Rev',       type: '$' },
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
const PRODUCT_METRICS = [
  { key: 'spend',           label: 'Spend',          type: '$' },
  { key: 'revenue',         label: 'Revenue',        type: '$' },
  { key: 'new_cust_orders', label: 'New Cust',       type: 'num' },
  { key: 'meta_spend',      label: 'Meta Spend',     type: '$' },
  { key: 'google_spend',    label: 'Google Spend',   type: '$' },
  { key: 'tiktok_spend',    label: 'TikTok Spend',   type: '$' },
  { key: 'applovin_spend',  label: 'Applovin Spend', type: '$' },
];

function Skeleton() {
  return (
    <div style={{ padding: '60px 0', textAlign: 'center' }}>
      <div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .8s linear infinite', margin: '0 auto 12px' }} />
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>Loading FLO Topline...</div>
    </div>
  );
}

function ErrorBox({ msg, onRetry }) {
  return (
    <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.25)', borderRadius: 12, padding: '16px 20px', fontSize: 13, color: 'var(--danger)' }}>
      Failed to load data: {msg}
      {onRetry && <button onClick={onRetry} className="btn btn--primary btn--sm" style={{ marginLeft: 12 }}>Retry</button>}
    </div>
  );
}

export default function FloToplinePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { dateRange, filterByChannels, filterByRegions, isAllRegions } = useDashboardFilters();
  const range = dateRange;
  const [activeView, setActiveView] = useState('summary');
  const [activeChannel, setActiveChannel] = useState(null);
  const [activeRegion, setActiveRegion] = useState(null);
  const [activeProduct, setActiveProduct] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getFloTopline(range.start, range.end)
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const { dates, summaryByDate, channelNames, channelByDateCh, regionNames, geoByDateRg, productNames, productByDatePr, kpi, chartData, chAgg, geoAgg, prodAgg } = useMemo(() => {
    if (!data) return { dates: [], summaryByDate: {}, channelNames: [], channelByDateCh: {}, regionNames: [], geoByDateRg: {}, productNames: [], productByDatePr: {}, kpi: {}, chartData: [], chAgg: [], geoAgg: [], prodAgg: [] };
    const channelsData = filterByChannels(data.channels || [], 'channel');
    const geoData = filterByRegions(data.geo || [], 'region');
    const summaryByDate = {};
    let totalRev = 0, totalSpend = 0, totalOrders = 0, totalNew = 0;
    for (const r of (data.summary || [])) {
      summaryByDate[r.date] = r;
      if (isAllRegions) {
        totalRev += Number(r.order_revenue || r.total_revenue) || 0;
        totalSpend += Number(r.total_spend) || 0;
        totalOrders += Number(r.total_orders) || 0;
        totalNew += Number(r.new_customer_orders) || 0;
      }
    }
    if (!isAllRegions) {
      for (const r of geoData) {
        totalRev += Number(r.revenue_actual || r.revenue) || 0;
        totalSpend += Number(r.spend_actual || r.spend) || 0;
      }
    }
    const chSet = new Set(), channelByDateCh = {}, channelRev = {};
    for (const r of channelsData) {
      chSet.add(r.channel);
      channelByDateCh[`${r.date}|${r.channel}`] = r;
      channelRev[r.channel] = (channelRev[r.channel] || 0) + (Number(r.revenue_1d) || 0);
    }
    const rgSet = new Set(), geoByDateRg = {}, regionRev = {}, regionalSummaryByDate = {};
    for (const r of geoData) {
      rgSet.add(r.region);
      geoByDateRg[`${r.date}|${r.region}`] = r;
      regionRev[r.region] = (regionRev[r.region] || 0) + (Number(r.revenue_actual || r.revenue) || 0);
      if (!regionalSummaryByDate[r.date]) regionalSummaryByDate[r.date] = { date: r.date, order_revenue: 0, total_revenue: 0, total_spend: 0, mer: null };
      regionalSummaryByDate[r.date].order_revenue += Number(r.revenue_actual || r.revenue) || 0;
      regionalSummaryByDate[r.date].total_revenue += Number(r.revenue_actual || r.revenue) || 0;
      regionalSummaryByDate[r.date].total_spend += Number(r.spend_actual || r.spend) || 0;
    }
    const prSet = new Set(), productByDatePr = {}, productRev = {};
    for (const r of (data.products || [])) {
      prSet.add(r.product_line);
      productByDatePr[`${r.date}|${r.product_line}`] = r;
      productRev[r.product_line] = (productRev[r.product_line] || 0) + (Number(r.revenue) || 0);
    }
    const allDates = mergeToplineDates(data.summary, channelsData, geoData, data.products);
    const periodMer = totalSpend > 0 ? totalRev / totalSpend : 0;

    const effectiveSummaryByDate = isAllRegions ? summaryByDate : regionalSummaryByDate;
    for (const r of Object.values(effectiveSummaryByDate)) {
      r.mer = Number(r.total_spend) > 0 ? Number(r.order_revenue || r.total_revenue || 0) / Number(r.total_spend) : null;
    }

    const chartData = allDates.map((d) => {
      const r = effectiveSummaryByDate[d] || {};
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
    for (const r of channelsData) {
      if (!chMap[r.channel]) chMap[r.channel] = { channel: r.channel, spend: 0, revenue: 0 };
      chMap[r.channel].spend += Number(r.spend_1d) || 0;
      chMap[r.channel].revenue += Number(r.revenue_1d) || 0;
    }
    const chAgg = Object.values(chMap)
      .map((v) => ({ ...v, roas: mer(v.revenue, v.spend) }))
      .sort((a, b) => b.revenue - a.revenue);

    const geoMap = {};
    for (const r of geoData) {
      if (!geoMap[r.region]) geoMap[r.region] = { region: r.region, revenue: 0, spend: 0 };
      geoMap[r.region].revenue += Number(r.revenue_actual || r.revenue) || 0;
      geoMap[r.region].spend += Number(r.spend_actual || r.spend) || 0;
    }
    const geoAgg = Object.values(geoMap)
      .map((v) => ({ ...v, mer: mer(v.revenue, v.spend) }))
      .sort((a, b) => b.revenue - a.revenue);

    const prodMap = {};
    for (const r of (data.products || [])) {
      const pl = r.product_line;
      if (!prodMap[pl]) prodMap[pl] = { line: pl, spend: 0, revenue: 0 };
      prodMap[pl].spend += Number(r.spend) || 0;
      prodMap[pl].revenue += Number(r.revenue) || 0;
    }
    const prodAgg = Object.values(prodMap)
      .map((v) => ({ ...v, mer: mer(v.revenue, v.spend) }))
      .sort((a, b) => b.revenue - a.revenue);

    return {
      dates: allDates,
      summaryByDate: effectiveSummaryByDate,
      channelNames: sortByRevenueDesc(chSet, channelRev),
      channelByDateCh,
      regionNames: sortByRevenueDesc(rgSet, regionRev),
      geoByDateRg,
      productNames: sortByRevenueDesc(prSet, productRev),
      productByDatePr,
      // Orders / new-customers aren't region-split in the geo table → null ("—") under a region filter.
      kpi: { totalRev, totalSpend, mer: periodMer, totalOrders: isAllRegions ? totalOrders : null, totalNew: isAllRegions ? totalNew : null },
      chartData,
      chAgg,
      geoAgg,
      prodAgg,
    };
  }, [data, filterByChannels, filterByRegions, isAllRegions]);

  useEffect(() => { if (channelNames.length && (!activeChannel || !channelNames.includes(activeChannel))) setActiveChannel(channelNames[0]); }, [channelNames, activeChannel]);
  useEffect(() => { if (regionNames.length && (!activeRegion || !regionNames.includes(activeRegion))) setActiveRegion(regionNames[0]); }, [regionNames, activeRegion]);
  useEffect(() => { if (productNames.length && (!activeProduct || !productNames.includes(activeProduct))) setActiveProduct(productNames[0]); }, [productNames, activeProduct]);

  // Daily forecast (brand-level) → red/green vs each day's order revenue.
  const fc = useDailyForecast('FLO', range.start, range.end);
  const revChartData = useMemo(
    () => chartData.map((p) => ({ ...p, forecast: fc.forecastForDate(p.date) })),
    [chartData, fc],
  );
  const summaryCellStatus = useCallback(buildOrderRevenueCellStatus(fc), [fc]);
  const fcPeriod = useMemo(() => {
    let a = 0; let f = 0; let has = false;
    for (const d of dates) {
      const row = summaryByDate[d];
      const actual = row ? Number(row.order_revenue ?? row.total_revenue) : null;
      const forecast = fc.forecastForDate(d);
      if (actual != null && Number.isFinite(actual) && forecast != null) { a += actual; f += forecast; has = true; }
    }
    return has ? { actual: a, forecast: f } : null;
  }, [dates, summaryByDate, fc]);

  const VIEWS = [
    { id: 'summary', label: 'Summary' },
    { id: 'channels', label: 'Channels' },
    { id: 'geo', label: 'Geography' },
    { id: 'products', label: 'Products' },
  ];

  return (
    <CommentProvider pageKey={PAGE_KEY}>
    <div className="page-stack">
      <PageIntro
        actions={(
          <div className="seg">
            {VIEWS.map(v => (
              <button
                key={v.id}
                type="button"
                className={`seg__btn${activeView === v.id ? ' seg__btn--active' : ''}`}
                onClick={() => setActiveView(v.id)}
              >{v.label}</button>
            ))}
          </div>
        )}
      />

      {loading ? <Skeleton /> : error ? <ErrorBox msg={error} onRetry={load} /> : (
        <>
          <div className="section">
            <div className="section__title">TOPLINE</div>
            <div className="page-kpi-grid">
              <KpiCard label="Order Revenue" value={fmt$(kpi.totalRev)} fullValue={fmtFull$(kpi.totalRev)} tooltip={TIP.orderRevenue} accent="flo" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('order_revenue'), targetLabel: 'Order Revenue' }} />
              <KpiCard label="Total Spend" value={fmt$(kpi.totalSpend)} fullValue={fmtFull$(kpi.totalSpend)} tooltip={TIP.spend} accent="flo" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_spend'), targetLabel: 'Total Spend' }} />
              <KpiCard label="MER" value={fmtRatio(kpi.mer)} copyValue={kpi.mer != null ? Number(kpi.mer).toFixed(4) : undefined} tooltip={TIP.mer} accent="flo" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('mer'), targetLabel: 'MER' }} />
              <KpiCard label="Total Orders" value={kpi.totalOrders == null ? '—' : fmtNum(kpi.totalOrders)} fullValue={kpi.totalOrders == null ? 'Not broken out by region' : fmtFullNum(kpi.totalOrders)} sub={kpi.totalOrders == null ? 'n/a by region' : undefined} tooltip={TIP.orders} accent="flo" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_orders'), targetLabel: 'Total Orders' }} />
              <KpiCard label="New Customers" value={kpi.totalNew == null ? '—' : fmtNum(kpi.totalNew)} fullValue={kpi.totalNew == null ? 'Not broken out by region' : fmtFullNum(kpi.totalNew)} sub={kpi.totalNew == null ? 'n/a by region' : undefined} tooltip={TIP.ncOrders} accent="flo" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('new_customers'), targetLabel: 'New Customers' }} />
            </div>
          </div>

          {activeView === 'summary' && (
            <>
              <div style={CHART_GRID}>
                <ChartCard title="Order Revenue" subtitle="Daily trend vs forecast">
                  <ResponsiveContainer width="100%" height={240}>
                    <ComposedChart data={revChartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <defs>
                        <linearGradient id="floGradRev" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={FLO_ACCENT} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={FLO_ACCENT} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize: 11 }} width={Y_AXIS_WIDTH_CURRENCY} stroke="var(--border2)" />
                      <Tooltip content={<ForecastChartTooltip fc={fc} labelFormatter={fmtDateLabel} formatter={(v) => fmt$(v)} />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="order_revenue" name="Order Revenue" stroke={FLO_ACCENT} fill="url(#floGradRev)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="forecast" name="Forecast" stroke={FLO_WARN} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
                    </ComposedChart>
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
                      <Area type="monotone" dataKey="order_revenue" name="Order Revenue" stroke={FLO_ACCENT} fill="rgba(20,184,166,.12)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="total_spend" name="Spend" stroke={FLO_WARN} strokeWidth={2} strokeDasharray="5 3" dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
              <Card title="Daily Summary" subtitle={`${dates.length} days`}>
                {fcPeriod && (
                  <div style={{ marginBottom: 10 }}>
                    <ForecastVsBadge actual={fcPeriod.actual} forecast={fcPeriod.forecast} />
                  </div>
                )}
                <VerticalDataTable dates={dates} getRow={d => enrichSummaryRow(summaryByDate[d])} metrics={SUMMARY_METRICS} tableScope="summary" cellStatus={summaryCellStatus} />
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
                        {chAgg.map((e, i) => <Cell key={i} fill={chColor(e.channel, FLO_ACCENT)} />)}
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
                        {chAgg.map((e, i) => <Cell key={i} fill={chColor(e.channel, FLO_WARN)} />)}
                      </Bar>
                      <Line yAxisId="right" type="monotone" dataKey="roas" name="ROAS" stroke={FLO_ACCENT} strokeWidth={2} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
              <div className="section">
                <div className="section__title">CHANNEL</div>
                <div className="seg" style={{ flexWrap: 'wrap' }}>
                  {channelNames.map(ch => (
                    <button key={ch} type="button" className={`seg__btn${activeChannel === ch ? ' seg__btn--active' : ''}`} onClick={() => setActiveChannel(ch)}>{ch}</button>
                  ))}
                </div>
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
              <div className="section">
                <div className="section__title">REGION</div>
                <div className="seg" style={{ flexWrap: 'wrap' }}>
                  {regionNames.map(r => (
                    <button key={r} type="button" className={`seg__btn${activeRegion === r ? ' seg__btn--active' : ''}`} onClick={() => setActiveRegion(r)}>{r}</button>
                  ))}
                </div>
              </div>
              <Card title={activeRegion || 'Region'} subtitle={`${dates.length} days`}>
                <VerticalDataTable dates={dates} getRow={d => enrichGeoRow(geoByDateRg[`${d}|${activeRegion}`])} metrics={GEO_METRICS} tableScope={commentTargetKey('geo', activeRegion)} />
              </Card>
            </>
          )}
          {activeView === 'products' && (
            <>
              <div style={CHART_GRID}>
                <ChartCard title="Product Line Revenue" subtitle="Period totals">
                  <ResponsiveContainer width="100%" height={Math.max(160, prodAgg.length * 40)}>
                    <BarChart data={prodAgg} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis type="number" tickFormatter={fmtAxisCurrency} tick={{ fontSize: 10 }} stroke="var(--border2)" />
                      <YAxis dataKey="line" type="category" tick={{ fontSize: 11, fontWeight: 600 }} width={80} stroke="var(--border2)" />
                      <Tooltip formatter={(v, n) => [fmt$(v), n]} contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="revenue" name="Revenue" radius={[0, 4, 4, 0]} maxBarSize={18}>
                        {prodAgg.map((e, i) => <Cell key={i} fill={PROD_COL[e.line] || FLO_ACCENT} />)}
                      </Bar>
                      <Bar dataKey="spend" name="Spend" radius={[0, 4, 4, 0]} maxBarSize={18} fill="rgba(245,158,11,.65)" />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
                <ChartCard title="Product Line MER" subtitle="Revenue ÷ spend">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={prodAgg} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="line" tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis tickFormatter={fmtAxisRatio} tick={{ fontSize: 11 }} width={Y_AXIS_WIDTH_RATIO} stroke="var(--border2)" />
                      <Tooltip formatter={(v) => fmtChartTooltip(v, 'MER')} contentStyle={TOOLTIP_STYLE} />
                      <Bar dataKey="mer" name="MER" radius={[4, 4, 0, 0]}>
                        {prodAgg.map((e, i) => <Cell key={i} fill={PROD_COL[e.line] || FLO_ACCENT} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
              <div className="section">
                <div className="section__title">PRODUCT LINE</div>
                <div className="seg" style={{ flexWrap: 'wrap' }}>
                  {productNames.map(p => (
                    <button key={p} type="button" className={`seg__btn${activeProduct === p ? ' seg__btn--active' : ''}`} onClick={() => setActiveProduct(p)}>{p}</button>
                  ))}
                </div>
              </div>
              <Card title={activeProduct || 'Product'} subtitle={`${dates.length} days`}>
                <VerticalDataTable dates={dates} getRow={d => enrichProductRow(productByDatePr[`${d}|${activeProduct}`])} metrics={PRODUCT_METRICS} tableScope={commentTargetKey('product', activeProduct)} />
              </Card>
            </>
          )}
        </>
      )}
    </div>
    </CommentProvider>
  );
}
