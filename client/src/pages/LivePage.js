/**
 * LivePage — Real-time dashboard from PostgreSQL (synced TripleWhale data)
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

// ── Helpers ───────────────────────────────────────────────────────────────────
const API = (path) => fetch(path, { credentials: 'include' }).then(r => r.json());

const fmt = {
  currency: (v) => {
    if (v == null || isNaN(v)) return '—';
    const n = Number(v);
    return n >= 1e6 ? `$${(n/1e6).toFixed(2)}M`
         : n >= 1000 ? `$${(n/1000).toFixed(1)}K`
         : `$${n.toFixed(0)}`;
  },
  number: (v) => v == null ? '—' : Number(v).toLocaleString(),
  ratio:  (v) => v == null ? '—' : Number(v).toFixed(2) + 'x',
  pct:    (v) => v == null ? '—' : (Number(v) * 100).toFixed(1) + '%',
  date:   (v) => v ? String(v).slice(5) : '—',
};

const STATUS_COLOR = {
  green:  '#22c55e',
  yellow: '#f59e0b',
  red:    '#ef4444',
  gray:   '#6b7280',
};

const STATUS_BG = {
  green:  'rgba(34,197,94,.1)',
  yellow: 'rgba(245,158,11,.1)',
  red:    'rgba(239,68,68,.1)',
  gray:   'rgba(107,114,128,.08)',
};

const CHANNEL_META = {
  META:     { label: 'Meta',       color: '#1877f2' },
  GOOGLE:   { label: 'Google',     color: '#ea4335' },
  APPLOVIN: { label: 'AppLovin',   color: '#ff6b35' },
  TIKTOK:   { label: 'TikTok',     color: '#69c9d0' },
  SNAPCHAT: { label: 'Snapchat',   color: '#fffc00' },
  BING:     { label: 'Bing',       color: '#008373' },
  PINTEREST:{ label: 'Pinterest',  color: '#e60023' },
  X:        { label: 'X/Twitter',  color: '#000000' },
};

const GEO_LABELS = { US:'🇺🇸 US', CA:'🇨🇦 Canada', AUS:'🇦🇺 Australia', DUBAI:'🇦🇪 Dubai', EU:'🇪🇺 EU', TOTAL:'Total' };

// ── Small reusable components ─────────────────────────────────────────────────
function Dot({ status, size = 8 }) {
  return <span style={{ display:'inline-block', width:size, height:size, borderRadius:'50%', background: STATUS_COLOR[status]||STATUS_COLOR.gray, flexShrink:0 }} />;
}

function Badge({ status, children }) {
  const c = STATUS_COLOR[status] || STATUS_COLOR.gray;
  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap:5,
      padding:'2px 8px', borderRadius:6,
      background: STATUS_BG[status]||'rgba(107,114,128,.08)',
      border:`1px solid ${c}33`, color:c,
      fontWeight:700, fontSize:12,
    }}>
      <Dot status={status} size={6} />{children}
    </span>
  );
}

function KpiCard({ label, value, format='currency', status, note }) {
  const c  = status ? STATUS_COLOR[status] : undefined;
  const bg = status ? STATUS_BG[status]    : undefined;
  return (
    <div style={{
      background: bg || 'var(--bg2)',
      border:`1px solid ${status ? (c+'44') : 'var(--border2)'}`,
      borderRadius:12, padding:'16px 20px',
      display:'flex', flexDirection:'column', gap:5,
    }}>
      <div style={{ fontSize:11, fontWeight:600, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.06em' }}>{label}</div>
      <div style={{ fontSize:26, fontWeight:800, color: c || 'var(--text)', lineHeight:1 }}>
        {fmt[format]?.(value) ?? '—'}
      </div>
      {note && <div style={{ fontSize:11, color:'var(--text3)' }}>{note}</div>}
    </div>
  );
}

function SectionHead({ title, sub }) {
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontSize:15, fontWeight:700, color:'var(--text)' }}>{title}</div>
      {sub && <div style={{ fontSize:12, color:'var(--text3)', marginTop:2 }}>{sub}</div>}
    </div>
  );
}

function Card({ children, style }) {
  return (
    <div style={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:12, overflow:'hidden', ...style }}>
      {children}
    </div>
  );
}

function CardTitle({ children }) {
  return <div style={{ fontSize:12, fontWeight:700, color:'var(--text2)', padding:'12px 16px 0' }}>{children}</div>;
}

function Skeleton({ height=80 }) {
  return <div style={{ height, borderRadius:8, background:'var(--bg3)', animation:'pulse 1.5s ease-in-out infinite' }} />;
}

function ErrorBox({ error, onRetry }) {
  return (
    <div style={{ background:'rgba(239,68,68,.08)', border:'1px solid rgba(239,68,68,.25)', borderRadius:10, padding:'16px 20px', display:'flex', alignItems:'center', gap:16 }}>
      <div style={{ flex:1 }}>
        <div style={{ fontWeight:700, color:'var(--danger)', marginBottom:4, fontSize:13 }}>Failed to load data</div>
        <code style={{ fontSize:11, color:'var(--text3)' }}>{error}</code>
      </div>
      {onRetry && <button onClick={onRetry} style={{ padding:'6px 14px', borderRadius:7, background:'var(--accent)', color:'#fff', border:'none', fontSize:12, fontWeight:600, cursor:'pointer' }}>Retry</button>}
    </div>
  );
}

// ── Trend Chart ───────────────────────────────────────────────────────────────
function TrendChart({ data, metric, color, formatY }) {
  if (!data?.length) return <div style={{ height:160, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text3)', fontSize:12 }}>No data</div>;
  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={data} margin={{ top:4, right:8, left:0, bottom:0 }}>
        <defs>
          <linearGradient id={`g-${metric}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0}   />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="date" tickFormatter={fmt.date} tick={{ fontSize:10, fill:'var(--text3)' }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize:10, fill:'var(--text3)' }} tickFormatter={formatY} width={52} />
        <Tooltip
          contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:8, fontSize:12 }}
          labelStyle={{ color:'var(--text2)', fontWeight:600 }}
          formatter={(v) => [formatY(v)]}
        />
        <Area type="monotone" dataKey={metric} stroke={color} strokeWidth={2} fill={`url(#g-${metric})`} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Channel Spend Bar ─────────────────────────────────────────────────────────
function ChannelSpendBar({ channels }) {
  if (!channels?.length) return <div style={{ height:160, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text3)', fontSize:12 }}>No channel data</div>;
  const data = channels.map(c => ({
    name:  CHANNEL_META[c.channel]?.label || c.channel,
    spend: Math.round(c.spend || 0),
    color: CHANNEL_META[c.channel]?.color || '#6b7280',
  }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 30)}>
      <BarChart data={data} layout="vertical" margin={{ top:4, right:16, left:60, bottom:4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
        <XAxis type="number" tick={{ fontSize:10, fill:'var(--text3)' }} tickFormatter={v=>`$${(v/1000).toFixed(0)}K`} />
        <YAxis dataKey="name" type="category" tick={{ fontSize:11, fill:'var(--text2)' }} width={58} />
        <Tooltip
          contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:8, fontSize:12 }}
          formatter={v=>[fmt.currency(v), 'Spend']}
        />
        <Bar dataKey="spend" radius={[0,4,4,0]}>
          {data.map(d => <Cell key={d.name} fill={d.color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Channel Table ─────────────────────────────────────────────────────────────
function ChannelTable({ channels, loading }) {
  if (loading) return <div style={{ padding:16 }}><Skeleton /><div style={{ height:8 }} /><Skeleton /><div style={{ height:8 }} /><Skeleton /></div>;
  if (!channels?.length) return <div style={{ padding:'20px 16px', color:'var(--text3)', fontSize:13 }}>No channel data for this date</div>;

  return (
    <div style={{ overflowX:'auto' }}>
      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
        <thead>
          <tr style={{ background:'var(--bg3)' }}>
            {['Channel','Spend','Revenue','ROAS','Purchases','NC Orders','CAC','AOV'].map(h => (
              <th key={h} style={{ padding:'9px 12px', textAlign:'left', fontSize:11, fontWeight:600, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.04em', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {channels.map((ch, i) => {
            const meta = CHANNEL_META[ch.channel] || {};
            const aov = ch.purchases > 0 ? ch.revenue / ch.purchases : 0;
            return (
              <tr key={ch.channel} style={{ background: i%2 ? 'var(--bg3)' : 'transparent' }}>
                <td style={{ padding:'10px 12px', borderBottom:'1px solid var(--border)' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ width:10, height:10, borderRadius:2, background: meta.color||'#888', flexShrink:0 }} />
                    <span style={{ fontWeight:600, color:'var(--text)' }}>{meta.label || ch.channel}</span>
                  </span>
                </td>
                <td style={{ padding:'10px 12px', color:'var(--text2)', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{fmt.currency(ch.spend)}</td>
                <td style={{ padding:'10px 12px', color:'var(--text2)', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{fmt.currency(ch.revenue)}</td>
                <td style={{ padding:'10px 12px', borderBottom:'1px solid var(--border)' }}>
                  <Badge status={ch.roas_status}>{fmt.ratio(ch.roas)}</Badge>
                </td>
                <td style={{ padding:'10px 12px', color:'var(--text2)', borderBottom:'1px solid var(--border)' }}>{fmt.number(ch.purchases)}</td>
                <td style={{ padding:'10px 12px', color:'var(--text2)', borderBottom:'1px solid var(--border)' }}>{fmt.number(ch.nc_orders)}</td>
                <td style={{ padding:'10px 12px', color:'var(--text2)', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{ch.cac > 0 ? fmt.currency(ch.cac) : '—'}</td>
                <td style={{ padding:'10px 12px', color:'var(--text2)', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{aov > 0 ? fmt.currency(aov) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Geo Table ─────────────────────────────────────────────────────────────────
function GeoTable({ geo }) {
  if (!geo?.length) return <div style={{ padding:'16px', color:'var(--text3)', fontSize:13 }}>No regional data</div>;
  const filtered = geo.filter(g => g.region !== 'TOTAL');
  return (
    <div style={{ display:'flex', flexWrap:'wrap', gap:10, padding:'12px 16px' }}>
      {filtered.map(g => (
        <div key={g.region} style={{
          display:'flex', flexDirection:'column', gap:4,
          background: STATUS_BG[g.mer_status]||'var(--bg3)',
          border:`1px solid ${STATUS_COLOR[g.mer_status]||'var(--border)'}33`,
          borderRadius:10, padding:'10px 14px', minWidth:130,
        }}>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--text2)' }}>{GEO_LABELS[g.region] || g.region}</div>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <Badge status={g.mer_status}>MER {fmt.ratio(g.mer)}</Badge>
          </div>
          <div style={{ fontSize:11, color:'var(--text3)' }}>
            {fmt.currency(g.revenue)} rev · {fmt.currency(g.spend)} spend
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Threshold Guide ───────────────────────────────────────────────────────────
function ThresholdGuide() {
  const rules = [
    { label:'MER (Global)', thresholds:['<1.8 🔴','1.8–2.0 🟡','≥2.0 🟢'] },
    { label:'MER (Dubai)',  thresholds:['<1.6 🔴','1.6–1.8 🟡','≥1.8 🟢'] },
    { label:'Meta ROAS',    thresholds:['<1.6 🔴','1.6–1.8 🟡','≥1.8 🟢'] },
    { label:'Google ROAS',  thresholds:['<2.0 🔴','2.0–3.0 🟡','≥3.0 🟢'] },
    { label:'AppLovin',     thresholds:['<2.0 🔴','2.0–2.2 🟡','≥2.2 🟢'] },
  ];
  return (
    <Card>
      <div style={{ padding:'14px 16px' }}>
        <div style={{ fontSize:12, fontWeight:700, color:'var(--text2)', marginBottom:10 }}>Performance Thresholds</div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:20 }}>
          {rules.map(r => (
            <div key={r.label}>
              <div style={{ fontSize:11, fontWeight:600, color:'var(--text3)', marginBottom:4 }}>{r.label}</div>
              <div style={{ display:'flex', gap:8, fontSize:11, color:'var(--text2)' }}>
                {r.thresholds.map(t => <span key={t}>{t}</span>)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function LivePage() {
  const [brand, setBrand]           = useState('nobl');
  const [dateMode, setDateMode]     = useState('latest');
  const [customDate, setCustomDate] = useState('');
  const [trendDays, setTrendDays]   = useState(30);
  const [availDates, setAvailDates] = useState(null);

  const [liveData,    setLiveData]    = useState(null);
  const [trendData,   setTrendData]   = useState(null);
  const [loadingLive, setLoadingLive] = useState(false);
  const [loadingTrend,setLoadingTrend]= useState(false);
  const [errorLive,   setErrorLive]   = useState(null);
  const [errorTrend,  setErrorTrend]  = useState(null);

  // Fetch available date range when brand changes
  useEffect(() => {
    API(`/api/tw/available-dates?brand=${brand}`)
      .then(d => {
        if (d.ok) {
          setAvailDates(d);
          if (!customDate) setCustomDate(d.latest_summary || '');
        }
      }).catch(() => {});
  }, [brand]);

  const resolvedDate = dateMode === 'latest' ? (availDates?.latest_summary || '') : customDate;

  const loadLive = useCallback(async () => {
    if (!resolvedDate) return;
    setLoadingLive(true); setErrorLive(null);
    try {
      const d = await API(`/api/tw/live?brand=${brand}&date=${resolvedDate}`);
      if (!d.ok) throw new Error(d.error || 'API error');
      setLiveData(d);
    } catch (e) { setErrorLive(e.message); }
    finally     { setLoadingLive(false); }
  }, [brand, resolvedDate]);

  const loadTrend = useCallback(async () => {
    if (!resolvedDate) return;
    setLoadingTrend(true); setErrorTrend(null);
    try {
      const d = await API(`/api/tw/trend?brand=${brand}&days=${trendDays}&endDate=${resolvedDate}`);
      if (!d.ok) throw new Error(d.error || 'API error');
      setTrendData(d);
    } catch (e) { setErrorTrend(e.message); }
    finally     { setLoadingTrend(false); }
  }, [brand, trendDays, resolvedDate]);

  useEffect(() => { loadLive();  }, [loadLive]);
  useEffect(() => { loadTrend(); }, [loadTrend]);

  const sum      = liveData?.summary;
  const channels = liveData?.channels || [];
  const geo      = liveData?.geo      || [];
  const trend    = trendData?.trend   || [];

  const BRANDS = [{ k:'nobl', l:'NOBL Air' }, { k:'flo', l:'FLO US' }, { k:'flo_eu', l:'FLO EU' }];

  return (
    <div style={{ maxWidth:1400, margin:'0 auto' }}>

      {/* ── Header ── */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:20, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:800, color:'var(--text)', margin:0 }}>Live Data</h1>
          <div style={{ fontSize:12, color:'var(--text3)', marginTop:3 }}>
            Powered by PostgreSQL · TW sync data
            {availDates && <span style={{ marginLeft:8 }}>· Latest: <strong style={{ color:'var(--text2)' }}>{availDates.latest_summary}</strong></span>}
          </div>
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          {/* Brand */}
          <div style={{ display:'flex', gap:3 }}>
            {BRANDS.map(b => (
              <button key={b.k} onClick={() => setBrand(b.k)} style={{
                padding:'5px 13px', borderRadius:7,
                border:'1px solid var(--border2)',
                background: brand===b.k ? 'var(--accent)' : 'var(--bg3)',
                color: brand===b.k ? '#fff' : 'var(--text2)',
                fontSize:12, fontWeight:600, cursor:'pointer',
              }}>{b.l}</button>
            ))}
          </div>
          {/* Date mode */}
          <div style={{ display:'flex', gap:3 }}>
            {[['latest','Latest'],['custom','Custom']].map(([k,l]) => (
              <button key={k} onClick={() => setDateMode(k)} style={{
                padding:'5px 13px', borderRadius:7,
                border:'1px solid var(--border2)',
                background: dateMode===k ? 'var(--accent)' : 'var(--bg3)',
                color: dateMode===k ? '#fff' : 'var(--text2)',
                fontSize:12, fontWeight:600, cursor:'pointer',
              }}>{l}</button>
            ))}
          </div>
          {dateMode === 'custom' && (
            <input type="date" value={customDate} onChange={e => setCustomDate(e.target.value)}
              min={availDates?.oldest_summary} max={availDates?.latest_summary}
              style={{ padding:'5px 10px', borderRadius:7, border:'1px solid var(--border2)', background:'var(--bg3)', color:'var(--text)', fontSize:12 }} />
          )}
          <button onClick={() => { loadLive(); loadTrend(); }} disabled={loadingLive}
            style={{ padding:'5px 13px', borderRadius:7, border:'1px solid var(--border2)', background:'var(--bg3)', color:'var(--text2)', fontSize:12, fontWeight:600, cursor:'pointer', opacity:loadingLive?0.5:1 }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {errorLive && <div style={{ marginBottom:16 }}><ErrorBox error={errorLive} onRetry={loadLive} /></div>}

      {/* ── Summary KPIs ── */}
      <div style={{ marginBottom:20 }}>
        <SectionHead title="Summary" sub={resolvedDate ? `Showing data for ${resolvedDate}` : 'Loading…'} />
        {loadingLive ? (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(170px,1fr))', gap:12 }}>
            {[...Array(7)].map((_,i) => <Skeleton key={i} />)}
          </div>
        ) : sum ? (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(170px,1fr))', gap:12 }}>
            <KpiCard label="Total Revenue"  value={sum.total_revenue} format="currency" />
            <KpiCard label="Total Spend"    value={sum.total_spend}   format="currency" />
            <KpiCard label="MER"            value={sum.mer}           format="ratio"    status={sum.mer_status}
              note={sum.mer_status==='green' ? '✓ On target' : sum.mer_status==='yellow' ? 'Near target (≥2.0)' : '⚠ Below target (≥2.0)'} />
            <KpiCard label="Total Orders"   value={sum.total_orders}  format="number" />
            <KpiCard label="New Customers"  value={sum.new_customer_orders} format="number"
              note={`${fmt.pct(sum.new_customer_rate)} of orders`} />
            <KpiCard label="Returning"      value={sum.returning_orders} format="number"
              note={`${fmt.pct(1 - sum.new_customer_rate)} of orders`} />
            <KpiCard label="AOV"            value={sum.aov}           format="currency" />
          </div>
        ) : !errorLive && resolvedDate ? (
          <div style={{ color:'var(--text3)', fontSize:13, padding:'12px 0' }}>No summary data for {resolvedDate}</div>
        ) : null}
      </div>

      {/* ── Geo Breakdown ── */}
      {(geo.length > 0 || loadingLive) && (
        <div style={{ marginBottom:20 }}>
          <SectionHead title="Regional MER" sub="Revenue · Spend · MER per region" />
          <Card>
            {loadingLive ? <div style={{ padding:16 }}><Skeleton height={60} /></div> : <GeoTable geo={geo} />}
          </Card>
        </div>
      )}

      {/* ── Trend Charts ── */}
      <div style={{ marginBottom:20 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12, flexWrap:'wrap', gap:8 }}>
          <SectionHead title={`${trendDays}-Day Trend`} sub="Daily MER · Revenue · Spend" />
          <div style={{ display:'flex', gap:3 }}>
            {[7,14,30,60].map(d => (
              <button key={d} onClick={() => setTrendDays(d)} style={{
                padding:'4px 10px', borderRadius:6,
                border:'1px solid var(--border2)',
                background: trendDays===d ? 'var(--accent)' : 'var(--bg3)',
                color: trendDays===d ? '#fff' : 'var(--text3)',
                fontSize:11, fontWeight:600, cursor:'pointer',
              }}>{d}d</button>
            ))}
          </div>
        </div>
        {errorTrend && <ErrorBox error={errorTrend} onRetry={loadTrend} />}
        {!errorTrend && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14 }}>
            <Card>
              <CardTitle>MER (Marketing Efficiency)</CardTitle>
              <div style={{ padding:'8px 12px 14px' }}>
                {loadingTrend ? <Skeleton height={160} /> : <TrendChart data={trend} metric="mer" color="#6366f1" formatY={v=>`${Number(v).toFixed(2)}x`} />}
              </div>
            </Card>
            <Card>
              <CardTitle>Daily Revenue</CardTitle>
              <div style={{ padding:'8px 12px 14px' }}>
                {loadingTrend ? <Skeleton height={160} /> : <TrendChart data={trend} metric="revenue" color="#22c55e" formatY={v=>`$${(v/1000).toFixed(0)}K`} />}
              </div>
            </Card>
            <Card>
              <CardTitle>Daily Spend</CardTitle>
              <div style={{ padding:'8px 12px 14px' }}>
                {loadingTrend ? <Skeleton height={160} /> : <TrendChart data={trend} metric="spend" color="#f59e0b" formatY={v=>`$${(v/1000).toFixed(0)}K`} />}
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* ── Channel Section ── */}
      <div style={{ marginBottom:20 }}>
        <SectionHead title="Channel Breakdown" sub={liveData?.latest_channel_date ? `Most recent channel data: ${liveData.latest_channel_date}` : ''} />
        <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:14, marginBottom:14 }}>
          <Card>
            <CardTitle>Spend by Channel</CardTitle>
            <div style={{ padding:'8px 12px 14px' }}>
              {loadingLive ? <Skeleton height={160} /> : <ChannelSpendBar channels={channels} />}
            </div>
          </Card>
          <Card>
            <CardTitle>ROAS vs Targets</CardTitle>
            <div style={{ padding:'10px 14px 14px', display:'flex', flexWrap:'wrap', gap:8 }}>
              {loadingLive
                ? <Skeleton height={100} />
                : channels.map(ch => {
                  const meta = CHANNEL_META[ch.channel] || {};
                  return (
                    <div key={ch.channel} style={{ display:'flex', alignItems:'center', gap:8, background:'var(--bg3)', borderRadius:8, padding:'8px 12px', border:'1px solid var(--border)', minWidth:130 }}>
                      <span style={{ width:10, height:10, borderRadius:2, background:meta.color||'#888', flexShrink:0 }} />
                      <div>
                        <div style={{ fontSize:11, fontWeight:600, color:'var(--text2)' }}>{meta.label||ch.channel}</div>
                        <div style={{ display:'flex', alignItems:'center', gap:5, marginTop:2 }}>
                          <Badge status={ch.roas_status}>{fmt.ratio(ch.roas)}</Badge>
                          <span style={{ fontSize:10, color:'var(--text3)' }}>{fmt.currency(ch.spend)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })
              }
            </div>
          </Card>
        </div>
        <Card>
          <ChannelTable channels={channels} loading={loadingLive} />
        </Card>
      </div>

      {/* ── Threshold Guide ── */}
      <ThresholdGuide />

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }`}</style>
    </div>
  );
}
