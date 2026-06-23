import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import { useDashboardFilters } from '../context/DashboardFilterContext';
import KpiCard from '../components/KpiCard';
import ChartCard from '../components/ChartCard';
import ChartPanel from '../components/ChartPanel';
import VerticalDataTable from '../components/VerticalDataTable';
import { CommentProvider } from '../components/CommentProvider';
import { commentTargetKey } from '../utils/commentKeys';
import useDailyForecast from '../hooks/useDailyForecast';
import { buildForecastCellStatus } from '../utils/forecastCellStatus';
import { getChannels, fmt$, fmtFull$, fmtNum, fmtFullNum, fmtRatio } from '../utils/api';
import { TIP } from '../copy/plainLanguage';
import { sortByRevenueDesc } from '../utils/dateRange';
import { enrichChannelRow } from '../utils/toplineData';
import { NOBL_ACCENT, TOOLTIP_STYLE, CHART_GRID, mer, chColor, fmtAxisCurrency, fmtAxisRatio, Y_AXIS_WIDTH_RATIO } from '../utils/chartHelpers';
function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo, 10) - 1]} ${parseInt(dy, 10)}`;
}

const PAGE_KEY = 'nobl-channel-daily';

const METRICS = [
  { key: 'spend_1d',        label: 'Spend',           type: '$' },
  { key: 'revenue_1d',      label: 'Revenue',         type: '$' },
  { key: 'purchases_1d',    label: 'Purchases',       type: 'num' },
  { key: 'roas_1d',         label: 'ROAS',            type: 'x' },
  { key: 'cac',             label: 'CAC',             type: '$' },
  { key: 'new_cust_orders', label: 'New Cust Orders', type: 'num' },
];

const FORECAST_METRIC_MAP = {
  'Spend (1d)': 'spend',
  'Revenue (1d)': 'revenue',
  spend_1d: 'spend',
  revenue_1d: 'revenue',
  'Ad spend': 'spend',
  Sales: 'revenue',
  Revenue: 'revenue',
};

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
      {onRetry && <button onClick={onRetry} className="btn btn--primary btn--sm" style={{ marginLeft: 12 }}>Retry</button>}
    </div>
  );
}

export default function NoblChannelDailyPage() {
  const [rawRows, setRawRows] = useState([]);
  const [regionScoped, setRegionScoped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { dateRange, filterByChannels, regionsParam, isAllRegions } = useDashboardFilters();
  const range = dateRange;
  const [activeChannel, setActiveChannel] = useState(null);

  const fc = useDailyForecast('NOBL', dateRange.start, dateRange.end);
  const cellStatus = useCallback(
    buildForecastCellStatus(fc, { metrics: FORECAST_METRIC_MAP }),
    [fc],
  );

  const load = useCallback(() => {
    setLoading(true); setError(null);
    getChannels(range.start, range.end, 'NOBL', isAllRegions ? '' : regionsParam)
      .then(d => { setRawRows(d.rows || []); setRegionScoped(!!d.region_scoped); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [range, regionsParam, isAllRegions]);
  useEffect(() => { load(); }, [load]);

  // Reset the active selection whenever scope changes so a stale channel/region
  // name doesn't linger after switching regions.
  useEffect(() => { setActiveChannel(null); }, [regionsParam, isAllRegions]);

  const rows = useMemo(
    // When a region is selected the rows are region series (not channels), so the
    // channel filter must not be applied or everything would be filtered out.
    () => (regionScoped ? rawRows : filterByChannels(rawRows, 'channel')),
    [rawRows, filterByChannels, regionScoped],
  );

  const { channelNames, dates, byDateCh, chKpi, spendChartData, revChartData, channelTotals } = useMemo(() => {
    const chSet = new Set(), dateSet = new Set(), byDateCh = {}, chTotals = {};
    const dateMapSpend = {}, dateMapRev = {};
    for (const r of rows) {
      chSet.add(r.channel); dateSet.add(r.date);
      byDateCh[`${r.date}|${r.channel}`] = enrichChannelRow(r, r.channel);
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
    <CommentProvider pageKey={PAGE_KEY}>
    <div className="page-stack">
      {loading ? <Skeleton /> : error ? <ErrorBox msg={error} onRetry={load} /> : (
        <>
          {regionScoped && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 10, background: 'var(--warn-dim)', border: '1px solid rgba(176,125,24,.28)', color: 'var(--text2)', fontSize: 12, lineHeight: 1.5 }}>
              <span style={{ flexShrink: 0 }}>🌍</span>
              <span>
                Showing <strong style={{ color: 'var(--text)' }}>region-level</strong> daily totals (spend, revenue, MER) from regional data —
                channel-by-platform breakdown is not tracked per region. Switch Region to <strong>All regions</strong> for the full channel split.
              </span>
            </div>
          )}
          <div className="section">
            <div className="section__title">{regionScoped ? 'REGION' : 'CHANNEL'}</div>
            <div className="seg" style={{ flexWrap: 'wrap' }}>
              {channelNames.map(ch => (
                <button
                  key={ch}
                  type="button"
                  className={`seg__btn${activeChannel === ch ? ' seg__btn--active' : ''}`}
                  onClick={() => setActiveChannel(ch)}
                >{ch}</button>
              ))}
            </div>
          </div>

          <div className="section">
            <div className="section__title">{activeChannel} TOTALS</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(165px, 1fr))', gap: 12 }}>
              <KpiCard label="Total Spend" value={fmt$(t.spend)} fullValue={fmtFull$(t.spend)} tooltip={TIP.spend} accent="nobl" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('channel', activeChannel, 'total_spend'), targetLabel: `${activeChannel} · Total Spend` }} />
              <KpiCard label="Total Revenue" value={fmt$(t.revenue)} fullValue={fmtFull$(t.revenue)} tooltip={TIP.revenue} accent="nobl" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('channel', activeChannel, 'total_revenue'), targetLabel: `${activeChannel} · Total Revenue` }} />
              <KpiCard label="Avg ROAS" value={fmtRatio(roas)} copyValue={roas.toFixed(4)} tooltip={TIP.roas} accent="nobl" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('channel', activeChannel, 'avg_roas'), targetLabel: `${activeChannel} · Avg ROAS` }} />
              <KpiCard label="Total Purchases" value={fmtNum(t.purchases)} fullValue={fmtFullNum(t.purchases)} tooltip={TIP.purchases} accent="nobl" commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('channel', activeChannel, 'total_purchases'), targetLabel: `${activeChannel} · Total Purchases` }} />
            </div>
          </div>

          <ChartCard title="Daily Spend by Channel" subtitle="Stacked area — all channels">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={spendChartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
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
                <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
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
                  <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize: 11 }} width={70} stroke="var(--border2)" />
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
                  <YAxis tickFormatter={fmtAxisRatio} tick={{ fontSize: 11 }} width={Y_AXIS_WIDTH_RATIO} stroke="var(--border2)" />
                  <Tooltip formatter={(v) => [fmtRatio(v), 'ROAS']} contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="roas" name="ROAS" radius={[4, 4, 0, 0]}>
                    {channelTotals.map((e, i) => <Cell key={i} fill={chColor(e.channel, NOBL_ACCENT)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <ChartPanel
            title={activeChannel}
            subtitle={activeChannel === 'AMAZON'
              ? `${dates.length} days · ${TIP.amazonAdsRevenue} · ${TIP.amazonChannelSpend}`
              : `${dates.length} days · Attribution revenue (1-day)`}
          >
            <VerticalDataTable
              dates={dates}
              getRow={(d) => enrichChannelRow(byDateCh[`${d}|${activeChannel}`], activeChannel)}
              metrics={METRICS}
              tableScope={commentTargetKey('channel', activeChannel)}
              cellStatus={cellStatus}
            />
          </ChartPanel>
        </>
      )}
    </div>
    </CommentProvider>
  );
}
