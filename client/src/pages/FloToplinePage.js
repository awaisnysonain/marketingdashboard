import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, Line, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import PageIntro from '../components/PageIntro';
import PageFilterBar from '../components/PageFilterBar';
import KpiCard from '../components/KpiCard';
import ChartCard from '../components/ChartCard';
import { getFloTopline, fmt$, fmtFull$, fmtNum, fmtFullNum } from '../utils/api';
import { TIP } from '../copy/plainLanguage';
import { mtdRange, sortByRevenueDesc } from '../utils/dateRange';
import {
  FLO_ACCENT, FLO_WARN, GEO_COL, PROD_COL, TOOLTIP_STYLE, CHART_GRID, mer, chColor,
} from '../utils/chartHelpers';
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

function fmtVal(v, type) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (type === '$') return '$' + Math.round(n).toLocaleString('en-US');
  if (type === '$2') return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (type === 'x') return n.toFixed(2) + 'x';
  return Math.round(n).toLocaleString('en-US');
}

const SUMMARY_METRICS = [
  { key: 'gross_minus_discounts',     label: 'Gross − Disc',     type: '$', tip: TIP.grossMinusDiscounts },
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
  { key: 'cac',             label: 'CAC',       type: '$2' },
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

function VerticalTable({ dates, getRow, metrics }) {
  return (
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
            {metrics.map((m) => (
              <th key={m.key} title={m.tip || undefined} style={{
                padding: '9px 12px', textAlign: 'right', borderBottom: '2px solid var(--border)',
                color: 'var(--text3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '.05em', whiteSpace: 'nowrap', cursor: m.tip ? 'help' : undefined,
              }}>{m.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...dates].reverse().map((d, di) => {
            const row = getRow(d);
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
                {metrics.map((m) => (
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
  );
}

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
      {onRetry && <button onClick={onRetry} style={{ marginLeft: 12, fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>}
    </div>
  );
}

export default function FloToplinePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [range, setRange] = useState(mtdRange());
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
    const summaryByDate = {};
    let totalRev = 0, totalGmd = 0, totalSpend = 0, totalOrders = 0, totalNew = 0;
    for (const r of (data.summary || [])) {
      summaryByDate[r.date] = r;
      totalRev += Number(r.order_revenue || r.total_revenue) || 0;
      totalGmd += Number(r.gross_minus_discounts) || 0;
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
    const prSet = new Set(), productByDatePr = {}, productRev = {};
    for (const r of (data.products || [])) {
      prSet.add(r.product_line);
      productByDatePr[`${r.date}|${r.product_line}`] = r;
      productRev[r.product_line] = (productRev[r.product_line] || 0) + (Number(r.revenue) || 0);
    }
    const allDates = [...new Set([...(data.summary || []).map(r => r.date), ...(data.channels || []).map(r => r.date)])].sort();
    const periodMer = totalSpend > 0 ? totalRev / totalSpend : 0;

    const chartData = allDates.map((d) => {
      const r = summaryByDate[d] || {};
      const rev = Number(r.order_revenue || r.total_revenue) || 0;
      const spend = Number(r.total_spend) || 0;
      return {
        date: d,
        order_revenue: rev,
        gross_minus_discounts: Number(r.gross_minus_discounts) || 0,
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
      summaryByDate,
      channelNames: sortByRevenueDesc(chSet, channelRev),
      channelByDateCh,
      regionNames: sortByRevenueDesc(rgSet, regionRev),
      geoByDateRg,
      productNames: sortByRevenueDesc(prSet, productRev),
      productByDatePr,
      kpi: { totalRev, totalGmd, totalSpend, mer: periodMer, totalOrders, totalNew },
      chartData,
      chAgg,
      geoAgg,
      prodAgg,
    };
  }, [data]);

  useEffect(() => { if (channelNames.length && !activeChannel) setActiveChannel(channelNames[0]); }, [channelNames, activeChannel]);
  useEffect(() => { if (regionNames.length && !activeRegion) setActiveRegion(regionNames[0]); }, [regionNames, activeRegion]);
  useEffect(() => { if (productNames.length && !activeProduct) setActiveProduct(productNames[0]); }, [productNames, activeProduct]);

  const VIEWS = [
    { id: 'summary', label: 'Summary' },
    { id: 'channels', label: 'Channels' },
    { id: 'geo', label: 'Geography' },
    { id: 'products', label: 'Products' },
  ];

  return (
    <div className="page-stack">
      <PageFilterBar start={range.start} end={range.end} onChange={setRange} />

      <PageIntro title="FLO Topline" desc="Daily topline performance for Pilates FLO — revenue, spend, MER, channel breakdowns, geo splits, and product line data." />

      {loading ? <Skeleton /> : error ? <ErrorBox msg={error} onRetry={load} /> : (
        <>
          <div className="page-kpi-grid">
            <KpiCard label="Gross − Discounts" value={fmt$(kpi.totalGmd)} fullValue={fmtFull$(kpi.totalGmd)} tooltip={TIP.grossMinusDiscounts} />
            <KpiCard label="Order Revenue" value={fmt$(kpi.totalRev)} fullValue={fmtFull$(kpi.totalRev)} tooltip={TIP.orderRevenue} />
            <KpiCard label="Total Spend" value={fmt$(kpi.totalSpend)} fullValue={fmtFull$(kpi.totalSpend)} tooltip={TIP.spend} />
            <KpiCard label="MER" value={kpi.mer.toFixed(2) + 'x'} tooltip={TIP.mer} />
            <KpiCard label="Total Orders" value={fmtNum(kpi.totalOrders)} fullValue={fmtFullNum(kpi.totalOrders)} tooltip={TIP.orders} />
            <KpiCard label="New Customers" value={fmtNum(kpi.totalNew)} fullValue={fmtFullNum(kpi.totalNew)} tooltip={TIP.ncOrders} />
          </div>

          <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
            {VIEWS.map(v => <PillTab key={v.id} label={v.label} active={activeView === v.id} onClick={() => setActiveView(v.id)} />)}
          </div>

          {activeView === 'summary' && (
            <>
              <div style={CHART_GRID}>
                <ChartCard title="Revenue & Gross − Discounts" subtitle="Daily trend">
                  <ResponsiveContainer width="100%" height={240}>
                    <AreaChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <defs>
                        <linearGradient id="floGradRev" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={FLO_ACCENT} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={FLO_ACCENT} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis tickFormatter={(v) => fmt$(v)} tick={{ fontSize: 11 }} width={72} stroke="var(--border2)" />
                      <Tooltip formatter={(v, n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="order_revenue" name="Order Revenue" stroke={FLO_ACCENT} fill="url(#floGradRev)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="gross_minus_discounts" name="Gross − Discounts" stroke="#6366f1" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>
                <ChartCard title="Spend vs Revenue" subtitle="MER context">
                  <ResponsiveContainer width="100%" height={240}>
                    <ComposedChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis tickFormatter={(v) => fmt$(v)} tick={{ fontSize: 11 }} width={72} stroke="var(--border2)" />
                      <Tooltip formatter={(v, n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="order_revenue" name="Order Revenue" stroke={FLO_ACCENT} fill="rgba(20,184,166,.12)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="total_spend" name="Spend" stroke={FLO_WARN} strokeWidth={2} strokeDasharray="5 3" dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
              <Card title="Daily Summary" subtitle={`${dates.length} days`}>
                <VerticalTable dates={dates} getRow={d => summaryByDate[d]} metrics={SUMMARY_METRICS} />
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
                      <XAxis type="number" tickFormatter={(v) => fmt$(v)} tick={{ fontSize: 10 }} stroke="var(--border2)" />
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
                      <YAxis yAxisId="left" tickFormatter={(v) => fmt$(v)} tick={{ fontSize: 10 }} width={70} stroke="var(--border2)" />
                      <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => v.toFixed(1) + 'x'} tick={{ fontSize: 10 }} width={44} stroke="var(--border2)" />
                      <Tooltip formatter={(v, n) => [n === 'ROAS' ? v.toFixed(2) + 'x' : fmt$(v), n]} contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar yAxisId="left" dataKey="spend" name="Spend" radius={[4, 4, 0, 0]}>
                        {chAgg.map((e, i) => <Cell key={i} fill={chColor(e.channel, FLO_WARN)} />)}
                      </Bar>
                      <Line yAxisId="right" type="monotone" dataKey="roas" name="ROAS" stroke={FLO_ACCENT} strokeWidth={2} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {channelNames.map(ch => <PillTab key={ch} label={ch} active={activeChannel === ch} onClick={() => setActiveChannel(ch)} />)}
              </div>
              <Card title={activeChannel || 'Channel'} subtitle={`${dates.length} days`}>
                <VerticalTable dates={dates} getRow={d => channelByDateCh[`${d}|${activeChannel}`]} metrics={CHANNEL_METRICS} />
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
                      <YAxis tickFormatter={(v) => fmt$(v)} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
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
                      <YAxis tickFormatter={(v) => v.toFixed(1) + 'x'} tick={{ fontSize: 11 }} width={44} stroke="var(--border2)" />
                      <Tooltip formatter={(v) => [v.toFixed(2) + 'x', 'MER']} contentStyle={TOOLTIP_STYLE} />
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
                <VerticalTable dates={dates} getRow={d => geoByDateRg[`${d}|${activeRegion}`]} metrics={GEO_METRICS} />
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
                      <XAxis type="number" tickFormatter={(v) => fmt$(v)} tick={{ fontSize: 10 }} stroke="var(--border2)" />
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
                      <YAxis tickFormatter={(v) => v.toFixed(1) + 'x'} tick={{ fontSize: 11 }} width={44} stroke="var(--border2)" />
                      <Tooltip formatter={(v) => [v.toFixed(2) + 'x', 'MER']} contentStyle={TOOLTIP_STYLE} />
                      <Bar dataKey="mer" name="MER" radius={[4, 4, 0, 0]}>
                        {prodAgg.map((e, i) => <Cell key={i} fill={PROD_COL[e.line] || FLO_ACCENT} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {productNames.map(p => <PillTab key={p} label={p} active={activeProduct === p} onClick={() => setActiveProduct(p)} />)}
              </div>
              <Card title={activeProduct || 'Product'} subtitle={`${dates.length} days`}>
                <VerticalTable dates={dates} getRow={d => productByDatePr[`${d}|${activeProduct}`]} metrics={PRODUCT_METRICS} />
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
