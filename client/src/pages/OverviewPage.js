import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart, Area, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  getOverview, getSyncStatus, triggerSync, getSubscriptions, getNoblAirPerformanceBundle,
  fmt$, fmtRatio, fmtNum, fmtFullNum, fmtPct,
} from '../utils/api';
import useDailyForecast, { spendVarianceStatus, dailyVarianceStatus } from '../hooks/useDailyForecast';
import { buildForecastCellStatus } from '../utils/forecastCellStatus';
import { ForecastVsBadge, ForecastVariancePill, forecastColor } from '../components/ForecastIndicator';
import ForecastChartTooltip from '../components/ForecastChartTooltip';
import { resolveAirPerfFromBundle } from '../utils/noblAirRegional';
import { addDaysISO } from '../utils/dateRange';
import KpiCard from '../components/KpiCard';
import ChartPanel from '../components/ChartPanel';
import PaginatedSheetTable from '../components/PaginatedSheetTable';
import PageIntro from '../components/PageIntro';
import { CommentProvider } from '../components/CommentProvider';
import { commentTargetKey } from '../utils/commentKeys';
import { dailyCellKey, dailyCellLabel } from '../utils/sheetComments';
import { L, TIP, PAGE } from '../copy/plainLanguage';
import { useDashboardFilters } from '../context/DashboardFilterContext';
import { fmtAxisCurrency, TOOLTIP_STYLE, NOBL_ACCENT, FLO_ACCENT } from '../utils/chartHelpers';

function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo)-1]} ${parseInt(dy)}`;
}

const OVERVIEW_HEADERS = [
  L.date,
  'NOBL Order Revenue', 'NOBL ad spend', 'NOBL sales per ad $', 'NOBL orders', 'NOBL new customers',
  'FLO Order Revenue', 'FLO ad spend', 'FLO sales per ad $', 'FLO orders', 'FLO new customers',
  'Total Order Revenue', 'Total ad spend', L.blendedMer,
  L.subRevenue,
];

function toTableRow(r) {
  const blendedMer = r.total_spend > 0 ? (r.total_revenue / r.total_spend) : null;
  return {
    [L.date]:           r.date,
    'NOBL Order Revenue':     r.nobl_revenue,
    'NOBL ad spend':          r.nobl_spend,
    'NOBL sales per ad $':    r.nobl_mer,
    'NOBL orders':            r.nobl_orders,
    'NOBL new customers':     r.nobl_nc_orders,
    'FLO Order Revenue':      r.flo_revenue,
    'FLO ad spend':           r.flo_spend,
    'FLO sales per ad $':     r.flo_mer,
    'FLO orders':             r.flo_orders,
    'FLO new customers':      r.flo_nc_orders,
    'Total Order Revenue':    r.total_revenue,
    'Total ad spend':         r.total_spend,
    [L.blendedMer]:           blendedMer,
    [L.subRevenue]:           r.nobl_sub_revenue,
    _date: r.date,
  };
}

function filterOverviewByBrand(rows, brands) {
  if (brands.includes('ALL') || brands.length > 1) return rows;
  const brand = brands[0];
  if (brand === 'NOBL') {
    return rows.map(r => ({
      ...r,
      flo_revenue: 0, flo_spend: 0, flo_mer: null, flo_orders: 0, flo_nc_orders: 0,
      total_revenue: r.nobl_revenue,
      total_spend: r.nobl_spend,
    }));
  }
  if (brand === 'FLO' || brand === 'FLO_EU') {
    return rows.map(r => ({
      ...r,
      nobl_revenue: 0, nobl_spend: 0, nobl_mer: null, nobl_orders: 0, nobl_nc_orders: 0,
      nobl_sub_revenue: 0,
      total_revenue: r.flo_revenue,
      total_spend: r.flo_spend,
    }));
  }
  return rows;
}

function daysInclusive(start, end) {
  const [ay, am, ad] = start.split('-').map(Number);
  const [by, bm, bd] = end.split('-').map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

/** Previous equivalent range ending the day before `start`. */
function priorRangeFor(start, end) {
  const len = daysInclusive(start, end);
  const pEnd = addDaysISO(start, -1);
  const pStart = addDaysISO(pEnd, -(len - 1));
  return { start: pStart, end: pEnd };
}

function pctDelta(cur, prev) {
  if (prev == null || !isFinite(prev) || prev === 0 || cur == null) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

function Delta({ pct, invert }) {
  if (pct == null || !isFinite(pct)) return <span className="ov-delta ov-delta--flat">— no prior</span>;
  const up = pct >= 0;
  const flat = Math.abs(pct) < 0.5;
  const good = invert ? !up : up;
  const cls = flat ? 'ov-delta--flat' : good ? 'ov-delta--up' : 'ov-delta--dn';
  return (
    <span className={`ov-delta ${cls}`}>
      {flat ? '–' : up ? '▲' : '▼'} {Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}% vs prior
    </span>
  );
}

function Tile({ label, value, pct, invert, fcPct }) {
  const hasFc = fcPct != null && Number.isFinite(fcPct) && Math.abs(fcPct) >= 0.005;
  return (
    <div className="ov-tile">
      <div>
        <div className="kpi__label">{label}</div>
        <div className="ov-tile__val">{value}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <Delta pct={pct} invert={invert} />
        {hasFc && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--text3)' }}>
            <ForecastVariancePill pct={fcPct} statusOverride={invert ? spendVarianceStatus(fcPct) : undefined} />
            <span>vs forecast</span>
          </span>
        )}
      </div>
    </div>
  );
}

function Spark({ data }) {
  return (
    <div style={{ marginTop: 12, height: 48 }}>
      <ResponsiveContainer width="100%" height={48}>
        <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="ovSpark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1f6f54" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#1f6f54" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="total_revenue" stroke="#1f6f54" strokeWidth={2} fill="url(#ovSpark)" dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ShareRow({ name, pctw, val, color }) {
  return (
    <div className="ov-share__row">
      <span className="ov-share__name">{name}</span>
      <div className="ov-share__track"><div className="ov-share__fill" style={{ width: `${pctw}%`, background: color }} /></div>
      <span className="ov-share__val">{val}</span>
    </div>
  );
}

function ScRow({ label, nobl, flo, comb, showNobl, showFlo, forecast, variancePct, invertSpend }) {
  // Hide near-zero variances (the engine echoes actual as forecast for unplanned
  // metrics like spend, producing a misleading uniform 0% pill on every row).
  const showPill = variancePct != null && Number.isFinite(variancePct) && Math.abs(variancePct) >= 0.005;
  const status = showPill ? (invertSpend ? spendVarianceStatus(variancePct) : dailyVarianceStatus(variancePct)) : null;
  // Subtle variance tint on the forecast cells (color-mix keeps it light over any theme).
  const tint = status ? `color-mix(in srgb, ${forecastColor(status)} 10%, transparent)` : undefined;
  return (
    <tr>
      <td>{label}</td>
      {showNobl && <td>{nobl}</td>}
      {showFlo && <td>{flo}</td>}
      <td>{comb}</td>
      <td style={{ color: 'var(--text3)', background: tint }}>{forecast != null && showPill ? forecast : '—'}</td>
      <td style={{ background: tint }}>{showPill
        ? <ForecastVariancePill pct={variancePct} statusOverride={invertSpend ? spendVarianceStatus(variancePct) : undefined} />
        : <span style={{ color: 'var(--text4)' }}>—</span>}</td>
    </tr>
  );
}

/** One actual-vs-forecast comparison tile for the period strip. */
function FcCompare({ label, actual, forecast, pct, invert }) {
  if (forecast == null) return null;
  const status = pct == null || !Number.isFinite(pct) ? 'model' : (invert ? spendVarianceStatus(pct) : dailyVarianceStatus(pct));
  const tint = `color-mix(in srgb, ${forecastColor(status)} 8%, transparent)`;
  return (
    <div className="card" style={{ flex: '1 1 180px', minWidth: 180, padding: '12px 14px', background: tint }}>
      <div className="kpi__label">{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>{actual}</span>
        {pct != null && Number.isFinite(pct) && Math.abs(pct) >= 0.005 && (
          <ForecastVariancePill pct={pct} statusOverride={invert ? spendVarianceStatus(pct) : undefined} />
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>Forecast {forecast}</div>
    </div>
  );
}

function computeTotals(rows) {
  return rows.reduce((acc, r) => ({
    total_revenue: (acc.total_revenue || 0) + (r.total_revenue || 0),
    total_spend: (acc.total_spend || 0) + (r.total_spend || 0),
    nobl_revenue: (acc.nobl_revenue || 0) + (r.nobl_revenue || 0),
    nobl_spend: (acc.nobl_spend || 0) + (r.nobl_spend || 0),
    nobl_orders: (acc.nobl_orders || 0) + (r.nobl_orders || 0),
    nobl_nc_orders: (acc.nobl_nc_orders || 0) + (r.nobl_nc_orders || 0),
    flo_revenue: (acc.flo_revenue || 0) + (r.flo_revenue || 0),
    flo_spend: (acc.flo_spend || 0) + (r.flo_spend || 0),
    flo_orders: (acc.flo_orders || 0) + (r.flo_orders || 0),
    flo_nc_orders: (acc.flo_nc_orders || 0) + (r.flo_nc_orders || 0),
    nobl_sub_revenue: (acc.nobl_sub_revenue || 0) + (r.nobl_sub_revenue || 0),
  }), {});
}

export default function OverviewPage({ showToast }) {
  const {
    dateRange, brands, regions, isAllBrands, brandsApi,
  } = useDashboardFilters();

  const [data, setData] = useState(null);
  const [prevData, setPrevData] = useState(null);
  const [subsData, setSubsData] = useState(null);
  const [airBundle, setAirBundle] = useState(null);
  const [syncData, setSyncData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [lastSyncLabel, setLastSyncLabel] = useState(null);

  const showNobl = isAllBrands || brands.includes('NOBL');
  const showFlo = isAllBrands || brands.includes('FLO') || brands.includes('FLO_EU');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const { start, end } = dateRange;
    const prior = priorRangeFor(start, end);
    try {
      const fetches = [
        getOverview(start, end),
        getSyncStatus().catch(() => null),
        getSubscriptions(start, end, brandsApi.subs).catch(() => null),
        getOverview(prior.start, prior.end).catch(() => null),
      ];
      if (showNobl) {
        fetches.push(getNoblAirPerformanceBundle(start, end).catch(() => null));
      }
      const [overview, sync, subs, prev, bundle] = await Promise.all(fetches);
      setData(overview);
      setSyncData(sync);
      setSubsData(subs);
      setPrevData(prev);
      setAirBundle(bundle || null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [dateRange, brandsApi.subs, showNobl]);

  const airData = useMemo(
    () => (airBundle ? resolveAirPerfFromBundle(airBundle, regions, 14, 0) : null),
    [airBundle, regions],
  );

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    function updateLabel(syncD) {
      const rec = (syncD?.recent || []).find(r => r?.finished_at) || syncD?.recent?.[0];
      if (!rec?.finished_at) { setLastSyncLabel(null); return; }
      const diffMin = Math.floor((Date.now() - new Date(rec.finished_at).getTime()) / 60000);
      const rel = diffMin < 1 ? 'just now' : diffMin < 60 ? `${diffMin}m ago` : `${Math.floor(diffMin / 60)}h ago`;
      let clock = '';
      try {
        clock = new Date(rec.finished_at).toLocaleTimeString('en-US', {
          timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
        }) + ' ET';
      } catch { /* ignore */ }
      setLastSyncLabel(clock ? `${clock} · ${rel}` : rel);
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

  const chartRows = useMemo(
    () => filterOverviewByBrand(data?.rows || [], brands),
    [data?.rows, brands],
  );
  const totals = useMemo(() => {
    const t = computeTotals(chartRows);
    t.blended_mer = t.total_spend > 0 ? t.total_revenue / t.total_spend : 0;
    t.nobl_mer = t.nobl_spend > 0 ? t.nobl_revenue / t.nobl_spend : 0;
    t.flo_mer = t.flo_spend > 0 ? t.flo_revenue / t.flo_spend : 0;
    return t;
  }, [chartRows]);

  const prevTotals = useMemo(() => {
    const rows = filterOverviewByBrand(prevData?.rows || [], brands);
    const t = computeTotals(rows);
    t.blended_mer = t.total_spend > 0 ? t.total_revenue / t.total_spend : 0;
    return t;
  }, [prevData, brands]);

  const deltas = useMemo(() => ({
    revenue: pctDelta(totals.total_revenue, prevTotals.total_revenue),
    spend:   pctDelta(totals.total_spend, prevTotals.total_spend),
    mer:     pctDelta(totals.blended_mer, prevTotals.blended_mer),
    orders:  pctDelta((totals.nobl_orders || 0) + (totals.flo_orders || 0), (prevTotals.nobl_orders || 0) + (prevTotals.flo_orders || 0)),
  }), [totals, prevTotals]);

  const subsSummary = subsData?.summary || {};
  const airTotals = airData?.totals || {};
  const tableRows = chartRows.map(toTableRow);

  // Daily forecast scoped to the selected brand(s) → combined red/green vs plan.
  const fcBrand = (isAllBrands || brands.length > 1)
    ? 'ALL'
    : (brands[0] === 'NOBL' ? 'NOBL' : (brands[0] === 'FLO' || brands[0] === 'FLO_EU' ? 'FLO' : 'ALL'));
  const fc = useDailyForecast(fcBrand, dateRange.start, dateRange.end);
  const salesChartData = useMemo(
    () => chartRows.map((r) => ({ ...r, forecast: fc.forecastForDate(r.date) })),
    [chartRows, fc],
  );
  // Period-level forecast totals for revenue and spend (sum the daily forecasts
  // for the days that have actuals, so the comparison is apples-to-apples).
  const fcPeriod = useMemo(() => {
    let aRev = 0, fRev = 0, aSp = 0, fSp = 0, has = false;
    for (const r of chartRows) {
      const actual = Number(r.total_revenue);
      const forecast = fc.forecastForDate(r.date);
      const fcRow = fc.rowForDate(r.date);
      if (Number.isFinite(actual) && actual !== 0 && forecast != null) {
        aRev += actual; fRev += forecast; has = true;
        const sp = Number(r.total_spend);
        const fsp = fcRow?.forecast_spend != null ? Number(fcRow.forecast_spend) : null;
        if (Number.isFinite(sp) && fsp != null) { aSp += sp; fSp += fsp; }
      }
    }
    if (!has) return null;
    const revPct = fRev > 0 ? (aRev - fRev) / fRev : null;
    const spPct  = fSp  > 0 ? (aSp  - fSp ) / fSp  : null;
    const aMer = aSp > 0 ? aRev / aSp : null;
    const fMer = fSp > 0 ? fRev / fSp : null;
    const merPct = fMer != null && fMer > 0 && aMer != null ? (aMer - fMer) / fMer : null;
    return { actual: aRev, forecast: fRev, revPct, actualSpend: aSp, forecastSpend: fSp, spPct, actualMer: aMer, forecastMer: fMer, merPct };
  }, [chartRows, fc]);

  const cellStatus = useCallback(
    buildForecastCellStatus(fc, { metrics: { 'Total Order Revenue': 'revenue', 'Total ad spend': 'spend' } }),
    [fc],
  );

  const noblRev = totals.nobl_revenue || 0;
  const floRev = totals.flo_revenue || 0;
  const totRev = (noblRev + floRev) || 1;
  const noblShare = Math.round((noblRev / totRev) * 100);
  const floShare = Math.max(0, 100 - noblShare);

  return (
    <CommentProvider pageKey="overview">
    <div className="page-stack">
      <PageIntro
        eyebrow="All Brands"
        title={PAGE.overview.title}
        desc={PAGE.overview.desc}
        actions={<>
          {lastSyncLabel && (
            <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:11, color:'var(--text3)', background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:20, padding:'3px 10px' }}>
              <span style={{ width:5, height:5, borderRadius:'50%', background:'var(--success)', flexShrink:0 }} />
              Last update {lastSyncLabel}
            </span>
          )}
          <button onClick={handleSync} disabled={syncing} className="btn btn--primary btn--sm">
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </>}
      />

      {loading ? <Skeleton /> : error ? <ErrorMsg msg={error} onRetry={load} /> : (
        <>
          {/* Command center — hero + secondary metrics with prior-period deltas */}
          <div className="section">
            <div className="section__title">Performance · vs prior period</div>
            <div className="ov-hero">
              <div className="ov-hero__primary card">
                <div className="kpi__label">Total sales · as of {fmtDateLabel(dateRange.end)}</div>
                <div className="ov-hero__valrow" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <span className="ov-hero__value">{fmt$(totals.total_revenue || 0)}</span>
                  <Delta pct={deltas.revenue} />
                  {fcPeriod && <ForecastVsBadge actual={fcPeriod.actual} forecast={fcPeriod.forecast} />}
                </div>
                <Spark data={chartRows} />
              </div>
              <div className="ov-hero__tiles">
                <Tile label={L.blendedMer} value={fmtRatio(totals.blended_mer || 0)} pct={deltas.mer} fcPct={fcPeriod?.merPct} />
                <Tile label="Total ad spend" value={fmt$(totals.total_spend || 0)} pct={deltas.spend} invert fcPct={fcPeriod?.spPct} />
                <Tile label="Total orders" value={fmtNum((totals.nobl_orders || 0) + (totals.flo_orders || 0))} pct={deltas.orders} />
              </div>
            </div>
          </div>

          {/* By brand — share bars + scorecard table */}
          {(showNobl || showFlo) && (
          <div className="section">
            <div className="section__title">By brand</div>
            <div className="ov-share card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Brand share of sales</span>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                  {showNobl && `NOBL ${noblShare}%`}{showNobl && showFlo && ' · '}{showFlo && `FLO ${floShare}%`}
                </span>
              </div>
              {showNobl && <ShareRow name="NOBL" pctw={showFlo ? noblShare : 100} val={fmt$(noblRev)} color="var(--nobl)" />}
              {showFlo && <ShareRow name="FLO" pctw={showNobl ? floShare : 100} val={fmt$(floRev)} color="var(--flo)" />}
            </div>
            <div className="card" style={{ overflow: 'hidden' }}>
              <table className="scorecard">
                <thead>
                  <tr>
                    <th>Metric</th>
                    {showNobl && <th style={{ color: 'var(--nobl)' }}>NOBL</th>}
                    {showFlo && <th style={{ color: 'var(--flo)' }}>FLO</th>}
                    <th>Combined</th>
                    <th>Forecast</th>
                    <th>vs Forecast</th>
                  </tr>
                </thead>
                <tbody>
                  <ScRow label="Sales" showNobl={showNobl} showFlo={showFlo} nobl={fmt$(noblRev)} flo={fmt$(floRev)} comb={fmt$(totals.total_revenue || 0)}
                    forecast={fcPeriod?.forecast != null ? fmt$(fcPeriod.forecast) : null} variancePct={fcPeriod?.revPct} />
                  <ScRow label="Ad spend" showNobl={showNobl} showFlo={showFlo} nobl={fmt$(totals.nobl_spend || 0)} flo={fmt$(totals.flo_spend || 0)} comb={fmt$(totals.total_spend || 0)}
                    forecast={fcPeriod?.forecastSpend != null ? fmt$(fcPeriod.forecastSpend) : null} variancePct={fcPeriod?.spPct} invertSpend />
                  <ScRow label={L.blendedMer} showNobl={showNobl} showFlo={showFlo} nobl={fmtRatio(totals.nobl_mer || 0)} flo={fmtRatio(totals.flo_mer || 0)} comb={fmtRatio(totals.blended_mer || 0)}
                    forecast={fcPeriod?.forecastMer != null ? fmtRatio(fcPeriod.forecastMer) : null} variancePct={fcPeriod?.merPct} />
                  <ScRow label="Orders" showNobl={showNobl} showFlo={showFlo} nobl={fmtNum(totals.nobl_orders || 0)} flo={fmtNum(totals.flo_orders || 0)} comb={fmtNum((totals.nobl_orders || 0) + (totals.flo_orders || 0))} />
                  <ScRow label="New customers" showNobl={showNobl} showFlo={showFlo} nobl={fmtNum(totals.nobl_nc_orders || 0)} flo={fmtNum(totals.flo_nc_orders || 0)} comb={fmtNum((totals.nobl_nc_orders || 0) + (totals.flo_nc_orders || 0))} />
                </tbody>
              </table>
            </div>
          </div>
          )}

          {/* Subscribers & Air */}
          <div className="page-kpi-section">
            <div className="page-kpi-section__title">Subscribers &amp; active users</div>
            <div className="page-kpi-grid page-kpi-grid--overview">
              <KpiCard label={L.activeSubs} sub="right now" value={fmtNum(subsSummary.active || 0)} fullValue={fmtFullNum(subsSummary.active || 0)} tooltip={TIP.activeSubs} />
              <KpiCard label={L.converted} sub="right now" value={fmtNum(subsSummary.converted || 0)} fullValue={fmtFullNum(subsSummary.converted || 0)} tooltip={TIP.converted} />
              <KpiCard label={L.cancelled} sub="right now" value={fmtNum(subsSummary.cancelled || 0)} fullValue={fmtFullNum(subsSummary.cancelled || 0)} tooltip={TIP.cancelled} />
              {showNobl && <>
                <KpiCard label="NOBL Air active subs" sub="right now" value={fmtNum(airData?.active_count ?? 0)} fullValue={fmtFullNum(airData?.active_count ?? 0)} tooltip={TIP.activeSubs} />
                <KpiCard label="Est. yearly sub value" sub="NOBL Air" value={fmt$(airData?.active_arr ?? 0)} fullValue={fmt$(airData?.active_arr ?? 0)} tooltip={TIP.activeArr} />
                <KpiCard label={L.attachRate} sub="NOBL Air · period" value={fmtPct(airTotals.attach_rate || 0)} fullValue={fmtPct(airTotals.attach_rate || 0)} tooltip={TIP.attachRate} />
                <KpiCard label={L.combinedNetRevenue} sub="NOBL Air · period" value={fmt$(airTotals.combined_net_revenue || 0)} fullValue={fmt$(airTotals.combined_net_revenue || 0)} tooltip={TIP.combinedNetRevenue} />
              </>}
              <KpiCard label="Subscription sales" sub="in date range" value={fmt$(totals.nobl_sub_revenue || 0)} fullValue={fmt$(totals.nobl_sub_revenue || 0)} tooltip={TIP.subRevenue} commentTarget={{ targetType: 'kpi', targetKey: commentTargetKey('nobl_sub_revenue'), targetLabel: 'NOBL Subscription Sales' }} />
            </div>
          </div>

          <div className="section">
            <div className="section__title">Trends</div>
            <div className="chart-grid-2">
            <ChartPanel title="Sales over time" subtitle="Daily order revenue by brand">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={salesChartData} margin={{ top:4, right:16, left:0, bottom:4 }}>
                  <defs>
                    <linearGradient id="gradNobl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={NOBL_ACCENT} stopOpacity={0.25}/>
                      <stop offset="95%" stopColor={NOBL_ACCENT} stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="gradFlo" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={FLO_ACCENT} stopOpacity={0.25}/>
                      <stop offset="95%" stopColor={FLO_ACCENT} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                  <Tooltip content={<ForecastChartTooltip fc={fc} labelFormatter={fmtDateLabel} formatter={(v) => fmt$(v)} />} />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  {showNobl && <Area type="monotone" dataKey="nobl_revenue" name="NOBL sales" stroke={NOBL_ACCENT} fill="url(#gradNobl)" strokeWidth={2} dot={false} />}
                  {showFlo && <Area type="monotone" dataKey="flo_revenue" name="FLO sales" stroke={FLO_ACCENT} fill="url(#gradFlo)" strokeWidth={2} dot={false} />}
                  {!(showNobl && showFlo) && <Line type="monotone" dataKey="forecast" name="Forecast" stroke="var(--warn)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />}
                </AreaChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel title="Daily ad spend" subtitle="Spend comparison by brand">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={chartRows} margin={{ top:4, right:16, left:0, bottom:4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize:11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                  <Tooltip formatter={(v,n) => [fmt$(v),n]} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize:12 }} />
                  {showNobl && <Bar dataKey="nobl_spend" name="NOBL ad spend" fill={NOBL_ACCENT} radius={[3,3,0,0]} />}
                  {showFlo && <Bar dataKey="flo_spend" name="FLO ad spend" fill={FLO_ACCENT} radius={[3,3,0,0]} />}
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>
            </div>
          </div>

          {fcPeriod && (
            <div className="section">
              <div className="section__title">Period vs forecast</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <FcCompare label="Sales" actual={fmt$(fcPeriod.actual)} forecast={fmt$(fcPeriod.forecast)} pct={fcPeriod.revPct} />
                <FcCompare label="Ad spend" actual={fmt$(fcPeriod.actualSpend)} forecast={fmt$(fcPeriod.forecastSpend)} pct={fcPeriod.spPct} invert />
                <FcCompare label={L.blendedMer} actual={fmtRatio(fcPeriod.actualMer || 0)} forecast={fmtRatio(fcPeriod.forecastMer || 0)} pct={fcPeriod.merPct} />
              </div>
            </div>
          )}

          <div className="section">
            <div className="section__title">Daily detail</div>
            <ChartPanel title="Daily Summary" subtitle="Click cells to select · shift+click range · ctrl+C copy">
              <PaginatedSheetTable
                headers={OVERVIEW_HEADERS}
                rows={tableRows}
                keyField="_date"
                resetDeps={[dateRange.start, dateRange.end, brands.join(','), regions.join(',')]}
                defaultSortField={L.date}
                defaultSortDir="desc"
                searchable={true}
                stickyFirstCol={false}
                cellStatus={cellStatus}
                getCellCommentKey={(row, h) => dailyCellKey('daily', row, h)}
                getCellCommentLabel={(row, h) => dailyCellLabel(h, row)}
              />
            </ChartPanel>
          </div>
        </>
      )}
    </div>
    </CommentProvider>
  );
}

function Skeleton() {
  return (
    <div>
      <div className="page-kpi-grid" style={{ marginBottom: 16 }}>
        {[...Array(10)].map((_,i) => <div key={i} style={{ height:88, background:'var(--bg3)', borderRadius:12, animation:'pulse 1.5s ease-in-out infinite' }} />)}
      </div>
      <div className="chart-grid-2">
        <div style={{ height:300, background:'var(--bg2)', borderRadius:12, animation:'pulse 1.5s ease-in-out infinite' }} />
        <div style={{ height:300, background:'var(--bg2)', borderRadius:12, animation:'pulse 1.5s ease-in-out infinite' }} />
      </div>
    </div>
  );
}

function ErrorMsg({ msg, onRetry }) {
  return (
    <div style={{ padding:'40px 0', textAlign:'center' }}>
      <div style={{ color:'var(--danger)', marginBottom:12, fontSize:14 }}>Failed to load: {msg}</div>
      <button onClick={onRetry} className="btn btn--primary">Retry</button>
    </div>
  );
}
