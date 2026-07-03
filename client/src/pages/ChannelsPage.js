import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import { getChannels, fmt$, fmtRatio } from '../utils/api';
import KpiCard from '../components/KpiCard';
import ChartPanel from '../components/ChartPanel';
import PaginatedSheetTable from '../components/PaginatedSheetTable';
import { CommentProvider } from '../components/CommentProvider';
import { commentTargetKey } from '../utils/commentKeys';
import { entityDateCellKey, entityDateCellLabel } from '../utils/sheetComments';
import { L, TIP } from '../copy/plainLanguage';
import { useDashboardFilters } from '../context/DashboardFilterContext';
import { filterByBrands } from '../constants/dashboardFilters';
import { TOOLTIP_STYLE } from '../utils/chartHelpers';
function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo)-1]} ${parseInt(dy)}`;
}

const CHANNEL_COLORS = {
  META: '#1877f2', GOOGLE: '#ea4335', TIKTOK: '#010101',
  SNAPCHAT: '#fffc00', PINTEREST: '#e60023', APPLOVIN: '#ff8c00',
  BING: '#00809d', X: '#000000',
};

const BRANDS = ['Both', 'NOBL', 'FLO'];

export default function ChannelsPage({ showToast }) {
  const { dateRange, brands, brandsApi, regionsParam, isAllRegions, filterByChannels } = useDashboardFilters();
  const [rawRows, setRawRows] = useState([]);
  const [regionScoped, setRegionScoped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await getChannels(dateRange.start, dateRange.end, brandsApi.channels, isAllRegions ? '' : regionsParam);
      setRawRows(data.rows || []);
      setRegionScoped(!!data.region_scoped);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, [dateRange, brandsApi.channels, regionsParam, isAllRegions]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const byBrand = filterByBrands(rawRows, 'brand', brands);
    return regionScoped ? byBrand : filterByChannels(byBrand, 'channel');
  }, [rawRows, brands, filterByChannels, regionScoped]);

  // Aggregate KPIs by channel
  const channelAgg = {};
  for (const r of rows) {
    const ch = r.channel;
    if (!channelAgg[ch]) channelAgg[ch] = { spend: 0, revenue: 0, roas_vals: [], orders: 0 };
    channelAgg[ch].spend += r.spend_1d || 0;
    channelAgg[ch].revenue += r.revenue_1d || 0;
    if (r.roas_1d) channelAgg[ch].roas_vals.push(r.roas_1d);
    channelAgg[ch].orders += r.new_cust_orders || 0;
  }
  const channelKpis = Object.entries(channelAgg).map(([ch, v]) => ({
    channel: ch,
    total_spend: v.spend,
    total_revenue: v.revenue,
    avg_roas: v.roas_vals.length ? v.roas_vals.reduce((a,b)=>a+b,0)/v.roas_vals.length : 0,
    total_orders: v.orders,
  })).sort((a,b) => b.total_revenue - a.total_revenue);

  // Spend stacked bar: group by date, series by channel
  const dateMap = {};
  for (const r of rows) {
    if (!dateMap[r.date]) dateMap[r.date] = { date: r.date };
    dateMap[r.date][r.channel] = (dateMap[r.date][r.channel] || 0) + (r.spend_1d || 0);
  }
  const chartData = Object.values(dateMap).sort((a,b) => String(a.date).localeCompare(String(b.date)));
  const channels = [...new Set(rows.map(r => r.channel))];

  const totSpend = channelKpis.reduce((s,r) => s + r.total_spend, 0);
  const totRev = channelKpis.reduce((s,r) => s + r.total_revenue, 0);

  // Prepare rows for SheetTable
  const CH_HEADERS = [L.date, 'Brand', 'Channel', L.spend, L.revenue, L.roas, 'Ad spend (7 days)', L.newOrders, L.cac];
  const sheetRows = rows.map(r => ({
    [L.date]:       r.date,
    'Brand':      r.brand,
    'Channel':    r.channel,
    [L.spend]:      r.spend_1d,
    [L.revenue]:    r.revenue_1d,
    [L.roas]:       r.roas_1d,
    'Ad spend (7 days)':   r.spend_7d,
    [L.newOrders]: r.new_cust_orders,
    [L.cac]:        r.cac,
    _date: r.date,
  }));

  return (
    <CommentProvider pageKey="channels">
    <div className="page-stack">
      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          {regionScoped && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 10, background: 'var(--warn-dim)', border: '1px solid rgba(176,125,24,.28)', color: 'var(--text2)', fontSize: 12, lineHeight: 1.5 }}>
              <span style={{ flexShrink: 0 }}>🌍</span>
              <span>Showing region-level spend/revenue totals because channel-by-region grain is not available. Switch Region to <strong style={{ color: 'var(--text)' }}>All regions</strong> for platform channel splits.</span>
            </div>
          )}
          <div className="section">
            <div className="section__title">{regionScoped ? 'BY REGION' : 'BY CHANNEL'}</div>
            <div className="page-kpi-grid">
              {channelKpis.slice(0, 6).map(ch => (
                <KpiCard
                  key={ch.channel}
                  label={ch.channel}
                  value={fmt$(ch.total_spend)}
                  sub={`Sales: ${fmt$(ch.total_revenue)} · Return: ${fmtRatio(ch.avg_roas)} per ad $`}
                  color={CHANNEL_COLORS[ch.channel] || '#888'}
                />
              ))}
            </div>
          </div>

          <div className="section">
            <div className="section__title">BLENDED TOTALS</div>
            <div className="page-kpi-grid">
              <KpiCard label="Total ad spend" value={fmt$(totSpend)} fullValue={fmt$(totSpend)} tooltip={TIP.spend} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_spend'), targetLabel: 'Total Ad Spend' }} />
              <KpiCard label="Total sales" value={fmt$(totRev)} fullValue={fmt$(totRev)} tooltip={TIP.revenue} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_revenue'), targetLabel: 'Total Sales' }} />
              <KpiCard label={L.blendedMer} value={totSpend > 0 ? fmtRatio(totRev/totSpend) : '—'} copyValue={totSpend > 0 ? (totRev/totSpend).toFixed(4) : undefined} tooltip={TIP.mer} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('blended_mer'), targetLabel: L.blendedMer }} />
            </div>
          </div>

          {/* Stacked spend chart */}
          <ChartPanel title="Ad spend by channel over time" subtitle="Daily ad spend split by marketing channel">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                <YAxis tickFormatter={v => fmt$(v)} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
                <Tooltip formatter={(v,n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {channels.map(ch => (
                  <Bar key={ch} dataKey={ch} name={ch} stackId="spend" fill={CHANNEL_COLORS[ch] || '#888'} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>

          {/* Channel Detail Table */}
          <ChartPanel title="Channel Detail" subtitle="Click cells · shift+click range · ctrl+C copy">
            <PaginatedSheetTable
              headers={CH_HEADERS}
              rows={sheetRows}
              resetDeps={[dateRange.start, dateRange.end, brands.join(','), regionsParam, regionScoped]}
              defaultSortField={L.date}
              defaultSortDir="desc"
              searchable={true}
              getCellCommentKey={(row, h) => entityDateCellKey('channel', row, h, 'Channel', L.date)}
              getCellCommentLabel={(row, h) => entityDateCellLabel('channel', h, row, 'Channel', L.date)}
            />
          </ChartPanel>
        </>
      )}
    </div>
    </CommentProvider>
  );
}

function Skeleton() {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[...Array(6)].map((_, i) => <div key={i} style={{ height: 80, background: 'var(--bg3)', borderRadius: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />)}
      </div>
      <div style={{ height: 280, background: 'var(--bg2)', borderRadius: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />
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
