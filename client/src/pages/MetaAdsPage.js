import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Line, ComposedChart } from 'recharts';
import DateRangePicker from '../components/DateRangePicker';
import KpiCard from '../components/KpiCard';
import SheetTable from '../components/SheetTable';
import { getMetaAds, fmt$, fmtNum, fmtPct } from '../utils/api';

function toISO(d) { return d.toISOString().slice(0, 10); }
function shortName(s, max = 24) {
  const name = String(s || 'Unknown');
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

const HEADERS = [
  'Campaign', 'Ad Set', 'Ad', 'Spend', 'Revenue', 'Purchases', 'ROAS', 'CAC',
  'Impressions', 'Clicks', 'Link Clicks', 'CTR', 'CPC', 'CPM', 'Add To Cart', 'Checkout',
];

function toTableRow(r) {
  return {
    'Campaign': r.campaign_name || 'Unknown campaign',
    'Ad Set': r.adset_name || 'Unknown ad set',
    'Ad': r.ad_name || 'All ads',
    'Spend': r.spend,
    'Revenue': r.revenue,
    'Purchases': r.purchases,
    'ROAS': r.roas,
    'CAC': r.cac,
    'Impressions': r.impressions,
    'Clicks': r.clicks,
    'Link Clicks': r.link_clicks,
    'CTR': r.ctr,
    'CPC': r.cpc,
    'CPM': r.cpm,
    'Add To Cart': r.add_to_cart,
    'Checkout': r.initiate_checkout,
    _key: r.ad_id || r.adset_id || r.campaign_id,
  };
}

export default function MetaAdsPage() {
  const [range, setRange] = useState({ start: '2026-03-01', end: toISO(new Date()) });
  const [level, setLevel] = useState('adset');
  const [levelOpen, setLevelOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ rows: [], totals: {} });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await getMetaAds(range.start, range.end, level, 'NOBL');
      setData({ rows: res.rows || [], totals: res.totals || {} });
    } catch (e) {
      setError(e.message || 'Failed to load Meta ads');
    } finally {
      setLoading(false);
    }
  }, [range, level]);

  useEffect(() => { load(); }, [load]);

  const tableRows = useMemo(() => (data.rows || []).map(toTableRow), [data.rows]);
  const chartRows = useMemo(() => (data.rows || []).slice(0, 12).map(r => ({
    ...r,
    label: shortName(level === 'ad' ? r.ad_name : level === 'adset' ? r.adset_name : r.campaign_name),
  })), [data.rows, level]);
  const t = data.totals || {};

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20, gap:12, flexWrap:'wrap' }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:800, margin:0, fontFamily:'var(--font-head)', color:'#1877f2' }}>Meta Ads</h1>
          <p style={{ margin:'4px 0 0', fontSize:13, color:'var(--text3)' }}>Saved Triple Whale Meta performance by campaign, ad set, and ad</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          <LevelDropdown value={level} open={levelOpen} onOpenChange={setLevelOpen} onChange={setLevel} />
          <DateRangePicker start={range.start} end={range.end} onChange={setRange} scope="meta-ads" />
        </div>
      </div>

      {loading ? <div style={{ height:260, borderRadius:12, background:'var(--bg2)', animation:'pulse 1.5s ease-in-out infinite' }} /> : error ? (
        <div style={{ color:'var(--danger)', fontSize:13 }}>Failed to load Meta Ads: {error}</div>
      ) : (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:12, marginBottom:20 }}>
            <KpiCard label="Spend" value={fmt$(t.spend || 0)} />
            <KpiCard label="Revenue" value={fmt$(t.revenue || 0)} />
            <KpiCard label="Purchases" value={fmtNum(t.purchases || 0)} />
            <KpiCard label="ROAS" value={t.roas ? `${Number(t.roas).toFixed(2)}x` : '—'} />
            <KpiCard label="CAC" value={t.cac ? fmt$(t.cac) : '—'} />
            <KpiCard label="CTR" value={t.ctr ? fmtPct(t.ctr) : '—'} />
          </div>

          <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20, marginBottom:16 }}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Top Meta {level === 'adset' ? 'Ad Sets' : level === 'ad' ? 'Ads' : 'Campaigns'}</div>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartRows} margin={{ top:4, right:16, left:0, bottom:72 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize:10 }} stroke="var(--border2)" angle={-30} textAnchor="end" interval={0} height={72} />
                <YAxis yAxisId="spend" tickFormatter={fmt$} tick={{ fontSize:11 }} width={72} stroke="var(--border2)" />
                <YAxis yAxisId="roas" orientation="right" tick={{ fontSize:11 }} width={48} stroke="var(--border2)" />
                <Tooltip formatter={(v, n) => n === 'ROAS' ? [`${Number(v || 0).toFixed(2)}x`, n] : [fmt$(v), n]} contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} />
                <Legend wrapperStyle={{ fontSize:12 }} />
                <Bar yAxisId="spend" dataKey="spend" name="Spend" fill="#1877f2" radius={[2,2,0,0]} />
                <Line yAxisId="roas" dataKey="roas" name="ROAS" stroke="#22c55e" strokeWidth={2} dot={{ r:3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20 }}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Meta Ads Detail</div>
            <SheetTable headers={HEADERS} rows={tableRows} keyField="_key" maxHeight="620px" defaultSortField="Spend" defaultSortDir="desc" />
          </div>
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
