import React, { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';

// ── Utils ─────────────────────────────────────────────────────────────────────
const API = (path) => fetch(path, { credentials: 'include' }).then(r => r.json());

const fmt = {
  currency: (v) => {
    if (v == null || isNaN(v)) return '—';
    const n = Number(v);
    if (n >= 1e6)  return `$${(n/1e6).toFixed(2)}M`;
    if (n >= 1000) return `$${(n/1000).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  },
  num:   (v) => v == null ? '—' : Number(v).toLocaleString(),
  ratio: (v) => v == null ? '—' : `${Number(v).toFixed(2)}x`,
  pct:   (v) => v == null ? '—' : `${(Number(v)*100).toFixed(1)}%`,
  date:  (v) => v ? String(v).slice(5) : '—',
  full:  (v) => v ? String(v).slice(0,10) : '—',
};

const STATUS = {
  green:  { color: '#22c55e', bg: 'rgba(34,197,94,.1)',  border: 'rgba(34,197,94,.25)'  },
  yellow: { color: '#f59e0b', bg: 'rgba(245,158,11,.1)', border: 'rgba(245,158,11,.25)' },
  red:    { color: '#ef4444', bg: 'rgba(239,68,68,.1)',  border: 'rgba(239,68,68,.25)'  },
  gray:   { color: '#6b7280', bg: 'rgba(107,114,128,.08)', border: 'rgba(107,114,128,.2)' },
};

const CHANNEL_META = {
  META:     { label:'Meta',      color:'#1877f2', short:'FB' },
  GOOGLE:   { label:'Google',    color:'#ea4335', short:'GG' },
  APPLOVIN: { label:'AppLovin',  color:'#ff6b35', short:'AL' },
  TIKTOK:   { label:'TikTok',    color:'#69c9d0', short:'TT' },
  SNAPCHAT: { label:'Snapchat',  color:'#FFFC00', short:'SC' },
  BING:     { label:'Bing',      color:'#00809d', short:'BG' },
  PINTEREST:{ label:'Pinterest', color:'#e60023', short:'PT' },
  X:        { label:'X',         color:'#000',    short:'X'  },
};

const GEO_FLAG   = { US:'🇺🇸', CA:'🇨🇦', AUS:'🇦🇺', DUBAI:'🇦🇪', EU:'🇪🇺' };
const GEO_LABEL  = { US:'United States', CA:'Canada', AUS:'Australia', DUBAI:'Dubai / UAE', EU:'Europe (EU)' };
// For NOBL Travel, EU is the SAME store — always pinned and included in all totals
const NOBL_REGIONS_ORDER = ['US','EU','CA','AUS','DUBAI'];

// ── Tiny components ───────────────────────────────────────────────────────────
const Dot = ({ s, size=8 }) => (
  <span style={{ display:'inline-block', width:size, height:size, borderRadius:'50%', background:STATUS[s]?.color||'#888', flexShrink:0 }}/>
);

const Pill = ({ s, children }) => (
  <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 9px', borderRadius:20, fontSize:12, fontWeight:700, background:STATUS[s]?.bg, border:`1px solid ${STATUS[s]?.border}`, color:STATUS[s]?.color }}>
    <Dot s={s} size={6}/>{children}
  </span>
);

const Skeleton = ({ h=72 }) => (
  <div style={{ height:h, borderRadius:10, background:'var(--bg3)', animation:'sk 1.4s ease-in-out infinite' }}/>
);

const ErrBox = ({ msg, onRetry }) => (
  <div style={{ background:'rgba(239,68,68,.07)', border:'1px solid rgba(239,68,68,.2)', borderRadius:10, padding:'14px 18px', display:'flex', alignItems:'center', gap:14 }}>
    <div style={{ flex:1 }}>
      <div style={{ fontWeight:700, color:'#ef4444', fontSize:13, marginBottom:3 }}>Failed to load</div>
      <code style={{ fontSize:11, color:'var(--text3)' }}>{msg}</code>
    </div>
    {onRetry && <button onClick={onRetry} style={{ padding:'6px 14px', borderRadius:7, background:'var(--accent)', color:'#fff', border:'none', fontSize:12, fontWeight:600, cursor:'pointer' }}>Retry</button>}
  </div>
);

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({ label, value, format='currency', status, sub, icon, delta }) {
  const st = STATUS[status] || {};
  return (
    <div style={{
      background: status ? st.bg : 'var(--bg2)',
      border: `1px solid ${status ? st.border : 'var(--border2)'}`,
      borderRadius:14, padding:'18px 20px',
      display:'flex', flexDirection:'column', gap:6,
      position:'relative', overflow:'hidden',
    }}>
      {status && <div style={{ position:'absolute', top:0, left:0, right:0, height:3, background:st.color, borderRadius:'14px 14px 0 0' }}/>}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ fontSize:11, fontWeight:600, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.06em' }}>{label}</div>
        {icon && <span style={{ fontSize:16, opacity:.5 }}>{icon}</span>}
      </div>
      <div style={{ fontSize:28, fontWeight:900, color: status ? st.color : 'var(--text)', lineHeight:1, letterSpacing:'-.5px' }}>
        {fmt[format]?.(value) ?? '—'}
      </div>
      {sub && <div style={{ fontSize:11, color:'var(--text3)', marginTop:1 }}>{sub}</div>}
      {delta != null && (
        <div style={{ fontSize:11, fontWeight:600, color: delta>=0 ? '#22c55e' : '#ef4444' }}>
          {delta>=0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs prev period
        </div>
      )}
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────
const SH = ({ title, sub, right }) => (
  <div style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', marginBottom:14 }}>
    <div>
      <div style={{ fontSize:16, fontWeight:800, color:'var(--text)', letterSpacing:'-.2px' }}>{title}</div>
      {sub && <div style={{ fontSize:12, color:'var(--text3)', marginTop:2 }}>{sub}</div>}
    </div>
    {right}
  </div>
);

// ── Trend chart ───────────────────────────────────────────────────────────────
function TrendChart({ data, metric, color, formatY, refVal }) {
  if (!data?.length) return <div style={{ height:140, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text3)', fontSize:12 }}>No data</div>;
  return (
    <ResponsiveContainer width="100%" height={140}>
      <AreaChart data={data} margin={{ top:8, right:4, left:0, bottom:0 }}>
        <defs>
          <linearGradient id={`g${metric}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={.35}/>
            <stop offset="95%" stopColor={color} stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false}/>
        <XAxis dataKey="date" tickFormatter={fmt.date} tick={{ fontSize:9, fill:'var(--text3)' }} interval="preserveStartEnd" axisLine={false} tickLine={false}/>
        <YAxis tick={{ fontSize:9, fill:'var(--text3)' }} tickFormatter={formatY} width={46} axisLine={false} tickLine={false}/>
        <Tooltip
          contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:8, fontSize:12, boxShadow:'0 4px 20px rgba(0,0,0,.2)' }}
          labelStyle={{ color:'var(--text2)', fontWeight:600, marginBottom:4 }}
          formatter={(v)=>[formatY(v)]}
        />
        {refVal && <ReferenceLine y={refVal} stroke={color} strokeDasharray="4 4" strokeOpacity={.5}/>}
        <Area type="monotone" dataKey={metric} stroke={color} strokeWidth={2.5} fill={`url(#g${metric})`} dot={false} activeDot={{ r:4, stroke:color, strokeWidth:2, fill:'var(--bg2)' }}/>
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Channel spend bar ─────────────────────────────────────────────────────────
function SpendBar({ channels }) {
  if (!channels?.length) return <div style={{ height:160, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text3)', fontSize:12 }}>No data</div>;
  const sorted = [...channels].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  const data = sorted.map(c => ({
    name: CHANNEL_META[c.channel]?.label || c.channel,
    spend: Math.round(c.spend||0),
    roas: parseFloat((c.roas||0).toFixed(2)),
    color: CHANNEL_META[c.channel]?.color || '#6b7280',
  }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length*34)}>
      <BarChart data={data} layout="vertical" margin={{ top:4, right:12, left:58, bottom:4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false}/>
        <XAxis type="number" tick={{ fontSize:9, fill:'var(--text3)' }} tickFormatter={v=>`$${(v/1000).toFixed(0)}K`} axisLine={false} tickLine={false}/>
        <YAxis dataKey="name" type="category" tick={{ fontSize:11, fill:'var(--text2)', fontWeight:600 }} width={56} axisLine={false} tickLine={false}/>
        <Tooltip contentStyle={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:8, fontSize:12 }} formatter={v=>[fmt.currency(v),'Spend']}/>
        <Bar dataKey="spend" radius={[0,6,6,0]} maxBarSize={22}>
          {data.map(d=><Cell key={d.name} fill={d.color}/>)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Geo cards ─────────────────────────────────────────────────────────────────
function GeoCards({ geo, loading, brand }) {
  if (loading) return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))', gap:10 }}>
      {[...Array(5)].map((_,i)=><Skeleton key={i} h={110}/>)}
    </div>
  );

  const isNobl = brand === 'nobl';
  let regions = (geo||[]).filter(g => g.region !== 'TOTAL');

  // For NOBL: ensure all key regions appear, then sort by revenue descending
  if (isNobl) {
    const regionMap = Object.fromEntries(regions.map(r => [r.region, r]));
    regions = NOBL_REGIONS_ORDER.map(k => regionMap[k] || { region:k, revenue:0, spend:0, mer:0, mer_status:'gray' });
  }

  regions = [...regions].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));

  if (!regions.length) return <div style={{ color:'var(--text3)', fontSize:13, padding:'12px 0' }}>No regional data</div>;

  // Compute total for share calculations
  const totalRev   = regions.reduce((s,g) => s + (g.revenue||0), 0);
  const totalSpend = regions.reduce((s,g) => s + (g.spend||0), 0);

  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))', gap:10 }}>
      {regions.map(g => {
        const isEU   = g.region === 'EU';
        const st     = STATUS[g.mer_status] || STATUS.gray;
        const revPct = totalRev > 0 ? ((g.revenue / totalRev) * 100).toFixed(1) : '0.0';
        return (
          <div key={g.region} style={{
            background: st.bg || 'var(--bg2)',
            border: `1px solid ${isEU && isNobl ? 'rgba(99,102,241,.4)' : (st.border || 'var(--border2)')}`,
            borderRadius: 12, padding: '14px 16px',
            position: 'relative', overflow: 'hidden',
          }}>
            {/* Top accent bar */}
            <div style={{ position:'absolute', top:0, left:0, right:0, height:3, background: st.color || 'var(--border2)', borderRadius:'12px 12px 0 0' }}/>

            {/* EU "included in totals" badge for NOBL */}
            {isEU && isNobl && (
              <div style={{
                position:'absolute', top:8, right:8,
                fontSize:9, fontWeight:700, padding:'2px 6px',
                background:'rgba(99,102,241,.15)', border:'1px solid rgba(99,102,241,.3)',
                borderRadius:6, color:'#818cf8', letterSpacing:'.03em',
              }}>✓ IN TOTALS</div>
            )}

            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4, marginTop:2 }}>
              <span style={{ fontSize:18 }}>{GEO_FLAG[g.region]||'🌐'}</span>
            </div>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--text2)', marginBottom:6, lineHeight:1.2 }}>
              {GEO_LABEL[g.region] || g.region}
            </div>

            <Pill s={g.mer_status}>MER {fmt.ratio(g.mer)}</Pill>

            <div style={{ fontSize:11, color:'var(--text3)', marginTop:8, display:'flex', flexDirection:'column', gap:3 }}>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span>Revenue</span>
                <span style={{ fontWeight:600, color:'var(--text2)' }}>{fmt.currency(g.revenue)}</span>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span>Spend</span>
                <span style={{ fontWeight:600, color:'var(--text2)' }}>{fmt.currency(g.spend)}</span>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', marginTop:2, paddingTop:4, borderTop:'1px solid var(--border)' }}>
                <span>Rev share</span>
                <span style={{ fontWeight:700, color: isEU && isNobl ? '#818cf8' : 'var(--text2)' }}>{revPct}%</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Channel table ─────────────────────────────────────────────────────────────
function ChannelTable({ channels, loading }) {
  if (loading) return <div style={{ padding:16 }}>{[...Array(4)].map((_,i)=><div key={i} style={{ marginBottom:8 }}><Skeleton h={36}/></div>)}</div>;
  if (!channels?.length) return <div style={{ padding:'20px 16px', color:'var(--text3)', fontSize:13 }}>No channel data for this date</div>;

  const sortedChannels = [...channels].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));

  const cols = [
    { h:'Channel',   render:(ch)=>(
      <span style={{ display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ width:28, height:28, borderRadius:7, background:CHANNEL_META[ch.channel]?.color||'#888', display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:800, color:'#fff', flexShrink:0 }}>{CHANNEL_META[ch.channel]?.short||ch.channel[0]}</span>
        <span style={{ fontWeight:700, color:'var(--text)', fontSize:13 }}>{CHANNEL_META[ch.channel]?.label||ch.channel}</span>
      </span>
    )},
    { h:'Spend',     render:(ch)=><span style={{ fontWeight:600, color:'var(--text2)' }}>{fmt.currency(ch.spend)}</span> },
    { h:'Revenue',   render:(ch)=><span style={{ color:'var(--text2)' }}>{fmt.currency(ch.revenue)}</span> },
    { h:'ROAS',      render:(ch)=><Pill s={ch.roas_status}>{fmt.ratio(ch.roas)}</Pill> },
    { h:'Orders',    render:(ch)=><span style={{ color:'var(--text2)' }}>{fmt.num(ch.purchases)}</span> },
    { h:'NC Orders', render:(ch)=><span style={{ color:'var(--text2)' }}>{fmt.num(ch.nc_orders)}</span> },
    { h:'CAC',       render:(ch)=><span style={{ color:'var(--text2)' }}>{ch.cac>0?fmt.currency(ch.cac):'—'}</span> },
    { h:'AOV',       render:(ch)=><span style={{ color:'var(--text2)' }}>{ch.purchases>0?fmt.currency(ch.revenue/ch.purchases):'—'}</span> },
  ];

  return (
    <div style={{ overflowX:'auto' }}>
      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
        <thead>
          <tr>
            {cols.map(c=>(
              <th key={c.h} style={{ padding:'10px 14px', textAlign:'left', fontSize:10, fontWeight:700, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.05em', borderBottom:'2px solid var(--border)', whiteSpace:'nowrap', background:'var(--bg3)' }}>{c.h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedChannels.map((ch,i)=>(
            <tr key={ch.channel} style={{ background: i%2?'var(--bg3)':'transparent', transition:'background .15s' }}>
              {cols.map(c=>(
                <td key={c.h} style={{ padding:'12px 14px', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap', verticalAlign:'middle' }}>
                  {c.render(ch)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Brand / date controls ─────────────────────────────────────────────────────
function SegBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding:'6px 14px', borderRadius:8, fontSize:12, fontWeight:600, cursor:'pointer', border:'none',
      background: active ? 'var(--accent)' : 'transparent',
      color: active ? '#fff' : 'var(--text3)',
      transition:'all .15s',
    }}>{children}</button>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function LivePage() {
  const [brand, setBrand]           = useState('nobl');
  const [dateMode, setDateMode]     = useState('latest');
  const [customDate, setCustomDate] = useState('');
  const [trendDays, setTrendDays]   = useState(30);
  const [availDates, setAvailDates] = useState(null);

  const [live,     setLive]         = useState(null);
  const [trend,    setTrend]        = useState(null);
  const [loadL,    setLoadL]        = useState(false);
  const [loadT,    setLoadT]        = useState(false);
  const [errL,     setErrL]         = useState(null);
  const [errT,     setErrT]         = useState(null);

  // Fetch available dates on brand change
  useEffect(() => {
    setLive(null); setTrend(null); setErrL(null); setErrT(null);
    API(`/api/tw/available-dates?brand=${brand}`).then(d => {
      if (d.ok) { setAvailDates(d); if (!customDate) setCustomDate(d.latest_summary||''); }
    }).catch(()=>{});
  }, [brand]);

  const resolvedDate = dateMode==='latest' ? (availDates?.latest_summary||'') : customDate;

  const loadLive = useCallback(async () => {
    if (!resolvedDate) return;
    setLoadL(true); setErrL(null);
    try {
      const d = await API(`/api/tw/live?brand=${brand}&date=${resolvedDate}`);
      if (!d.ok) throw new Error(d.error||'API error');
      setLive(d);
    } catch(e) { setErrL(e.message); }
    finally    { setLoadL(false); }
  }, [brand, resolvedDate]);

  const loadTrend = useCallback(async () => {
    if (!resolvedDate) return;
    setLoadT(true); setErrT(null);
    try {
      const d = await API(`/api/tw/trend?brand=${brand}&days=${trendDays}&endDate=${resolvedDate}`);
      if (!d.ok) throw new Error(d.error||'API error');
      setTrend(d);
    } catch(e) { setErrT(e.message); }
    finally    { setLoadT(false); }
  }, [brand, trendDays, resolvedDate]);

  useEffect(() => { loadLive();  }, [loadLive]);
  useEffect(() => { loadTrend(); }, [loadTrend]);

  const sum       = live?.summary;
  const channels  = [...(live?.channels || [])].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  const geo       = live?.geo      || [];
  const trendArr  = trend?.trend   || [];
  const euContrib = live?.eu_contribution || null;

  const BRANDS = [
    { k:'nobl',   l:'NOBL Travel', badge:'🇺🇸🇪🇺' },
    { k:'flo',    l:'FLO US',      badge:null       },
    { k:'flo_eu', l:'FLO EU',      badge:null       },
  ];

  // Dates each section is actually showing (may differ due to ETL lag)
  const summaryDate    = live?.summary_date;
  const channelDate    = live?.channel_date;
  const geoDateUsed    = live?.geo_date;
  const channelLag     = live?.channel_lag;
  const geoLag         = live?.geo_lag;
  // How many days behind is channel/geo?
  const channelDaysLag = channelDate && summaryDate
    ? Math.round((new Date(summaryDate) - new Date(channelDate)) / 86400000)
    : 0;

  return (
    <div style={{ maxWidth:1380, margin:'0 auto' }}>
      <style>{`
        @keyframes sk { 0%,100%{opacity:1} 50%{opacity:.4} }
      `}</style>

      {/* ── Header bar ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ fontSize:24, fontWeight:900, color:'var(--text)', margin:0, letterSpacing:'-.5px' }}>
            Today&apos;s snapshot
            {brand === 'nobl' && (
              <span style={{ marginLeft:10, fontSize:13, fontWeight:600, color:'#818cf8', verticalAlign:'middle',
                background:'rgba(99,102,241,.12)', border:'1px solid rgba(99,102,241,.25)',
                borderRadius:8, padding:'3px 9px' }}>
                🇺🇸 US + 🇪🇺 EU
              </span>
            )}
          </h1>
          <div style={{ fontSize:12, color:'var(--text3)', marginTop:4 }}>
            {brand === 'nobl' ? 'Latest daily numbers for NOBL Travel (all regions)' : brand === 'flo' ? 'Latest daily numbers for Pilates FLO US' : 'Latest daily numbers for Pilates FLO EU'}
            {availDates?.latest_summary && (
              <span> · Latest: <strong style={{ color:'var(--text2)' }}>{availDates.latest_summary}</strong></span>
            )}
          </div>
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          {/* Brand selector */}
          <div style={{ display:'flex', background:'var(--bg3)', borderRadius:10, padding:3, border:'1px solid var(--border2)' }}>
            {BRANDS.map(b=>(
              <SegBtn key={b.k} active={brand===b.k} onClick={()=>setBrand(b.k)}>
                {b.l}{b.badge && <span style={{ marginLeft:4, fontSize:11, opacity:.8 }}>{b.badge}</span>}
              </SegBtn>
            ))}
          </div>

          {/* Date selector */}
          <div style={{ display:'flex', background:'var(--bg3)', borderRadius:10, padding:3, border:'1px solid var(--border2)' }}>
            <SegBtn active={dateMode==='latest'} onClick={()=>setDateMode('latest')}>Latest</SegBtn>
            <SegBtn active={dateMode==='custom'} onClick={()=>setDateMode('custom')}>Custom</SegBtn>
          </div>
          {dateMode==='custom' && (
            <input type="date" value={customDate} onChange={e=>setCustomDate(e.target.value)}
              min={availDates?.oldest_summary} max={availDates?.latest_summary}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid var(--border2)', background:'var(--bg3)', color:'var(--text)', fontSize:12 }}/>
          )}

          {/* Refresh */}
          <button onClick={()=>{loadLive();loadTrend();}} disabled={loadL}
            style={{ padding:'7px 16px', borderRadius:9, border:'1px solid var(--border2)', background:'var(--bg3)', color:'var(--text2)', fontSize:12, fontWeight:600, cursor:'pointer', opacity:loadL?.5:1, display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ display:'inline-block', animation:loadL?'spin .8s linear infinite':'none', fontSize:14 }}>↻</span> Refresh
          </button>
        </div>
      </div>

      {errL && <div style={{ marginBottom:18 }}><ErrBox msg={errL} onRetry={loadLive}/></div>}

      {/* ── Date banner ── */}
      {resolvedDate && (
        <div style={{ marginBottom:20 }}>
          <div style={{ padding:'10px 16px', background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:10, display:'flex', alignItems:'center', gap:10, fontSize:13, flexWrap:'wrap' }}>
            <span style={{ fontSize:16 }}>📅</span>
            <span style={{ color:'var(--text2)' }}>Summary: <strong style={{ color:'var(--text)' }}>{summaryDate || resolvedDate}</strong></span>
            {channelDate && channelDate !== (summaryDate || resolvedDate) && (
              <span style={{ color:'var(--text3)', fontSize:12 }}>
                · Channels/Geo: <strong style={{ color:'var(--warn, #f59e0b)' }}>{channelDate}</strong>
                {channelDaysLag > 0 && <span style={{ color:'var(--text3)' }}> ({channelDaysLag}d behind — ETL sync pending)</span>}
              </span>
            )}
          </div>
          {(channelLag || geoLag) && (
            <div style={{ marginTop:6, padding:'8px 14px', background:'rgba(245,158,11,.07)', border:'1px solid rgba(245,158,11,.25)', borderRadius:8, fontSize:12, color:'#f59e0b', display:'flex', alignItems:'center', gap:8 }}>
              <span>⚠</span>
              <span>Channel &amp; regional data is {channelDaysLag} day{channelDaysLag!==1?'s':''} behind summary. The ETL sync for channel/geo tables last ran on <strong>{channelDate}</strong>. Summary KPIs and trends use up-to-date data.</span>
            </div>
          )}
        </div>
      )}

      {/* ── NOBL EU included notice ── */}
      {brand === 'nobl' && (
        <div style={{ marginBottom:18, padding:'10px 16px', background:'rgba(99,102,241,.07)', border:'1px solid rgba(99,102,241,.2)', borderRadius:10, display:'flex', alignItems:'center', gap:10, fontSize:12 }}>
          <span style={{ fontSize:16 }}>🇪🇺</span>
          <div>
            <span style={{ fontWeight:700, color:'#818cf8' }}>EU operations are included in all NOBL Travel metrics.</span>
            <span style={{ color:'var(--text3)', marginLeft:6 }}>NOBL processes EU orders through the same store — revenue, spend, MER and orders always reflect US + EU + CA + AUS + Dubai combined.</span>
          </div>
        </div>
      )}

      {/* ── Summary KPIs ── */}
      <div style={{ marginBottom:28 }}>
        <SH
          title="Summary"
          sub={brand==='nobl'
            ? 'All channels blended · US + 🇪🇺 EU + CA + AUS + Dubai'
            : 'All channels blended'}
        />
        {loadL ? (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(175px,1fr))', gap:12 }}>
            {[...Array(7)].map((_,i)=><Skeleton key={i}/>)}
          </div>
        ) : sum ? (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(175px,1fr))', gap:12 }}>
            <KpiCard label="Gross − Discounts" value={sum.gross_minus_discounts} format="currency" icon="📊" tooltip="Product gross minus discounts (excludes shipping & taxes)"/>
            <KpiCard label="Order Revenue"   value={sum.order_revenue || sum.total_revenue} format="currency" icon="💰" tooltip="Gross + Shipping + Taxes − Discounts (MER basis)"/>
            <KpiCard label="Total ad spend"     value={sum.total_spend}          format="currency" icon="📣"/>
            <KpiCard label="Sales per ad $"             value={sum.mer}                  format="ratio"    icon="⚡" status={sum.mer_status}
              sub={sum.mer_status==='green'?'✓ On target (≥2.0)':sum.mer_status==='yellow'?'Near target — needs ≥2.0':'⚠ Below target — needs ≥2.0'}/>
            <KpiCard label="Total orders"    value={sum.total_orders}         format="num"      icon="🛒"/>
            <KpiCard label="New customers"   value={sum.new_customer_orders}  format="num"      icon="✨"
              sub={`${fmt.pct(sum.new_customer_rate)} of all orders`}/>
            <KpiCard label="Repeat customers"       value={sum.returning_orders}     format="num"      icon="🔄"
              sub={`${fmt.pct(1-sum.new_customer_rate)} of all orders`}/>
            <KpiCard label="Avg order size"             value={sum.aov}                  format="currency" icon="🎯"/>
          </div>
        ) : !errL && resolvedDate ? (
          <div style={{ color:'var(--text3)', fontSize:13, padding:'16px 0' }}>No data for {resolvedDate}</div>
        ) : null}

        {/* EU contribution strip — NOBL only */}
        {brand === 'nobl' && !loadL && euContrib && (
          <div style={{ marginTop:14, padding:'12px 16px', background:'rgba(99,102,241,.06)', border:'1px solid rgba(99,102,241,.2)', borderRadius:10, display:'flex', alignItems:'center', gap:20, flexWrap:'wrap' }}>
            <div style={{ display:'flex', alignItems:'center', gap:7, flexShrink:0 }}>
              <span style={{ fontSize:18 }}>🇪🇺</span>
              <div>
                <div style={{ fontSize:11, fontWeight:700, color:'#818cf8', textTransform:'uppercase', letterSpacing:'.05em' }}>EU Contribution</div>
                <div style={{ fontSize:10, color:'var(--text3)' }}>included in all totals above · as of {geoDateUsed}</div>
              </div>
            </div>
            <div style={{ display:'flex', gap:24, flexWrap:'wrap', flex:1 }}>
              {[
                { label:'Sales',  value: fmt.currency(euContrib.revenue) },
                { label:'Ad spend',    value: fmt.currency(euContrib.spend)   },
                { label:'Sales per ad $',      value: fmt.ratio(euContrib.mer)        },
                { label:'Share of total sales',value: `${euContrib.rev_pct}%`         },
              ].map(item => (
                <div key={item.label} style={{ display:'flex', flexDirection:'column', gap:2 }}>
                  <div style={{ fontSize:10, fontWeight:600, color:'var(--text3)', textTransform:'uppercase', letterSpacing:'.04em' }}>{item.label}</div>
                  <div style={{ fontSize:15, fontWeight:800, color:'#818cf8' }}>{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Regional MER ── */}
      <div style={{ marginBottom:28 }}>
        <SH
          title={brand==='nobl' ? 'Sales by region — NOBL Travel' : 'Sales by region'}
          sub={brand==='nobl'
            ? `All regions incl. EU · Data as of ${geoDateUsed || '—'}`
            : (geoDateUsed ? `Data as of ${geoDateUsed}` : 'Sales, ad spend, and return per ad $ by region')}
        />
        <GeoCards geo={geo} loading={loadL} brand={brand}/>
      </div>

      {/* ── Trend charts ── */}
      <div style={{ marginBottom:28 }}>
        <SH
          title={`${trendDays}-Day Trend`}
          sub={brand==='nobl' ? 'Daily sales per ad $, sales, and ad spend · All regions incl. EU' : 'Daily sales per ad $, sales, and ad spend'}
          right={
            <div style={{ display:'flex', background:'var(--bg3)', borderRadius:8, padding:2, border:'1px solid var(--border2)' }}>
              {[7,14,30,60].map(d=><SegBtn key={d} active={trendDays===d} onClick={()=>setTrendDays(d)}>{d}d</SegBtn>)}
            </div>
          }
        />
        {errT && <ErrBox msg={errT} onRetry={loadTrend}/>}
        {!errT && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:14 }}>
            {[
              { key:'mer',     label:'Sales per ad $',     color:'#6366f1', fmt:v=>`${Number(v).toFixed(2)}x`, ref:2.0  },
              { key:'revenue', label:'Sales', color:'#22c55e', fmt:v=>`$${(v/1000).toFixed(0)}K`         },
              { key:'spend',   label:'Ad spend',   color:'#f59e0b', fmt:v=>`$${(v/1000).toFixed(0)}K`         },
            ].map(c=>(
              <div key={c.key} style={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:14, padding:'16px 16px 12px', overflow:'hidden' }}>
                <div style={{ fontSize:12, fontWeight:700, color:'var(--text2)', marginBottom:10, display:'flex', alignItems:'center', gap:6 }}>
                  <span style={{ width:8, height:8, borderRadius:'50%', background:c.color, display:'inline-block' }}/>
                  {c.label}
                </div>
                {loadT ? <Skeleton h={140}/> : <TrendChart data={trendArr} metric={c.key} color={c.color} formatY={c.fmt} refVal={c.ref}/>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Channels ── */}
      <div style={{ marginBottom:28 }}>
        <SH title="Ad channels" sub={channelDate ? `Data as of ${channelDate}` : 'Where your ad spend went and what it returned'}/>
        <div style={{ display:'grid', gridTemplateColumns:'300px 1fr', gap:14, marginBottom:14 }}>
          {/* Spend bar */}
          <div style={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:14, padding:'16px 12px 12px' }}>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--text2)', marginBottom:10, paddingLeft:4 }}>Ad spend by channel</div>
            {loadL ? <Skeleton h={160}/> : <SpendBar channels={channels}/>}
          </div>

          {/* ROAS cards */}
          <div style={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:14, padding:'16px' }}>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--text2)', marginBottom:12 }}>Sales per ad $ vs targets</div>
            {loadL ? <Skeleton h={100}/> : (
              <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
                {channels.map(ch=>{
                  const m = CHANNEL_META[ch.channel]||{};
                  const st = STATUS[ch.roas_status]||STATUS.gray;
                  return (
                    <div key={ch.channel} style={{
                      background: st.bg, border:`1px solid ${st.border}`,
                      borderRadius:10, padding:'10px 14px', minWidth:130,
                      display:'flex', flexDirection:'column', gap:4,
                    }}>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ width:10, height:10, borderRadius:3, background:m.color||'#888', flexShrink:0 }}/>
                        <span style={{ fontSize:12, fontWeight:700, color:'var(--text2)' }}>{m.label||ch.channel}</span>
                      </div>
                      <div style={{ fontSize:20, fontWeight:900, color:st.color }}>{fmt.ratio(ch.roas)}</div>
                      <div style={{ fontSize:11, color:'var(--text3)' }}>{fmt.currency(ch.spend)} ad spend</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Full table */}
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:14, overflow:'hidden' }}>
          <ChannelTable channels={channels} loading={loadL}/>
        </div>
      </div>

      {/* ── Threshold guide ── */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border2)', borderRadius:14, padding:'16px 20px' }}>
        <div style={{ fontSize:12, fontWeight:700, color:'var(--text2)', marginBottom:12 }}>Performance Thresholds</div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:24, fontSize:11 }}>
          {[
            { label:'MER Global/US/CA/AU/EU', rules:['<1.8 🔴','1.8–2.0 🟡','≥2.0 🟢'] },
            { label:'MER Dubai/UAE',          rules:['<1.6 🔴','1.6–1.8 🟡','≥1.8 🟢'] },
            { label:'ROAS Meta',              rules:['<1.6 🔴','1.6–1.8 🟡','≥1.8 🟢'] },
            { label:'ROAS Google',            rules:['<2.0 🔴','2.0–3.0 🟡','≥3.0 🟢'] },
            { label:'ROAS AppLovin',          rules:['<2.0 🔴','2.0–2.2 🟡','≥2.2 🟢'] },
            { label:'NVP%',                   rules:['<45% 🔴','45–50% 🟡','≥50% 🟢'] },
          ].map(t=>(
            <div key={t.label}>
              <div style={{ fontWeight:700, color:'var(--text3)', marginBottom:4, fontSize:10, textTransform:'uppercase', letterSpacing:'.04em' }}>{t.label}</div>
              <div style={{ display:'flex', gap:8, color:'var(--text2)' }}>{t.rules.map(r=><span key={r}>{r}</span>)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
