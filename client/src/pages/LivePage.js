import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import KpiCard from '../components/KpiCard';
import SheetTable from '../components/SheetTable';
import PageIntro from '../components/PageIntro';
import { CommentProvider } from '../components/CommentProvider';
import { commentTargetKey } from '../utils/commentKeys';
import { L, TIP } from '../copy/plainLanguage';
import { fmt$, fmtNum, fmtRatio, fmtPct } from '../utils/api';
import { useDashboardFilters } from '../context/DashboardFilterContext';
import {
  fmtAxisCurrency, fmtAxisRatio, fmtChartCurrency, fmtChartRatio,
  CHANNEL_COL, TOOLTIP_STYLE,
} from '../utils/chartHelpers';

const API = (path) => fetch(path, { credentials: 'include' }).then(r => r.json());

const STATUS = {
  green:  { cls: 'live-status--green', color: 'var(--success)' },
  yellow: { cls: 'live-status--yellow', color: 'var(--warn)' },
  red:    { cls: 'live-status--red', color: 'var(--danger)' },
  gray:   { cls: 'live-status--gray', color: 'var(--text3)' },
};

const CHANNEL_META = {
  META:      { label: 'Meta',      color: CHANNEL_COL.META,      short: 'FB' },
  GOOGLE:    { label: 'Google',    color: CHANNEL_COL.GOOGLE,    short: 'GG' },
  APPLOVIN:  { label: 'AppLovin',  color: CHANNEL_COL.APPLOVIN,  short: 'AL' },
  TIKTOK:    { label: 'TikTok',    color: CHANNEL_COL.TIKTOK,    short: 'TT' },
  SNAPCHAT:  { label: 'Snapchat',  color: CHANNEL_COL.SNAPCHAT,  short: 'SC' },
  BING:      { label: 'Bing',      color: CHANNEL_COL.BING,      short: 'BG' },
  PINTEREST: { label: 'Pinterest', color: CHANNEL_COL.PINTEREST, short: 'PT' },
  X:         { label: 'X',         color: CHANNEL_COL.X,         short: 'X'  },
};

const GEO_FLAG  = { US: '🇺🇸', CA: '🇨🇦', AUS: '🇦🇺', DUBAI: '🇦🇪', EU: '🇪🇺' };
const GEO_LABEL = { US: 'United States', CA: 'Canada', AUS: 'Australia', DUBAI: 'Dubai / UAE', EU: 'Europe (EU)' };
const NOBL_REGIONS_ORDER = ['US', 'EU', 'CA', 'AUS', 'DUBAI'];

const BRANDS = [
  { k: 'nobl',   l: 'NOBL Travel', sub: 'US + EU + all regions' },
  { k: 'flo',    l: 'FLO US',      sub: 'Pilates FLO United States' },
  { k: 'flo_eu', l: 'FLO EU',      sub: 'Pilates FLO Europe' },
];

const HOURLY_REFRESH_MS = 60 * 60 * 1000;

const LIVE_CH_HEADERS = [
  'Channel', L.spend, L.revenue, L.roas, L.orders, L.ncOrders, L.cac, L.aov,
];
const LIVE_CH_FIELD_KEYS = {
  Channel: 'channel',
  [L.spend]: 'spend',
  [L.revenue]: 'revenue',
  [L.roas]: 'roas',
  [L.orders]: 'purchases',
  [L.ncOrders]: 'nc_orders',
  [L.cac]: 'cac',
  [L.aov]: 'aov',
};

function fmtDateShort(s) {
  if (!s) return '—';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(mo, 10) - 1]} ${parseInt(dy, 10)}`;
}

function fmtDateLong(s) {
  if (!s) return '—';
  const [yr, mo, dy] = String(s).slice(0, 10).split('-');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[parseInt(mo, 10) - 1]} ${parseInt(dy, 10)}, ${yr}`;
}

function fmtTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return null;
  }
}

function statusClass(s) {
  return STATUS[s]?.cls || STATUS.gray.cls;
}

function statusColor(s) {
  return STATUS[s]?.color || STATUS.gray.color;
}

// ── Small UI pieces ───────────────────────────────────────────────────────────
function StatusPill({ status, children }) {
  return (
    <span className={`live-status ${statusClass(status)}`}>
      <span className="live-status__dot" style={{ background: statusColor(status) }} />
      {children}
    </span>
  );
}

function SegBtn({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`seg__btn${active ? ' seg__btn--active' : ''}`}
    >
      {children}
    </button>
  );
}

function Skeleton({ h = 72 }) {
  return <div className="shimmer" style={{ height: h, borderRadius: 8 }} />;
}

function ErrBox({ msg, onRetry }) {
  return (
    <div className="live-error">
      <div style={{ flex: 1 }}>
        <div className="live-error__title">Failed to load</div>
        <code className="live-error__msg">{msg}</code>
      </div>
      {onRetry && (
        <button type="button" className="live-error__retry" onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}

function SectionHead({ title, sub, right }) {
  return (
    <div className="live-section__head">
      <div>
        <div className="live-section__title">{title}</div>
        {sub && <div className="live-section__sub">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

// ── Charts ────────────────────────────────────────────────────────────────────
function TrendChart({ data, metric, label, color, formatY, refVal }) {
  if (!data?.length) {
    return <div className="live-empty" style={{ height: 150 }}>No trend data for this period</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={150}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`live-${metric}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={fmtDateShort}
          tick={{ fontSize: 10, fill: 'var(--text3)' }}
          interval="preserveStartEnd"
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: 'var(--text3)' }}
          tickFormatter={metric === 'mer' ? fmtAxisRatio : fmtAxisCurrency}
          width={metric === 'mer' ? 48 : 72}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={fmtDateLong}
          formatter={(v) => [formatY(v), label]}
        />
        {refVal != null && (
          <ReferenceLine y={refVal} stroke={color} strokeDasharray="4 4" strokeOpacity={0.45} />
        )}
        <Area
          type="monotone"
          dataKey={metric}
          stroke={color}
          strokeWidth={2}
          fill={`url(#live-${metric})`}
          dot={false}
          activeDot={{ r: 4, stroke: color, strokeWidth: 2, fill: 'var(--bg2)' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function SpendBar({ channels }) {
  if (!channels?.length) {
    return <div className="live-empty" style={{ height: 160 }}>No channel spend data</div>;
  }
  const sorted = [...channels].sort((a, b) => (b.spend || 0) - (a.spend || 0));
  const totalSpend = sorted.reduce((s, c) => s + (c.spend || 0), 0);
  const data = sorted.map(c => ({
    name: CHANNEL_META[c.channel]?.label || c.channel,
    spend: Math.round(c.spend || 0),
    pct: totalSpend > 0 ? ((c.spend || 0) / totalSpend) * 100 : 0,
    color: CHANNEL_META[c.channel]?.color || '#6b7280',
  }));

  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 36)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 64, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 10, fill: 'var(--text3)' }}
          tickFormatter={fmtAxisCurrency}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          dataKey="name"
          type="category"
          tick={{ fontSize: 11, fill: 'var(--text2)', fontWeight: 600 }}
          width={60}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(v, _n, entry) => [
            `${fmtChartCurrency(v)} (${entry.payload.pct.toFixed(1)}% of total)`,
            L.spend,
          ]}
        />
        <Bar dataKey="spend" radius={[0, 6, 6, 0]} maxBarSize={22}>
          {data.map(d => <Cell key={d.name} fill={d.color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Geo cards ─────────────────────────────────────────────────────────────────
function GeoCards({ geo, loading, brand }) {
  if (loading) {
    return (
      <div className="live-geo-grid">
        {[...Array(5)].map((_, i) => <Skeleton key={i} h={130} />)}
      </div>
    );
  }

  const isNobl = brand === 'nobl';
  let regions = (geo || []).filter(g => g.region !== 'TOTAL');

  if (isNobl) {
    const regionMap = Object.fromEntries(regions.map(r => [r.region, r]));
    regions = NOBL_REGIONS_ORDER.map(k => regionMap[k] || {
      region: k, revenue: 0, spend: 0, mer: 0, mer_status: 'gray',
    });
  }

  regions = [...regions].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  if (!regions.length) return <div className="live-empty">No regional data for this date</div>;

  const totalRev = regions.reduce((s, g) => s + (g.revenue || 0), 0);

  return (
    <div className="live-geo-grid">
      {regions.map(g => {
        const isEU = g.region === 'EU';
        const revShare = totalRev > 0 ? ((g.revenue / totalRev) * 100).toFixed(1) : '0.0';
        return (
          <div
            key={g.region}
            className="live-geo-card"
            style={isEU && isNobl ? { borderColor: 'rgba(47, 78, 181, .28)' } : undefined}
          >
            <div className="live-geo-card__accent" style={{ background: statusColor(g.mer_status) }} />
            {isEU && isNobl && <div className="live-geo-card__badge">IN TOTALS</div>}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ fontSize: 16, lineHeight: 1 }}>{GEO_FLAG[g.region] || '🌐'}</span>
              <span className="live-geo-card__region">{GEO_LABEL[g.region] || g.region}</span>
            </div>

            <div className="live-geo-card__revenue">{fmt$(g.revenue)}</div>

            <div style={{ marginBottom: 10 }}>
              <StatusPill status={g.mer_status}>{L.mer} {fmtRatio(g.mer)}</StatusPill>
            </div>

            <div className="live-geo-card__rows">
              <div className="live-geo-card__row">
                <span>{L.spend}</span>
                <span className="live-geo-card__row-val">{fmt$(g.spend)}</span>
              </div>
              <div className="live-geo-card__row" style={{ paddingTop: 4, borderTop: '1px solid var(--border)' }}>
                <span>Sales share</span>
                <span className="live-geo-card__row-val" style={isEU && isNobl ? { color: 'var(--accent)' } : undefined}>
                  {revShare}%
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChannelTable({ channels, loading, asOfDate }) {
  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        {[...Array(4)].map((_, i) => <div key={i} style={{ marginBottom: 8 }}><Skeleton h={36} /></div>)}
      </div>
    );
  }
  if (!channels?.length) {
    return <div className="live-empty" style={{ padding: '24px 16px' }}>No channel data for this date</div>;
  }

  const rows = [...channels]
    .sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
    .map(ch => ({
      Channel: CHANNEL_META[ch.channel]?.label || ch.channel,
      [L.spend]: ch.spend,
      [L.revenue]: ch.revenue,
      [L.roas]: ch.roas,
      [L.orders]: ch.purchases,
      [L.ncOrders]: ch.nc_orders,
      [L.cac]: ch.cac > 0 ? ch.cac : null,
      [L.aov]: ch.purchases > 0 ? ch.revenue / ch.purchases : null,
      _channel: ch.channel,
      _roas_status: ch.roas_status,
    }));

  return (
    <div style={{ padding: '0 4px 4px' }}>
      <SheetTable
        headers={LIVE_CH_HEADERS}
        rows={rows}
        keyField="_channel"
        scrollable={false}
        searchable={false}
        hideRowCount
        compact
        getCellCommentKey={(row, h) => commentTargetKey('channel', row._channel, LIVE_CH_FIELD_KEYS[h] || h, asOfDate)}
        getCellCommentLabel={(row, h) => `${row._channel} · ${h} · ${asOfDate || '—'}`}
      />
    </div>
  );
}

function ChannelRoasCards({ channels, loading }) {
  if (loading) return <Skeleton h={120} />;
  if (!channels?.length) return <div className="live-empty">No channel data</div>;

  const sorted = [...channels].sort((a, b) => (b.spend || 0) - (a.spend || 0));

  return (
    <div className="live-channel-cards">
      {sorted.map(ch => {
        const meta = CHANNEL_META[ch.channel] || {};
        return (
          <div
            key={ch.channel}
            className="live-channel-card"
            style={{
              background: ch.roas_status === 'gray' ? 'var(--bg2)' : undefined,
              borderColor: 'var(--border)',
            }}
          >
            <div className="live-channel-card__name">
              <span className="live-channel-card__swatch" style={{ background: meta.color || '#888' }} />
              {meta.label || ch.channel}
            </div>
            <div className="live-channel-card__value" style={{ color: statusColor(ch.roas_status) }}>
              {fmtRatio(ch.roas)}
            </div>
            <div className="live-channel-card__sub">{fmt$(ch.spend)} {L.spend.toLowerCase()}</div>
          </div>
        );
      })}
    </div>
  );
}

const THRESHOLDS = [
  { label: 'MER — Global / US / CA / AU / EU', rules: ['< 1.8', '1.8 – 2.0', '≥ 2.0'], statuses: ['red', 'yellow', 'green'] },
  { label: 'MER — Dubai / UAE', rules: ['< 1.6', '1.6 – 1.8', '≥ 1.8'], statuses: ['red', 'yellow', 'green'] },
  { label: 'Meta', rules: ['< 1.6', '1.6 – 1.8', '≥ 1.8'], statuses: ['red', 'yellow', 'green'] },
  { label: 'Google', rules: ['< 2.0', '2.0 – 3.0', '≥ 3.0'], statuses: ['red', 'yellow', 'green'] },
  { label: 'AppLovin', rules: ['< 2.0', '2.0 – 2.2', '≥ 2.2'], statuses: ['red', 'yellow', 'green'] },
  { label: 'NVP%', rules: ['< 45%', '45 – 50%', '≥ 50%'], statuses: ['red', 'yellow', 'green'] },
];

// ── Main page ─────────────────────────────────────────────────────────────────
export default function LivePage() {
  const { brandsApi, filterByChannels, filterByRegions } = useDashboardFilters();
  const brand = brandsApi.live;
  const [dateMode, setDateMode] = useState('latest');
  const [customDate, setCustomDate] = useState('');
  const [trendDays, setTrendDays] = useState(30);
  const [availDates, setAvailDates] = useState(null);

  const [live, setLive] = useState(null);
  const [trend, setTrend] = useState(null);
  const [loadL, setLoadL] = useState(false);
  const [loadT, setLoadT] = useState(false);
  const [errL, setErrL] = useState(null);
  const [errT, setErrT] = useState(null);
  const liveFetchSeqRef = useRef(0);
  const trendFetchSeqRef = useRef(0);

  useEffect(() => {
    setLive(null);
    setTrend(null);
    setErrL(null);
    setErrT(null);
    setDateMode('latest');
    API(`/api/tw/available-dates?brand=${brand}`).then(d => {
      if (d.ok) {
        setAvailDates(d);
        setCustomDate(d.latest_summary || '');
      }
    }).catch(() => {});
  }, [brand]);

  const resolvedDate = dateMode === 'latest' ? (availDates?.latest_summary || '') : customDate;
  const brandMeta = BRANDS.find(b => b.k === brand) || BRANDS[0];

  const loadLive = useCallback(async (opts = {}) => {
    let date = resolvedDate;
    if (opts.silent && dateMode === 'latest') {
      try {
        const avail = await API(`/api/tw/available-dates?brand=${brand}`);
        if (avail.ok) {
          setAvailDates(avail);
          date = avail.latest_summary || date;
        }
      } catch { /* keep resolvedDate */ }
    }
    if (!date) return;
    const seq = ++liveFetchSeqRef.current;
    if (!opts.silent) setLoadL(true);
    if (!opts.silent) setErrL(null);
    try {
      const d = await API(`/api/tw/live?brand=${brand}&date=${date}`);
      if (seq !== liveFetchSeqRef.current) return;
      if (!d.ok) throw new Error(d.error || 'API error');
      setLive(d);
    } catch (e) {
      if (seq !== liveFetchSeqRef.current) return;
      if (!opts.silent) setErrL(e.message);
    } finally {
      if (!opts.silent && seq === liveFetchSeqRef.current) setLoadL(false);
    }
  }, [brand, resolvedDate, dateMode]);

  const loadTrend = useCallback(async (opts = {}) => {
    let date = resolvedDate;
    if (opts.silent && dateMode === 'latest') {
      try {
        const avail = await API(`/api/tw/available-dates?brand=${brand}`);
        if (avail.ok) {
          setAvailDates(avail);
          date = avail.latest_summary || date;
        }
      } catch { /* keep resolvedDate */ }
    }
    if (!date) return;
    const seq = ++trendFetchSeqRef.current;
    if (!opts.silent) setLoadT(true);
    if (!opts.silent) setErrT(null);
    try {
      const d = await API(`/api/tw/trend?brand=${brand}&days=${trendDays}&endDate=${date}`);
      if (seq !== trendFetchSeqRef.current) return;
      if (!d.ok) throw new Error(d.error || 'API error');
      setTrend(d);
    } catch (e) {
      if (seq !== trendFetchSeqRef.current) return;
      if (!opts.silent) setErrT(e.message);
    } finally {
      if (!opts.silent && seq === trendFetchSeqRef.current) setLoadT(false);
    }
  }, [brand, trendDays, resolvedDate, dateMode]);

  useEffect(() => { loadLive(); }, [loadLive]);
  useEffect(() => { loadTrend(); }, [loadTrend]);

  const hourlyRef = useRef(null);
  useEffect(() => {
    hourlyRef.current = setInterval(() => {
      loadLive({ silent: true });
      loadTrend({ silent: true });
    }, HOURLY_REFRESH_MS);
    return () => clearInterval(hourlyRef.current);
  }, [loadLive, loadTrend]);

  const sum = live?.summary;
  const channels = useMemo(
    () => filterByChannels(
      [...(live?.channels || [])].sort((a, b) => (b.revenue || 0) - (a.revenue || 0)),
      'channel',
    ),
    [live?.channels, filterByChannels],
  );
  const geo = filterByRegions(live?.geo || [], 'region');
  const trendArr = trend?.trend || [];
  const euContrib = live?.eu_contribution || null;

  const summaryDate = live?.summary_date;
  const channelDate = live?.channel_date;
  const geoDateUsed = live?.geo_date;
  const channelLag = live?.channel_lag;
  const geoLag = live?.geo_lag;
  const channelDaysLag = summaryDate && channelDate
    ? Math.round((new Date(summaryDate) - new Date(channelDate)) / 86400000)
    : 0;
  const hasDataLag = channelLag || geoLag;
  const refreshedAt = fmtTime(live?.generated_at);

  return (
    <CommentProvider pageKey="live">
      <div className="page-stack">
        {/* Date + refresh controls (slim, right-aligned) */}
        <PageIntro
          actions={(
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div className="seg">
                <SegBtn active={dateMode === 'latest'} onClick={() => setDateMode('latest')}>Latest</SegBtn>
                <SegBtn active={dateMode === 'custom'} onClick={() => setDateMode('custom')}>Pick date</SegBtn>
              </div>
              {dateMode === 'custom' && (
                <input
                  type="date"
                  className="live-date-input"
                  value={customDate}
                  onChange={e => setCustomDate(e.target.value)}
                  min={availDates?.oldest_summary}
                  max={availDates?.latest_summary}
                />
              )}
              {refreshedAt && !loadL && (
                <span style={{ fontSize: 11, color: 'var(--text3)' }} title="Auto-refreshes every hour">
                  Updated {refreshedAt} · hourly
                </span>
              )}
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => { loadLive(); loadTrend(); }}
                disabled={loadL}
              >
                <span className={`live-refresh-btn__icon${loadL ? ' live-refresh-btn__icon--spin' : ''}`}>↻</span>
                Refresh
              </button>
            </div>
          )}
        />

        {errL && <ErrBox msg={errL} onRetry={loadLive} />}

        {/* Data freshness */}
        {resolvedDate && !errL && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="live-banner live-banner--date">
              <span style={{ fontSize: 14, lineHeight: 1 }}>📅</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'center' }}>
                <span style={{ color: 'var(--text2)' }}>
                  <strong style={{ color: 'var(--text)' }}>{brandMeta.l}</strong>
                  {brandMeta.sub && <span style={{ color: 'var(--text3)' }}> — {brandMeta.sub}</span>}
                </span>
                <span style={{ color: 'var(--text2)' }}>
                  Summary KPIs: <strong style={{ color: 'var(--text)' }}>{fmtDateLong(summaryDate || resolvedDate)}</strong>
                </span>
                {channelDate && channelDate !== (summaryDate || resolvedDate) && (
                  <span style={{ color: 'var(--text3)', fontSize: 12 }}>
                    Channels &amp; regions: <strong style={{ color: 'var(--warn)' }}>{fmtDateLong(channelDate)}</strong>
                    {channelDaysLag > 0 && <> ({channelDaysLag} day{channelDaysLag !== 1 ? 's' : ''} behind)</>}
                  </span>
                )}
              </div>
            </div>
            {hasDataLag && channelDaysLag > 0 && (
              <div className="live-banner live-banner--warn">
                <span style={{ flexShrink: 0 }}>⚠</span>
                <span>
                  Channel and regional data is {channelDaysLag} day{channelDaysLag !== 1 ? 's' : ''} behind summary.
                  Summary KPIs and trend charts use the latest data; channel/geo sections reflect the most recent synced date.
                </span>
              </div>
            )}
          </div>
        )}

        {brand === 'nobl' && (
          <div className="live-banner live-banner--info">
            <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>🇪🇺</span>
            <span style={{ color: 'var(--text2)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--accent)' }}>EU is included in all NOBL Travel totals.</strong>
              {' '}Revenue, ad spend, MER, and orders always reflect US + EU + CA + AUS + Dubai combined.
            </span>
          </div>
        )}

        {/* Summary KPIs */}
        <section className="live-section">
          <SectionHead
            title="Daily summary"
            sub={brand === 'nobl'
              ? 'All channels blended · every NOBL region included'
              : 'All channels blended for the selected store'}
          />
          {loadL ? (
            <div className="page-kpi-grid">
              {[...Array(8)].map((_, i) => <Skeleton key={i} />)}
            </div>
          ) : sum ? (
            <>
              <div className="page-kpi-grid">
                <KpiCard
                  label="Order revenue"
                  value={fmt$(sum.order_revenue || sum.total_revenue)}
                  fullValue={String(sum.order_revenue || sum.total_revenue || '')}
                  tooltip={TIP.orderRevenue}
                  commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('order_revenue'), targetLabel: 'Order Revenue' }}
                />
                <KpiCard
                  label={L.spend}
                  value={fmt$(sum.total_spend)}
                  fullValue={String(sum.total_spend || '')}
                  tooltip={TIP.spend}
                  commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_spend'), targetLabel: 'Total Ad Spend' }}
                />
                <div
                  className="live-kpi-hero"
                  style={{ '--live-kpi-accent': statusColor(sum.mer_status) }}
                >
                  <KpiCard
                    label={L.mer}
                    value={fmtRatio(sum.mer)}
                    copyValue={sum.mer != null ? Number(sum.mer).toFixed(4) : undefined}
                    tooltip={TIP.mer}
                    commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('mer'), targetLabel: L.mer }}
                  />
                  {sum.mer_status && (
                    <div style={{ position: 'absolute', bottom: 14, right: 14 }}>
                      <StatusPill status={sum.mer_status}>vs target</StatusPill>
                    </div>
                  )}
                </div>
                <KpiCard
                  label={L.orders}
                  value={fmtNum(sum.total_orders)}
                  fullValue={String(sum.total_orders || '')}
                  tooltip={TIP.orders}
                  commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('total_orders'), targetLabel: 'Total Orders' }}
                />
                <KpiCard
                  label="New customers"
                  value={fmtNum(sum.new_customer_orders)}
                  fullValue={String(sum.new_customer_orders || '')}
                  tooltip={TIP.ncOrders}
                  commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('new_customers'), targetLabel: 'New Customers' }}
                />
                <KpiCard
                  label="Repeat customers"
                  value={fmtNum(sum.returning_orders)}
                  fullValue={String(sum.returning_orders || '')}
                  tooltip={TIP.orders}
                  commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('returning_orders'), targetLabel: 'Repeat Customers' }}
                />
                <KpiCard
                  label="New customer %"
                  value={fmtPct(sum.new_customer_rate)}
                  copyValue={sum.new_customer_rate != null ? String(sum.new_customer_rate) : undefined}
                  tooltip={TIP.nvp}
                  commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('new_customer_rate'), targetLabel: 'New Customer %' }}
                />
                <KpiCard
                  label={L.aov}
                  value={fmt$(sum.aov)}
                  fullValue={String(sum.aov || '')}
                  tooltip={TIP.aov}
                  commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('aov'), targetLabel: L.aov }}
                />
              </div>

              {brand === 'nobl' && euContrib && (
                <div className="live-eu-strip">
                  <div style={{ flexShrink: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                      🇪🇺 EU contribution
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                      Included in totals above · as of {fmtDateShort(geoDateUsed)}
                    </div>
                  </div>
                  {[
                    { label: 'Sales', value: fmt$(euContrib.revenue) },
                    { label: L.spend, value: fmt$(euContrib.spend) },
                    { label: L.mer, value: fmtRatio(euContrib.mer) },
                    { label: 'Share of sales', value: `${euContrib.rev_pct}%` },
                  ].map(item => (
                    <div key={item.label} className="live-eu-strip__metric">
                      <div className="live-eu-strip__metric-label">{item.label}</div>
                      <div className="live-eu-strip__metric-value">{item.value}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : !errL && resolvedDate ? (
            <div className="live-empty">No summary data for {fmtDateLong(resolvedDate)}</div>
          ) : null}
        </section>

        {/* Regional */}
        <section className="live-section">
          <SectionHead
            title={brand === 'nobl' ? 'Sales by region' : 'Sales by region'}
            sub={geoDateUsed
              ? `Regional MER and sales · ${fmtDateLong(geoDateUsed)}`
              : 'Sales, ad spend, and return per ad dollar by region'}
          />
          <GeoCards geo={geo} loading={loadL} brand={brand} />
        </section>

        {/* Trends */}
        <section className="live-section">
          <SectionHead
            title={`${trendDays}-day trend`}
            sub={brand === 'nobl'
              ? 'Daily sales per ad $, sales, and ad spend · all regions'
              : 'Daily sales per ad $, sales, and ad spend'}
            right={(
              <div className="seg">
                {[7, 14, 30, 60].map(d => (
                  <SegBtn key={d} active={trendDays === d} onClick={() => setTrendDays(d)}>{d}d</SegBtn>
                ))}
              </div>
            )}
          />
          {errT && <ErrBox msg={errT} onRetry={loadTrend} />}
          {!errT && (
            <div className="live-trend-grid">
              {[
                { key: 'mer', label: L.mer, color: 'var(--accent)', fmt: fmtChartRatio, ref: 2.0 },
                { key: 'revenue', label: L.revenue, color: 'var(--success)', fmt: fmtChartCurrency },
                { key: 'spend', label: L.spend, color: 'var(--warn)', fmt: fmtChartCurrency },
              ].map(c => (
                <div key={c.key} className="live-panel live-panel--pad">
                  <div className="live-panel__label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, display: 'inline-block' }} />
                    {c.label}
                    {c.ref != null && (
                      <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text3)', marginLeft: 4 }}>
                        (target ≥ {fmtRatio(c.ref)})
                      </span>
                    )}
                  </div>
                  {loadT ? <Skeleton h={150} /> : (
                    <TrendChart
                      data={trendArr}
                      metric={c.key}
                      label={c.label}
                      color={c.color}
                      formatY={c.fmt}
                      refVal={c.ref}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Channels */}
        <section className="live-section">
          <SectionHead
            title="Ad channels"
            sub={channelDate
              ? `Spend, sales, and efficiency by platform · ${fmtDateLong(channelDate)}`
              : 'Where ad spend went and what it returned'}
          />
          <div className="live-channel-grid">
            <div className="live-panel live-panel--pad">
              <div className="live-panel__label">{L.spend} by channel</div>
              {loadL ? <Skeleton h={160} /> : <SpendBar channels={channels} />}
            </div>
            <div className="live-panel live-panel--pad">
              <div className="live-panel__label">{L.roas} vs targets</div>
              <ChannelRoasCards channels={channels} loading={loadL} />
            </div>
          </div>
          <div className="live-panel" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px 0' }}>
              <div className="live-panel__label" style={{ marginBottom: 0 }}>Channel detail</div>
            </div>
            <ChannelTable channels={channels} loading={loadL} asOfDate={channelDate || resolvedDate} />
          </div>
        </section>

        {/* Thresholds legend */}
        <section className="live-section">
          <SectionHead
            title="Performance thresholds"
            sub="Color indicators on MER and channel cards follow these targets"
          />
          <div className="live-panel live-panel--pad">
            <div className="live-threshold-grid">
              {THRESHOLDS.map(t => (
                <div key={t.label} className="live-threshold-item">
                  <div className="live-threshold-item__label">{t.label}</div>
                  <div className="live-threshold-item__rules">
                    {t.rules.map((rule, i) => (
                      <span key={rule} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span className="live-status__dot" style={{ background: statusColor(t.statuses[i]) }} />
                        {rule}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </CommentProvider>
  );
}
