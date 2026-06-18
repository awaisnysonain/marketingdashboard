import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Line, ComposedChart } from 'recharts';
import { getMetaAds, fmt$, fmtNum, fmtPct, fmtRatio } from '../utils/api';
import KpiCard from '../components/KpiCard';
import ChartPanel from '../components/ChartPanel';
import ServerPaginatedSheetTable from '../components/ServerPaginatedSheetTable';
import { TABLE_PAGE_SIZE } from '../constants/pagination';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { SEARCH_ALL_COLUMNS } from '../constants/tableSearch';
import PageIntro from '../components/PageIntro';
import { L, TIP } from '../copy/plainLanguage';
import { useDashboardFilters } from '../context/DashboardFilterContext';

function toISO(d) { return d.toISOString().slice(0, 10); }
function startOfMonthISO() { const d = new Date(); d.setDate(1); return toISO(d); }
function shortName(s, max = 24) {
  const name = String(s || 'Unknown');
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

const HEADERS = [
  'Brand', 'Campaign', 'Campaign ID', 'Ad set', 'Ad set ID', 'Ad', 'Ad ID',
  L.spend, L.revenue, L.purchases, L.roas, L.cac,
  L.impressions, L.clicks, L.linkClicks, L.ctr, L.cpc, L.cpm, L.addToCart, L.checkout,
];

function toTableRow(r) {
  return {
    'Brand': r.brand,
    'Campaign': r.campaign_name || 'Unknown campaign',
    'Campaign ID': r.campaign_id || 'Unknown campaign ID',
    'Ad set': r.adset_name || 'Unknown ad set',
    'Ad set ID': r.adset_id || 'Unknown ad set ID',
    'Ad': r.ad_name || 'All ads',
    'Ad ID': r.ad_id || 'Unknown ad ID',
    [L.spend]: r.spend,
    [L.revenue]: r.revenue,
    [L.purchases]: r.purchases,
    [L.roas]: r.roas,
    [L.cac]: r.cac,
    [L.impressions]: r.impressions,
    [L.clicks]: r.clicks,
    [L.linkClicks]: r.link_clicks,
    [L.ctr]: r.ctr,
    [L.cpc]: r.cpc,
    [L.cpm]: r.cpm,
    [L.addToCart]: r.add_to_cart,
    [L.checkout]: r.initiate_checkout,
    _key: [r.brand, r.campaign_id, r.adset_id, r.ad_id, r.ad_name].map(v => v || '').join('|'),
  };
}

export default function MetaAdsPage() {
  const { dateRange, brandsApi } = useDashboardFilters();
  const brand = brandsApi.meta;
  const [level, setLevel] = useState('ad');
  const [levelOpen, setLevelOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [tableSearch, setTableSearch] = useState('');
  const [tableSearchColumn, setTableSearchColumn] = useState(SEARCH_ALL_COLUMNS);
  const [tableSortBy, setTableSortBy] = useState(L.spend);
  const [tableSortDir, setTableSortDir] = useState('desc');
  const debouncedSearch = useDebouncedValue(tableSearch, 350);
  const debouncedSearchColumn = useDebouncedValue(tableSearchColumn, 0);
  const [loading, setLoading] = useState(true);
  const [tableLoading, setTableLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ rows: [], totals: {}, pagination: {}, chart_rows: [] });

  const load = useCallback(async (targetPage = 1, opts = { full: false }) => {
    if (opts.full) {
      setLoading(true);
      setError(null);
    } else {
      setTableLoading(true);
    }
    try {
      const res = await getMetaAds(
        dateRange.start, dateRange.end, level, brand, targetPage, TABLE_PAGE_SIZE,
        debouncedSearch, debouncedSearchColumn, tableSortBy, tableSortDir,
      );
      setData({
        rows: res.rows || [],
        totals: res.totals || {},
        pagination: res.pagination || {},
        chart_rows: res.chart_rows || [],
      });
      setPage(targetPage);
    } catch (e) {
      if (opts.full) setError(e.message || 'Failed to load Meta ads');
    } finally {
      setLoading(false);
      setTableLoading(false);
    }
  }, [dateRange, level, brand, debouncedSearch, debouncedSearchColumn, tableSortBy, tableSortDir]);

  const handleTableSort = useCallback((field) => {
    setPage(1);
    if (field === tableSortBy) {
      setTableSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setTableSortBy(field);
      setTableSortDir('asc');
    }
  }, [tableSortBy]);

  const loadRef = useRef(load);
  loadRef.current = load;
  const filterMounted = useRef(false);

  useEffect(() => {
    setPage(1);
    loadRef.current(1, { full: true });
  }, [dateRange.start, dateRange.end]);

  useEffect(() => {
    if (!filterMounted.current) {
      filterMounted.current = true;
      return;
    }
    setPage(1);
    loadRef.current(1, { full: false });
  }, [level, brand, debouncedSearch, debouncedSearchColumn, tableSortBy, tableSortDir]);

  const handlePageChange = (nextPage) => {
    if (nextPage === page) return;
    load(nextPage, { full: false });
  };

  const tableRows = useMemo(() => (data.rows || []).map(toTableRow), [data.rows]);
  const chartRows = useMemo(() => (data.chart_rows || []).slice(0, 12).map(r => ({
    ...r,
    label: shortName(level === 'ad' ? r.ad_name : level === 'adset' ? r.adset_name : r.campaign_name),
  })), [data.chart_rows, level]);
  const t = data.totals || {};
  const pagination = data.pagination || {};
  const totalRows = pagination.total_rows ?? 0;
  const hasContent = Boolean(
    (data.rows || []).length
    || (data.chart_rows || []).length
    || Number(t.spend || 0) > 0
    || totalRows > 0,
  );
  const showPageSkeleton = loading && !hasContent;

  return (
    <div className="page-stack">
      <PageIntro
        actions={<LevelDropdown value={level} open={levelOpen} onOpenChange={setLevelOpen} onChange={setLevel} />}
      />

      {showPageSkeleton ? <div style={{ height:260, borderRadius:12, background:'var(--bg2)', animation:'pulse 1.5s ease-in-out infinite' }} /> : error ? (
        <div style={{ color:'var(--danger)', fontSize:13 }}>Failed to load Meta Ads: {error}</div>
      ) : (
        <>
          <div style={{
            opacity: loading ? 0.55 : 1,
            transition: 'opacity .15s',
            pointerEvents: loading ? 'none' : 'auto',
          }}>
          <div className="section">
            <div className="section__title">PERFORMANCE</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(165px, 1fr))', gap:12 }}>
              <KpiCard label={L.spend} value={fmt$(t.spend || 0)} tooltip={TIP.spend} />
              <KpiCard label={L.revenue} value={fmt$(t.revenue || 0)} tooltip={TIP.revenue} />
              <KpiCard label={L.purchases} value={fmtNum(t.purchases || 0)} tooltip={TIP.purchases} />
              <KpiCard label={L.roas} value={t.roas ? fmtRatio(t.roas) : '—'} tooltip={TIP.roas} />
              <KpiCard label={L.cac} value={t.cac ? fmt$(t.cac) : '—'} tooltip={TIP.cac} />
              <KpiCard label={L.ctr} value={t.ctr ? fmtPct(t.ctr) : '—'} tooltip={TIP.ctr} />
              <KpiCard label="Total rows" value={fmtNum(totalRows)} />
            </div>
          </div>

          <ChartPanel title={`Top Meta ${level === 'adset' ? 'Ad Sets' : level === 'ad' ? 'Ads' : 'Campaigns'}`}>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartRows} margin={{ top:4, right:16, left:0, bottom:72 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize:10 }} stroke="var(--border2)" angle={-30} textAnchor="end" interval={0} height={72} />
                <YAxis yAxisId="spend" tickFormatter={fmt$} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                <YAxis yAxisId="roas" orientation="right" tick={{ fontSize:11 }} width={48} stroke="var(--border2)" />
                <Tooltip formatter={(v, n) => n === 'ROAS' ? [fmtRatio(v || 0), n] : [fmt$(v), n]} contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
                <Legend wrapperStyle={{ fontSize:12 }} />
                <Bar yAxisId="spend" dataKey="spend" name={L.spend} fill="#1877f2" radius={[2,2,0,0]} />
                <Line yAxisId="roas" dataKey="roas" name={L.roas} stroke="#22c55e" strokeWidth={2} dot={{ r:3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartPanel>
          </div>

          <ServerPaginatedSheetTable
            title="Meta Ads Detail"
            headers={HEADERS}
            rows={tableRows}
            keyField="_key"
            page={page}
            totalRows={totalRows}
            onPageChange={handlePageChange}
            search={tableSearch}
            onSearchChange={(v) => { setTableSearch(v); setPage(1); }}
            searchColumn={tableSearchColumn}
            onSearchColumnChange={(col) => { setTableSearchColumn(col); setPage(1); }}
            loading={tableLoading || loading}
            sortBy={tableSortBy}
            sortDir={tableSortDir}
            onSort={handleTableSort}
          />
        </>
      )}
    </div>
  );
}

function LevelDropdown({ value, open, onOpenChange, onChange }) {
  const options = [
    { value: 'campaign', label: 'Campaign' },
    { value: 'adset', label: 'Ad Set' },
    { value: 'ad', label: 'Ad' },
  ];
  const current = options.find(o => o.value === value) || options[1];

  return (
    <div style={{ position:'relative' }}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        onBlur={() => setTimeout(() => onOpenChange(false), 120)}
        style={{
          minWidth:124, height:40, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
          background:'var(--bg2)', color:'var(--text)', border:'1px solid var(--border2)', borderRadius:8,
          padding:'0 12px', fontSize:12.5, fontWeight:500, boxShadow:'var(--shadow-sm)',
        }}
      >
        <span>{current.label}</span>
        <span style={{ width:8, height:8, borderRight:'1.6px solid currentColor', borderBottom:'1.6px solid currentColor', transform: open ? 'rotate(225deg)' : 'rotate(45deg)', marginTop: open ? 4 : -4 }} />
      </button>
      {open && (
        <div style={{
          position:'absolute', top:46, left:0, zIndex:50, minWidth:124, overflow:'hidden',
          background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:8, boxShadow:'var(--shadow)',
        }}>
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onChange(opt.value); onOpenChange(false); }}
              style={{
                width:'100%', textAlign:'left', padding:'9px 12px', border:0, display:'block',
                background: opt.value === value ? 'var(--accent-dim)' : 'var(--bg2)',
                color: opt.value === value ? 'var(--text)' : 'var(--text2)', fontSize:12.5,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
