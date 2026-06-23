import React, { useEffect, useMemo, useState } from 'react';
import {
  Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { getForecastEngine, getForecastDaily, fmt$, fmtRatio } from '../utils/api';
import PageIntro from '../components/PageIntro';
import ChartPanel from '../components/ChartPanel';
import KpiCard from '../components/KpiCard';
import TablePagination from '../components/TablePagination';
import { ForecastVariancePill, ForecastVsBadge } from '../components/ForecastIndicator';
import ForecastChartTooltip from '../components/ForecastChartTooltip';
import ForecastHoverTooltip from '../components/ForecastHoverTooltip';
import { useClientPagination } from '../hooks/useClientPagination';
import { TABLE_PAGE_SIZE } from '../constants/pagination';

const money = (n) => (n == null ? '—' : fmt$(n));
const ratio = (n) => (n == null ? '—' : fmtRatio(n));
const tooltipStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12, boxShadow: '0 8px 22px rgba(15,23,42,.10)' };

const MONTHS_2026 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS = {
  green: { label: 'On / ahead of forecast', color: 'var(--success)', bg: 'var(--success-dim)' },
  amber: { label: 'Watch', color: 'var(--warn)', bg: 'var(--warn-dim)' },
  red: { label: 'Behind forecast', color: 'var(--danger)', bg: 'var(--danger-dim)' },
  model: { label: 'No comparison', color: 'var(--text3)', bg: 'var(--bg3)' },
};

const controlStyle = {
  padding: '10px 12px', border: '1px solid var(--border2)', borderRadius: 12,
  background: 'var(--bg2)', color: 'var(--text)', fontFamily: 'var(--font-body)', width: '100%',
};
const filterLabel = {
  fontSize: 10.5, color: 'var(--text3)', fontWeight: 900, textTransform: 'uppercase',
  letterSpacing: '.6px', margin: '0 0 5px 2px',
};

function varianceStatus(pct) {
  if (pct == null) return 'model';
  if (pct >= -0.05) return 'green';
  if (pct >= -0.15) return 'amber';
  return 'red';
}

function fmtPctSigned(pct) {
  if (pct == null) return '—';
  const v = pct * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function shortMonth(label) {
  return String(label || '').replace(/\s?20\d\d/, '');
}

function fmtDayLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${MONTH_NAMES[parseInt(mo, 10) - 1]} ${parseInt(dy, 10)}`;
}

function monthLabel(monthKey) {
  const [, mo] = monthKey.split('-');
  return `${MONTH_NAMES[parseInt(mo, 10) - 1]} 2026`;
}

function monthBounds(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { start: `${monthKey}-01`, end: `${monthKey}-${String(last).padStart(2, '0')}` };
}

function defaultMonthKey(asOf) {
  const d = asOf || new Date().toISOString().slice(0, 10);
  const key = d.slice(0, 7);
  return MONTHS_2026.includes(key) ? key : MONTHS_2026[0];
}

function shiftMonth(monthKey, delta) {
  const idx = MONTHS_2026.indexOf(monthKey);
  if (idx < 0) return MONTHS_2026[0];
  return MONTHS_2026[Math.max(0, Math.min(MONTHS_2026.length - 1, idx + delta))];
}

function RowTypeBadge({ value }) {
  const text = String(value || '—');
  const lower = text.toLowerCase();
  let variant = 'muted';
  if (lower === 'actual') variant = 'success';
  else if (lower.includes('project')) variant = 'accent';
  else if (lower.includes('missing')) variant = 'warn';
  else if (lower === 'future') variant = 'muted';
  else if (lower.includes('target met')) variant = 'success';
  else if (lower.includes('below')) variant = 'danger';
  return <span className={`badge badge--${variant}`}>{text}</span>;
}

function VarianceCell({ pct }) {
  const st = STATUS[varianceStatus(pct)];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999,
      fontWeight: 800, fontSize: 11.5, color: st.color, background: st.bg, border: `1px solid ${st.color}33`,
      fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: st.color }} />
      {fmtPctSigned(pct)}
    </span>
  );
}

function DataTable({ columns, rows, page, pageSize, totalRows, onPageChange, onRowHover, rowHoverable }) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 14 }}>
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--text3)', background: 'var(--bg3)' }}>
            {columns.map((c) => (
              <th
                key={c.key || c.label}
                style={{
                  textAlign: c.align || 'right', padding: '10px 12px',
                  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
                  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
                }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: 18, color: 'var(--text3)', textAlign: 'center' }}>
                No rows match the selected filters.
              </td>
            </tr>
          ) : rows.map((r) => (
            <tr
              key={r._key || r.date || r.month_key}
              style={{
                color: 'var(--text2)',
                background: r._highlight ? 'var(--accent-dim)' : undefined,
              }}
              onMouseEnter={onRowHover && rowHoverable?.(r) ? (e) => onRowHover(r, e.currentTarget.getBoundingClientRect()) : undefined}
              onMouseLeave={onRowHover ? () => onRowHover(null) : undefined}
            >
              {columns.map((c) => (
                <td
                  key={c.key || c.label}
                  style={{
                    padding: '10px 12px', textAlign: c.align || 'right',
                    whiteSpace: c.wrap ? 'normal' : 'nowrap',
                    borderBottom: '1px solid var(--row-sep)',
                    fontVariantNumeric: 'tabular-nums', minWidth: c.minWidth,
                    fontWeight: c.bold ? 700 : undefined, color: c.bold ? 'var(--text)' : undefined,
                  }}
                >
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {page != null && (
        <TablePagination page={page} pageSize={pageSize} totalRows={totalRows} onPageChange={onPageChange} />
      )}
    </div>
  );
}

function LoadingState({ label }) {
  return (
    <div style={{ padding: '48px 0', textAlign: 'center' }}>
      <div style={{
        width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)',
        borderRadius: '50%', animation: 'spin .8s linear infinite', margin: '0 auto 12px',
      }} />
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>{label}</div>
    </div>
  );
}

function combineMonthly(brands) {
  const byKey = new Map();
  for (const b of brands) {
    for (const r of b.monthly || []) {
      const k = r.month_key;
      if (!k) continue;
      const acc = byKey.get(k) || {
        month: r.month, month_key: k, plan_revenue: 0, actual_revenue: 0,
        projected_revenue: 0, _hasActual: false,
      };
      acc.plan_revenue += Number(r.plan_revenue) || 0;
      acc.projected_revenue += Number(r.projected_revenue) || 0;
      if (r.actual_revenue != null) {
        acc.actual_revenue += Number(r.actual_revenue) || 0;
        acc._hasActual = true;
      }
      byKey.set(k, acc);
    }
  }
  return [...byKey.values()].sort((a, b) => a.month_key.localeCompare(b.month_key)).map((r) => {
    const actual = r._hasActual ? r.actual_revenue : null;
    const variance_pct = r.plan_revenue > 0 ? (r.projected_revenue - r.plan_revenue) / r.plan_revenue : null;
    return { ...r, actual_revenue: actual, variance_pct };
  });
}

function filterByRowType(rows, typeFilter) {
  if (typeFilter === 'all') return rows;
  return rows.filter((r) => {
    const t = String(r.row_type || '').toLowerCase();
    if (typeFilter === 'actual') return t === 'actual';
    if (typeFilter === 'projected') return t.includes('project');
    if (typeFilter === 'missing') return t.includes('missing');
    return true;
  });
}

function DailyView({ brand, asOf }) {
  const [monthKey, setMonthKey] = useState(() => defaultMonthKey(asOf));
  const [typeFilter, setTypeFilter] = useState('all');
  const [rows, setRows] = useState([]);
  const [brandRows, setBrandRows] = useState([]);
  const [loadedAsOf, setLoadedAsOf] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rowHover, setRowHover] = useState(null);

  useEffect(() => {
    setMonthKey(defaultMonthKey(asOf));
  }, [brand, asOf]);

  const { start, end } = useMemo(() => monthBounds(monthKey), [monthKey]);
  const showAir = brand === 'NOBL';
  const isAll = brand === 'ALL';

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getForecastDaily(brand, start, end)
      .then((d) => {
        if (!alive) return;
        const series = brand === 'ALL'
          ? (d?.combined || [])
          : (d?.brands?.find((b) => b.brand === brand)?.daily || d?.brands?.[0]?.daily || []);
        setRows(series);
        setBrandRows(d?.brands || []);
        setLoadedAsOf(d?.as_of || null);
      })
      .catch((e) => { if (alive) setError(e.message || String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [brand, start, end]);

  const filteredRows = useMemo(
    () => filterByRowType(rows, typeFilter).map((r) => ({
      ...r,
      _key: r.date,
      _highlight: loadedAsOf && r.date === loadedAsOf,
    })),
    [rows, typeFilter, loadedAsOf],
  );

  const tableRows = useMemo(
    () => [...filteredRows].sort((a, b) => b.date.localeCompare(a.date)),
    [filteredRows],
  );

  const { page, setPage, pageItems, totalRows } = useClientPagination(
    tableRows, TABLE_PAGE_SIZE, [tableRows.length, monthKey, typeFilter, brand],
  );

  const chartRows = useMemo(() => rows.map((r) => ({
    date: r.date,
    actual: r.actual_revenue,
    forecast: Number(r.forecast_revenue) || null,
    plan: Number(r.plan_revenue) || null,
  })), [rows]);

  const period = useMemo(() => {
    let a = 0; let f = 0; let days = 0;
    for (const r of rows) {
      if (r.actual_revenue != null) {
        a += Number(r.actual_revenue) || 0;
        f += Number(r.forecast_revenue) || 0;
        days += 1;
      }
    }
    const pct = days > 0 && f > 0 ? (a - f) / f : null;
    return { actual: days > 0 ? a : null, forecast: days > 0 ? f : null, pct, days };
  }, [rows]);

  const fcFromRows = useMemo(() => {
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
    return {
      rowForDate: (d) => byDate[d] || null,
      forecastForDate: (d) => (byDate[d] ? Number(byDate[d].forecast_revenue) : null),
    };
  }, [rows]);

  const hoverPayload = (r) => ({
    date: r.date,
    status: r.status,
    forecast: r.forecast_revenue,
    actual: r.actual_revenue,
    variancePct: r.variance_pct,
    forecast_air_revenue: r.forecast_air_revenue,
    actual_air_revenue: r.actual_air_revenue,
    forecast_spend: r.forecast_spend,
    actual_mer: r.actual_mer,
    mer_target: r.mer_target,
    target_status: r.target_status,
  });

  const rowHoverable = (r) => {
    if (isAll) return r.nobl_actual != null || r.flo_actual != null || r.actual_revenue != null;
    return r.row_type === 'Actual' || r.row_type === 'Missing Actual';
  };

  const handleRowHover = (r, rect) => {
    if (!r) { setRowHover(null); return; }
    setRowHover({ data: hoverPayload(r), rect });
  };

  const dailyColumns = useMemo(() => {
    if (isAll) {
      return [
        { label: 'Date', align: 'left', bold: true, render: (r) => fmtDayLabel(r.date) },
        { label: 'Type', align: 'left', render: (r) => <RowTypeBadge value={r.row_type || (r.actual_revenue != null ? 'Actual' : 'Projected')} /> },
        { label: 'NOBL forecast', render: (r) => money(r.nobl_forecast) },
        { label: 'NOBL actual', render: (r) => money(r.nobl_actual) },
        { label: 'FLO forecast', render: (r) => money(r.flo_forecast) },
        { label: 'FLO actual', render: (r) => money(r.flo_actual) },
        { label: 'Total forecast', render: (r) => money(r.forecast_revenue) },
        { label: 'Total actual', render: (r) => money(r.actual_revenue) },
        { label: 'Variance', render: (r) => (r.actual_revenue == null ? '—' : <ForecastVariancePill pct={r.variance_pct} statusOverride={r.status} />) },
      ];
    }
    const cols = [
      { label: 'Date', align: 'left', bold: true, render: (r) => fmtDayLabel(r.date) },
      { label: 'Type', align: 'left', render: (r) => <RowTypeBadge value={r.row_type} /> },
      { label: 'Plan', render: (r) => money(r.plan_revenue) },
      { label: 'Forecast', render: (r) => money(r.forecast_revenue) },
      { label: 'Actual', render: (r) => money(r.actual_revenue) },
      { label: 'Variance', render: (r) => (r.actual_revenue == null ? '—' : <ForecastVariancePill pct={r.variance_pct} statusOverride={r.status} />) },
      { label: 'Spend', render: (r) => money(r.actual_spend ?? r.forecast_spend) },
      { label: 'MER', render: (r) => (r.actual_mer != null ? ratio(r.actual_mer) : (r.forecast_mer != null ? ratio(r.forecast_mer) : '—')) },
    ];
    if (showAir) {
      cols.push(
        { label: 'Air forecast', render: (r) => money(r.forecast_air_revenue) },
        { label: 'Air actual', render: (r) => money(r.actual_air_revenue) },
      );
    }
    cols.push({ label: 'Status', align: 'left', render: (r) => <RowTypeBadge value={r.target_status || r.row_type} /> });
    return cols;
  }, [isAll, showAir]);

  if (loading) return <LoadingState label="Loading daily forecast…" />;
  if (error) return <div className="card card--pad" style={{ color: 'var(--danger)', fontSize: 13 }}>Daily forecast error: {error}</div>;
  if (!rows.length) {
    return (
      <div className="card card--pad" style={{ color: 'var(--text3)', fontSize: 13, textAlign: 'center' }}>
        No forecast rows for {monthLabel(monthKey)}. Pick another month or refresh ETL actuals.
      </div>
    );
  }

  return (
    <>
      <section className="card card--pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
        <div>
          <div style={filterLabel}>Month</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button type="button" className="btn btn--sm" disabled={monthKey === MONTHS_2026[0]} onClick={() => setMonthKey(shiftMonth(monthKey, -1))} aria-label="Previous month">‹</button>
            <select value={monthKey} onChange={(e) => setMonthKey(e.target.value)} style={{ ...controlStyle, flex: 1 }}>
              {MONTHS_2026.map((mk) => (
                <option key={mk} value={mk}>{monthLabel(mk)}</option>
              ))}
            </select>
            <button type="button" className="btn btn--sm" disabled={monthKey === MONTHS_2026[MONTHS_2026.length - 1]} onClick={() => setMonthKey(shiftMonth(monthKey, 1))} aria-label="Next month">›</button>
          </div>
        </div>
        <div>
          <div style={filterLabel}>Row type</div>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={controlStyle}>
            <option value="all">All rows</option>
            <option value="actual">Actual only</option>
            <option value="projected">Projected only</option>
            <option value="missing">Missing actuals</option>
          </select>
        </div>
        <div style={{ gridColumn: '1 / -1', fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.5, paddingTop: 4 }}>
          <strong style={{ color: 'var(--text2)' }}>Plan</strong> = calendar target from May+ Drops.
          {' '}<strong style={{ color: 'var(--text2)' }}>Forecast</strong> = engine output (actual days use TW; future days use plan).
          {' '}Green/red compares <strong style={{ color: 'var(--text2)' }}>actual vs forecast</strong> on completed days.
          {loadedAsOf && <> Actuals through <strong style={{ color: 'var(--text2)' }}>{loadedAsOf}</strong>.</>}
        </div>
      </section>

      {period.actual != null && (
        <div className="section">
          <div className="section__head">
            <div className="section__title">{monthLabel(monthKey)} · actual vs forecast</div>
            <ForecastVsBadge actual={period.actual} forecast={period.forecast} label={`MTD · ${period.days} days`} />
          </div>
          <div className="page-kpi-grid">
            <KpiCard label="Actual MTD" value={money(period.actual)} sub={`${period.days} completed days`} accent="nobl" />
            <KpiCard label="Forecast MTD" value={money(period.forecast)} sub="Same completed days" accent="accent" />
            <KpiCard
              label="Variance"
              value={fmtPctSigned(period.pct)}
              sub={STATUS[varianceStatus(period.pct)].label}
              accent={varianceStatus(period.pct) === 'red' ? 'danger' : varianceStatus(period.pct) === 'amber' ? 'warn' : 'success'}
            />
          </div>
        </div>
      )}

      <ChartPanel
        title={`${monthLabel(monthKey)} daily trend`}
        subtitle={isAll ? 'Combined NOBL + FLO store revenue' : `${brand} — solid = actual, dashed = forecast, dotted = plan`}
      >
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartRows} margin={{ top: 8, right: 18, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id="fcaDailyActual" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--success)" stopOpacity={0.35} />
                <stop offset="95%" stopColor="var(--success)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tickFormatter={fmtDayLabel} tick={{ fontSize: 10 }} stroke="var(--border2)" />
            <YAxis tickFormatter={fmt$} tick={{ fontSize: 11 }} width={74} stroke="var(--border2)" />
            <Tooltip content={<ForecastChartTooltip fc={fcFromRows} labelFormatter={fmtDayLabel} formatter={(v) => money(v)} />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area dataKey="actual" name="Actual" stroke="var(--success)" fill="url(#fcaDailyActual)" strokeWidth={2} dot={false} connectNulls={false} />
            <Line dataKey="forecast" name="Forecast" stroke="var(--accent)" strokeWidth={2.25} strokeDasharray="5 4" dot={false} connectNulls />
            {!isAll && <Line dataKey="plan" name="Plan" stroke="var(--warn)" strokeWidth={1.75} strokeDasharray="2 4" dot={false} connectNulls />}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartPanel>

      <ChartPanel
        title="Daily detail"
        subtitle={`${totalRows} rows · hover a row for breakdown · ${isAll ? 'select NOBL for Air columns' : 'includes Air metrics'}`}
      >
        <DataTable
          columns={dailyColumns}
          rows={pageItems}
          page={page}
          pageSize={TABLE_PAGE_SIZE}
          totalRows={totalRows}
          onPageChange={setPage}
          onRowHover={handleRowHover}
          rowHoverable={rowHoverable}
        />
        {isAll && brandRows.length > 0 && (
          <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 10, marginBottom: 0 }}>
            All brands combines NOBL + FLO store revenue. Select NOBL for Air forecast/actual and target status.
          </p>
        )}
      </ChartPanel>
      <ForecastHoverTooltip data={rowHover?.data} anchorRect={rowHover?.rect} visible={!!rowHover} />
    </>
  );
}

export default function ForecastVsActualsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('NOBL');
  const [gran, setGran] = useState('daily');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    getForecastEngine('ALL')
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message || String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const brands = useMemo(() => data?.brands || [], [data]);
  const viewOptions = useMemo(
    () => ['NOBL', 'FLO', 'ALL', ...brands.map((b) => b.brand).filter((b) => !['NOBL', 'FLO', 'ALL'].includes(b))],
    [brands],
  );
  const uniqueViewOptions = useMemo(() => [...new Set(viewOptions)], [viewOptions]);

  const activeBrand = view === 'ALL' ? null : brands.find((b) => b.brand === view);

  const monthlyRows = useMemo(() => {
    if (view === 'ALL') return combineMonthly(brands);
    return (activeBrand?.monthly || []).map((r) => ({
      ...r,
      variance_pct: r.variance_pct ?? (r.plan_revenue > 0 ? (r.projected_revenue - r.plan_revenue) / r.plan_revenue : null),
    }));
  }, [view, brands, activeBrand]);

  const chartRows = useMemo(() => monthlyRows.map((r) => ({
    month: shortMonth(r.month),
    actual: r.actual_revenue,
    projected: r.projected_revenue,
    plan: r.plan_revenue || null,
  })), [monthlyRows]);

  const fy = useMemo(() => {
    if (view === 'ALL') return data?.combined || null;
    return activeBrand?.full_year || null;
  }, [view, data, activeBrand]);

  const monthlyColumns = [
    { label: 'Month', align: 'left', bold: true, render: (r) => r.month },
    { label: 'Plan', render: (r) => money(r.plan_revenue || null) },
    { label: 'Actual', render: (r) => money(r.actual_revenue) },
    { label: 'Forecast (P50)', render: (r) => money(r.projected_revenue) },
    { label: 'Variance vs plan', render: (r) => <VarianceCell pct={r.variance_pct} /> },
  ];

  if (loading) return <LoadingState label="Loading forecast vs actuals…" />;
  if (error) return <div className="card card--pad" style={{ color: 'var(--danger)', fontSize: 13 }}>Forecast error: {error}</div>;

  return (
    <div className="page-stack">
      <PageIntro
        actions={data?.as_of ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text2)',
            background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 20, padding: '4px 12px', whiteSpace: 'nowrap',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
            Actuals through {data.as_of}
          </span>
        ) : null}
      >
        <div style={{ color: 'var(--text3)', fontSize: 12.5, lineHeight: 1.55, maxWidth: 720 }}>
          Compare store performance against the computed forecast engine — plan calendar from May+ Drops,
          actuals from Triple Whale, projected days from the same logic as your Apps Script automation.
          Green means at or ahead of forecast; red means behind.
        </div>
      </PageIntro>

      <div className="page-filter-bar">
        <div className="page-filter-bar__inner" style={{ justifyContent: 'space-between', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="page-filter-bar__label">Brand</span>
            <div className="seg">
              {uniqueViewOptions.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`seg__btn${view === opt ? ' seg__btn--active' : ''}`}
                  onClick={() => setView(opt)}
                >
                  {opt === 'ALL' ? 'All brands' : opt}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="page-filter-bar__label">View</span>
            <div className="seg">
              {[['daily', 'Daily'], ['monthly', 'Monthly']].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`seg__btn${gran === id ? ' seg__btn--active' : ''}`}
                  onClick={() => setGran(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {gran === 'daily' ? (
        <DailyView brand={view} asOf={data?.as_of} />
      ) : (
        <>
          {fy && (
            <div className="section">
              <div className="section__title">Full year · actual vs forecast vs plan</div>
              <div className="page-kpi-grid">
                <KpiCard label="Plan (FY)" value={money(fy.plan_revenue)} sub="Annual calendar target" />
                <KpiCard label="Actual to date" value={money(fy.actual_revenue)} sub={`Through ${data?.as_of || 'latest'}`} accent="nobl" />
                <KpiCard label="Forecast (FY P50)" value={money(fy.projected_revenue)} sub="Engine projection" accent="accent" />
                <KpiCard
                  label="Variance vs plan"
                  value={fmtPctSigned(fy.variance_pct)}
                  sub={STATUS[varianceStatus(fy.variance_pct)].label}
                  accent={varianceStatus(fy.variance_pct) === 'red' ? 'danger' : varianceStatus(fy.variance_pct) === 'amber' ? 'warn' : 'success'}
                />
                <KpiCard label="Actual MER" value={ratio(fy.actual_mer)} sub="Sales ÷ ad spend" />
                <KpiCard label="Forecast MER" value={ratio(fy.projected_mer)} sub="Engine P50" accent="accent" />
              </div>
            </div>
          )}

          <div className="chart-grid-2">
            <ChartPanel
              title={`Monthly revenue — ${view === 'ALL' ? 'All brands' : view}`}
              subtitle="Bars = actual booked. Lines = forecast P50 and plan target."
            >
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={chartRows} margin={{ top: 8, right: 18, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="var(--border2)" />
                  <YAxis tickFormatter={fmt$} tick={{ fontSize: 11 }} width={74} stroke="var(--border2)" />
                  <Tooltip formatter={(v, n) => [money(v), n]} contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="actual" name="Actual" fill="var(--success)" radius={[3, 3, 0, 0]} />
                  <Line dataKey="projected" name="Forecast (P50)" stroke="var(--accent)" strokeWidth={2.5} dot={{ r: 2 }} />
                  <Line dataKey="plan" name="Plan" stroke="var(--warn)" strokeWidth={2.5} strokeDasharray="5 4" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel title="How to read this page" subtitle="Matches your sheet terminology">
              <div style={{ display: 'grid', gap: 8, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text2)' }}>
                <div style={{ padding: 12, borderRadius: 12, background: 'var(--bg3)', border: '1px solid var(--border)' }}>
                  <strong style={{ color: 'var(--warn)' }}>Plan</strong> — daily calendar from May+ Drops tabs (imported to DB).
                </div>
                <div style={{ padding: 12, borderRadius: 12, background: 'var(--bg3)', border: '1px solid var(--border)' }}>
                  <strong style={{ color: 'var(--accent)' }}>Forecast</strong> — engine output: actual days use TW; future days use plan pacing.
                </div>
                <div style={{ padding: 12, borderRadius: 12, background: 'var(--bg3)', border: '1px solid var(--border)' }}>
                  <strong style={{ color: 'var(--success)' }}>Actual</strong> — Triple Whale daily summary (completed days only).
                </div>
                <div style={{ padding: 12, borderRadius: 12, background: 'var(--success-dim)', border: '1px solid rgba(31,122,82,.2)', color: 'var(--success)', fontWeight: 700 }}>
                  Daily view compares actual vs forecast on each completed day — same as your audit sheet variance.
                </div>
              </div>
            </ChartPanel>
          </div>

          <ChartPanel title="Monthly breakdown" subtitle="Variance = forecast P50 vs plan (same as monthly summary in your automation).">
            <DataTable columns={monthlyColumns} rows={monthlyRows} />
          </ChartPanel>
        </>
      )}
    </div>
  );
}
