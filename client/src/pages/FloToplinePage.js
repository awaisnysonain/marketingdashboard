import React, { useState, useEffect, useMemo, useCallback } from 'react';
import PageIntro from '../components/PageIntro';
import KpiCard from '../components/KpiCard';
import DateRangePicker from '../components/DateRangePicker';
import { getFloTopline, fmt$, fmtFull$, fmtNum, fmtFullNum } from '../utils/api';

function toISO(d) { return d.toISOString().slice(0, 10); }
function mtdRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { start: toISO(start), end: toISO(now) };
}
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
  { key: 'total_revenue',             label: 'Revenue',          type: '$' },
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
            {metrics.map((m, i) => (
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
  const [range, setRange] = useState(mtdRange);
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

  const { dates, summaryByDate, channelNames, channelByDateCh, regionNames, geoByDateRg, productNames, productByDatePr, kpi } = useMemo(() => {
    if (!data) return { dates: [], summaryByDate: {}, channelNames: [], channelByDateCh: {}, regionNames: [], geoByDateRg: {}, productNames: [], productByDatePr: {}, kpi: {} };
    const summaryByDate = {};
    let totalRev = 0, totalSpend = 0, totalOrders = 0, totalNew = 0;
    for (const r of (data.summary || [])) { summaryByDate[r.date] = r; totalRev += Number(r.total_revenue) || 0; totalSpend += Number(r.total_spend) || 0; totalOrders += Number(r.total_orders) || 0; totalNew += Number(r.new_customer_orders) || 0; }
    const chSet = new Set(), channelByDateCh = {};
    for (const r of (data.channels || [])) { chSet.add(r.channel); channelByDateCh[`${r.date}|${r.channel}`] = r; }
    const rgSet = new Set(), geoByDateRg = {};
    for (const r of (data.geo || [])) { rgSet.add(r.region); geoByDateRg[`${r.date}|${r.region}`] = r; }
    const prSet = new Set(), productByDatePr = {};
    for (const r of (data.products || [])) { prSet.add(r.product_line); productByDatePr[`${r.date}|${r.product_line}`] = r; }
    const allDates = [...new Set([...(data.summary || []).map(r => r.date), ...(data.channels || []).map(r => r.date)])].sort();
    const mer = totalSpend > 0 ? totalRev / totalSpend : 0;
    return { dates: allDates, summaryByDate, channelNames: [...chSet].sort(), channelByDateCh, regionNames: [...rgSet].sort(), geoByDateRg, productNames: [...prSet].sort(), productByDatePr, kpi: { totalRev, totalSpend, mer, totalOrders, totalNew } };
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
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
        <PageIntro title="FLO Topline" desc="Daily topline performance for Pilates FLO — revenue, spend, MER, channel breakdowns, geo splits, and product line data." />
        <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
      </div>

      {loading ? <Skeleton /> : error ? <ErrorBox msg={error} onRetry={load} /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginBottom: 20 }}>
            <KpiCard label="Total Revenue" value={fmt$(kpi.totalRev)} fullValue={fmtFull$(kpi.totalRev)} />
            <KpiCard label="Total Spend" value={fmt$(kpi.totalSpend)} fullValue={fmtFull$(kpi.totalSpend)} />
            <KpiCard label="MER" value={kpi.mer.toFixed(2) + 'x'} />
            <KpiCard label="Total Orders" value={fmtNum(kpi.totalOrders)} fullValue={fmtFullNum(kpi.totalOrders)} />
            <KpiCard label="New Customers" value={fmtNum(kpi.totalNew)} fullValue={fmtFullNum(kpi.totalNew)} />
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 18, borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
            {VIEWS.map(v => <PillTab key={v.id} label={v.label} active={activeView === v.id} onClick={() => setActiveView(v.id)} />)}
          </div>

          {activeView === 'summary' && (
            <Card title="Daily Summary" subtitle={`${dates.length} days`}>
              <VerticalTable dates={dates} getRow={d => summaryByDate[d]} metrics={SUMMARY_METRICS} />
            </Card>
          )}
          {activeView === 'channels' && (
            <>
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
