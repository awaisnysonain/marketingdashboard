/**
 * GenericDashPage — renders a saved AI-built dashboard OR an AI-analyzed Google Sheet.
 * For sheets: uses SmartTabRenderer which auto-detects column types from actual data.
 * No dependency on AI config being correct — works with any sheet layout.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { executeDashboard, fmt$ } from '../utils/api';
import { Icons } from '../components/Icons';
import SheetTable from '../components/SheetTable';

const CHART_COLORS = ['#6366f1','#14b8a6','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#1877f2','#ea4335','#10b981','#f97316'];

/* ─── Value formatters ──────────────────────────────────────────── */
function parseNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().replace(/[$,\s]/g, '');
  if (s === '' || s === '—' || s === '-' || s === 'N/A' || s === '#N/A') return null;
  const n = parseFloat(s.replace(/%$/, ''));
  return isNaN(n) ? null : n;
}

function fmtDate(s) {
  if (!s) return '';
  const str = String(s).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [, mo, dy] = str.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(mo)-1]} ${parseInt(dy)}`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(s).trim())) {
    const parts = String(s).split('/');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(parts[0])-1]} ${parseInt(parts[1])}`;
  }
  return String(s);
}

function fmtV(v, fmt) {
  if (v === null || v === undefined || v === '') return '—';
  const s = String(v).trim();
  if (s === '—' || s === '') return '—';
  if (fmt === 'currency') {
    const n = parseNum(v);
    if (n === null) return s;
    return Math.abs(n) >= 1e6 ? `$${(n/1e6).toFixed(2)}M`
      : Math.abs(n) >= 1e3 ? `$${(n/1e3).toFixed(1)}K`
      : fmt$(n);
  }
  if (fmt === 'percent') {
    if (s.endsWith('%')) return s;
    const n = parseNum(v);
    if (n === null) return s;
    // If stored as decimal (e.g. 0.035 = 3.5%), convert; if already in percent scale (e.g. 2.74), show as-is
    return Math.abs(n) <= 2 ? `${(n*100).toFixed(1)}%` : `${n.toFixed(2)}x`;
  }
  if (fmt === 'number') {
    const n = parseNum(v);
    return n !== null ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : s;
  }
  if (fmt === 'date') return fmtDate(v);
  const n = parseNum(v);
  if (n !== null) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return s;
}

/* ─── Sheet data parser — raw string arrays → typed objects ───── */
function parseSheetRows(headers, rawRows) {
  return rawRows.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      const raw = row[i] ?? '';
      const s = String(raw).trim();
      if (s === '' || s === '-' || s === 'N/A' || s === '#N/A' || s === '#REF!' || s === '#ERROR!') {
        obj[h] = null; return;
      }
      const cleaned = s.replace(/[$,\s]/g, '');
      if (cleaned.endsWith('%')) {
        const n = parseFloat(cleaned.slice(0, -1));
        obj[h] = isNaN(n) ? s : n;
      } else {
        const n = parseFloat(cleaned);
        obj[h] = isNaN(n) ? s : n;
      }
    });
    return obj;
  });
}

/* ─── Auto-detect column types from actual data ─────────────────
   Returns: { dateCol, numericCols, categoryCols, formatMap }
*/
function autoDetectColumns(headers, rows) {
  if (!headers.length || !rows.length) return { dateCol: null, numericCols: [], categoryCols: [], formatMap: {} };

  const isDateVal = (v) => {
    if (v === null || v === undefined) return false;
    const s = String(v).trim();
    return /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s);
  };

  const isNumericVal = (v) => typeof v === 'number' && !isNaN(v);

  const formatFor = (h) => {
    const hl = String(h).toLowerCase();
    if (hl.includes('revenue') || hl.includes('spend') || hl.includes('sales') ||
        hl.includes('cac') || hl.includes('cost') || hl.includes('variance') ||
        hl.includes('budget') || hl.includes('aov') || hl.includes('ltv') ||
        hl.includes('gross') || hl.includes('profit')) return 'currency';
    if (hl.includes('mer') || hl.includes('roas') || hl.includes('cvr') ||
        hl.includes('rate') || hl.includes('pacing') || hl.includes('%') ||
        hl.includes('margin') || hl.includes('conv') || hl.includes('yoy')) return 'percent';
    if (hl.includes('date') || hl.includes('week') || hl.includes('month') || hl.includes('day')) return 'date';
    return 'number';
  };

  const sampleSize = Math.min(rows.length, 30);
  const sample = rows.slice(0, sampleSize);

  let dateCol = null;
  const numericCols = [];
  const categoryCols = [];
  const formatMap = {};

  for (const h of headers) {
    const vals = sample.map(r => r[h]).filter(v => v !== null && v !== undefined);
    if (!vals.length) continue;

    const dateCount = vals.filter(isDateVal).length;
    const numericCount = vals.filter(isNumericVal).length;

    if (!dateCol && dateCount >= vals.length * 0.5) {
      dateCol = h;
      formatMap[h] = 'date';
    } else if (numericCount >= vals.length * 0.5) {
      numericCols.push(h);
      formatMap[h] = formatFor(h);
    } else if (vals.some(v => typeof v === 'string' && v.length > 0)) {
      categoryCols.push(h);
      formatMap[h] = 'text';
    }
  }

  return { dateCol, numericCols, categoryCols, formatMap };
}

/* ─── Smart KPI row — top N numeric columns ─────────────────────── */
function SmartKpiRow({ headers, rows, detected }) {
  const { numericCols, formatMap } = detected;
  // Pick the most interesting numeric cols (prefer revenue/spend/mer/orders)
  const priority = ['revenue','spend','mer','roas','orders','cac','cvr','visitors','purchases'];
  const sorted = [...numericCols].sort((a, b) => {
    const al = a.toLowerCase(), bl = b.toLowerCase();
    const ai = priority.findIndex(p => al.includes(p));
    const bi = priority.findIndex(p => bl.includes(p));
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return 0;
  });
  const kpiCols = sorted.slice(0, 8);

  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:10, marginBottom:4 }}>
      {kpiCols.map((col, i) => {
        const fmt = formatMap[col] || 'number';
        const vals = rows.map(r => r[col]).filter(v => typeof v === 'number');
        const total = fmt === 'percent'
          ? (vals.reduce((a,b)=>a+b,0) / Math.max(vals.length,1))
          : vals.reduce((a,b)=>a+b,0);
        return (
          <div key={i} style={{
            background:'var(--bg)', border:'1px solid var(--border)',
            borderRadius:10, padding:'14px 16px',
          }}>
            <div style={{ fontSize:11, color:'var(--text3)', marginBottom:6, textTransform:'uppercase', letterSpacing:'.4px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
              {col}
            </div>
            <div style={{ fontSize:20, fontWeight:700, color:'var(--text)', fontVariantNumeric:'tabular-nums' }}>
              {fmtV(total, fmt)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Smart Chart ─────────────────────────────────────────────────
   Picks the best chart type and series based on detected columns.
*/
function SmartChart({ headers, rows, detected, title, maxSeries = 3 }) {
  const { dateCol, numericCols, categoryCols, formatMap } = detected;
  if (!rows.length) return null;

  // Pick series: prefer revenue + spend, or top N by total magnitude
  const priority = ['revenue (a)','revenue','spend (a)','spend','mer','roas','cvr','orders','visitors total','purchases total'];
  const sortedNum = [...numericCols].sort((a, b) => {
    const ai = priority.findIndex(p => a.toLowerCase().includes(p));
    const bi = priority.findIndex(p => b.toLowerCase().includes(p));
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return 0;
  });
  const seriesCols = sortedNum.slice(0, maxSeries);
  if (!seriesCols.length) return null;

  if (dateCol) {
    // Time-series area chart
    const sorted = [...rows].sort((a, b) => String(a[dateCol]||'').localeCompare(String(b[dateCol]||'')));
    const fmt1 = formatMap[seriesCols[0]] || 'number';
    return (
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20, marginBottom:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>{title}</div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={sorted} margin={{top:4,right:12,left:0,bottom:4}}>
            <defs>
              {seriesCols.map((_, i) => (
                <linearGradient key={i} id={`sg${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS[i]} stopOpacity={0.25}/>
                  <stop offset="95%" stopColor={CHART_COLORS[i]} stopOpacity={0}/>
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false}/>
            <XAxis dataKey={dateCol} tick={{fontSize:10,fill:'var(--text3)'}} stroke="var(--border2)"
              tickFormatter={v => fmtDate(v)}/>
            <YAxis tick={{fontSize:10,fill:'var(--text3)'}} stroke="var(--border2)" width={62}
              tickFormatter={v => fmt1==='currency'
                ? (Math.abs(v)>=1e6?`$${(v/1e6).toFixed(1)}M`:Math.abs(v)>=1e3?`$${(v/1e3).toFixed(0)}K`:String(v))
                : (Math.abs(v)>=1e6?`${(v/1e6).toFixed(1)}M`:Math.abs(v)>=1e3?`${(v/1e3).toFixed(0)}K`:String(v))}/>
            <Tooltip contentStyle={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:8,fontSize:12}}
              formatter={(v,n) => [fmtV(v, formatMap[n]||'number'), n]}
              labelFormatter={l => fmtDate(l)}/>
            <Legend wrapperStyle={{fontSize:11}}/>
            {seriesCols.map((col, i) => (
              <Area key={i} type="monotone" dataKey={col} name={col}
                stroke={CHART_COLORS[i]} fill={`url(#sg${i})`} strokeWidth={2} dot={false}/>
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (categoryCols.length) {
    // Bar chart grouped by category
    const catCol = categoryCols[0];
    // Aggregate by category
    const agg = {};
    rows.forEach(row => {
      const key = String(row[catCol] ?? '');
      if (!key) return;
      if (!agg[key]) { agg[key] = { [catCol]: key }; seriesCols.forEach(c => { agg[key][c] = 0; }); }
      seriesCols.forEach(c => { const v = typeof row[c]==='number'?row[c]:parseNum(row[c]); if(v!==null) agg[key][c]+=v; });
    });
    const catData = Object.values(agg).sort((a,b)=>(b[seriesCols[0]]||0)-(a[seriesCols[0]]||0)).slice(0, 20);
    const fmt1 = formatMap[seriesCols[0]] || 'number';
    return (
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:20, marginBottom:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>{title}</div>
        <ResponsiveContainer width="100%" height={Math.max(200, catData.length*26)}>
          <BarChart data={catData} layout="vertical" margin={{top:4,right:12,left:90,bottom:4}}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false}/>
            <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} stroke="var(--border2)"
              tickFormatter={v => fmt1==='currency'
                ? (Math.abs(v)>=1e6?`$${(v/1e6).toFixed(1)}M`:Math.abs(v)>=1e3?`$${(v/1e3).toFixed(0)}K`:String(v))
                : String(v)}/>
            <YAxis type="category" dataKey={catCol} width={85} tick={{fontSize:10,fill:'var(--text2)'}} stroke="var(--border2)"
              tickFormatter={v=>String(v).slice(0,14)}/>
            <Tooltip contentStyle={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:8,fontSize:12}}
              formatter={(v,n)=>[fmtV(v,formatMap[n]||'number'),n]}/>
            <Legend wrapperStyle={{fontSize:11}}/>
            {seriesCols.map((col,i)=>(
              <Bar key={i} dataKey={col} name={col} fill={CHART_COLORS[i]} radius={[0,3,3,0]}/>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return null;
}

/* ─── Smart Tab Renderer — works on ANY sheet without AI config ── */
function SmartTabRenderer({ headers, rows, tabName }) {
  const detected = useMemo(() => autoDetectColumns(headers, rows), [headers, rows]);
  const { dateCol, numericCols, categoryCols, formatMap } = detected;

  const hasData = rows.length > 0 && headers.length > 0;
  if (!hasData) {
    return <div style={{padding:'40px 0',textAlign:'center',color:'var(--text3)',fontSize:13}}>No data in this tab.</div>;
  }

  // Build two chart sections if we have enough columns
  const sortedNum = [...numericCols].sort((a,b) => {
    const priority = ['revenue (a)','revenue','spend (a)','spend','mer','roas','cvr','orders'];
    const ai = priority.findIndex(p=>a.toLowerCase().includes(p));
    const bi = priority.findIndex(p=>b.toLowerCase().includes(p));
    if(ai>=0&&bi>=0)return ai-bi; if(ai>=0)return -1; if(bi>=0)return 1; return 0;
  });
  const chart1Series = sortedNum.slice(0, 2);
  const chart2Series = sortedNum.slice(2, 4);

  const detected1 = { ...detected, numericCols: chart1Series };
  const detected2 = { ...detected, numericCols: chart2Series };

  return (
    <div>
      {/* KPI Cards */}
      {numericCols.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Key Metrics</div>
          <SmartKpiRow headers={headers} rows={rows} detected={detected}/>
        </div>
      )}

      {/* Charts */}
      {(dateCol || categoryCols.length > 0) && numericCols.length > 0 && (
        chart2Series.length > 0 ? (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:4 }}>
            <SmartChart headers={headers} rows={rows} detected={detected1}
              title={dateCol ? `${chart1Series.join(' & ')} over Time` : `${chart1Series.join(' & ')} by ${categoryCols[0]||'Category'}`}
              maxSeries={2}/>
            <SmartChart headers={headers} rows={rows} detected={detected2}
              title={dateCol ? `${chart2Series.join(' & ')} over Time` : `${chart2Series.join(' & ')} by ${categoryCols[0]||'Category'}`}
              maxSeries={2}/>
          </div>
        ) : (
          <SmartChart headers={headers} rows={rows} detected={detected1}
            title={dateCol ? `${chart1Series.join(' & ')} over Time` : `${chart1Series.join(' & ')} by ${categoryCols[0]||'Category'}`}
            maxSeries={3}/>
        )
      )}

      {/* Full Data Table */}
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>
          {tabName} — Full Data
          <span style={{ fontSize:11, fontWeight:400, color:'var(--text3)', marginLeft:8 }}>
            · {rows.length.toLocaleString()} rows · {headers.length} columns · click · shift+click · ctrl+C
          </span>
        </div>
        <SheetTable
          headers={headers}
          rows={rows}
          maxHeight="calc(100vh - 380px)"
          searchable={true}
          defaultSortDir="asc"
        />
      </div>
    </div>
  );
}

/* ─── Loading shimmer ─────────────────────────────────────────────── */
function LoadingShimmer() {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14, paddingTop:4 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
        {[1,2,3,4].map(i => <div key={i} style={{ height:72, borderRadius:10, background:'var(--bg2)', border:'1px solid var(--border)' }} className="shimmer"/>)}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        {[1,2].map(i => <div key={i} style={{ height:240, borderRadius:12, background:'var(--bg2)', border:'1px solid var(--border)' }} className="shimmer"/>)}
      </div>
      <div style={{ height:320, borderRadius:12, background:'var(--bg2)', border:'1px solid var(--border)' }} className="shimmer"/>
    </div>
  );
}

/* ─── AI Sheet Dashboard ─────────────────────────────────────────── */
function AiSheetDashboard({ tab }) {
  const allTabs = tab.tabs || [];

  const [activeIdx, setActiveIdx]   = useState(0);
  const [sheetData, setSheetData]   = useState({});
  const [loadingTab, setLoadingTab] = useState(null);
  const [tabError, setTabError]     = useState({});

  const activeTab     = allTabs[activeIdx];
  const activeTabName = activeTab?.name;

  const loadTabData = useCallback(async (tabName) => {
    if (!tab.sheetId || !tabName || sheetData[tabName] !== undefined) return;
    setLoadingTab(tabName);
    try {
      const r = await fetch(`/api/sheets/tab?sheetId=${encodeURIComponent(tab.sheetId)}&tabName=${encodeURIComponent(tabName)}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      // d.rows is already filtered raw string arrays from server; parse to typed objects
      const parsed = parseSheetRows(d.headers || [], d.rows || []);
      setSheetData(prev => ({ ...prev, [tabName]: { headers: d.headers || [], rows: parsed } }));
    } catch(e) {
      setTabError(prev => ({ ...prev, [tabName]: e.message }));
      setSheetData(prev => ({ ...prev, [tabName]: null }));
    } finally {
      setLoadingTab(null);
    }
  }, [tab.sheetId, sheetData]);

  useEffect(() => {
    if (activeTabName) loadTabData(activeTabName);
  }, [activeIdx, activeTabName, loadTabData]);

  const activeData  = sheetData[activeTabName];
  const isLoading   = loadingTab === activeTabName;
  const activeError = tabError[activeTabName];

  if (!allTabs.length) {
    return <div style={{padding:'40px 0',textAlign:'center',color:'var(--text3)',fontSize:13}}>No tabs found.</div>;
  }

  return (
    <div>
      {/* Tab strip — ALL tabs from the sheet */}
      <div style={{ display:'flex', gap:2, marginBottom:24, borderBottom:'1px solid var(--border)', overflowX:'auto', paddingBottom:0 }}>
        {allTabs.map((t, i) => (
          <button key={i} onClick={() => setActiveIdx(i)} style={{
            padding:'8px 16px', fontSize:13, fontWeight:600, flexShrink:0,
            border:'none', background:'none', cursor:'pointer',
            color: activeIdx === i ? 'var(--accent)' : 'var(--text3)',
            borderBottom: activeIdx === i ? '2px solid var(--accent)' : '2px solid transparent',
            transition:'color .14s', whiteSpace:'nowrap',
          }}>
            {t.name}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <LoadingShimmer/>
      ) : activeError ? (
        <div style={{ padding:'16px', background:'var(--danger-dim)', border:'1px solid rgba(192,57,43,.25)', borderRadius:10, fontSize:13, color:'var(--danger)' }}>
          <strong>Could not load tab:</strong> {activeError}
          <div style={{ marginTop:6, fontSize:12, color:'var(--text3)' }}>
            Make sure the sheet is shared as <em>"Anyone with the link can view"</em>.
          </div>
        </div>
      ) : activeData ? (
        <SmartTabRenderer
          key={activeTabName}
          headers={activeData.headers}
          rows={activeData.rows}
          tabName={activeTabName}
        />
      ) : (
        <div style={{padding:'60px 0',textAlign:'center',color:'var(--text3)',fontSize:13}}>
          Select a tab to load its data.
        </div>
      )}
    </div>
  );
}

/* ─── Analyzing state ─────────────────────────────────────────────── */
function AnalyzingState() {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const id = setInterval(() => setDots(d => d.length >= 3 ? '' : d + '.'), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14, paddingTop:8 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, color:'var(--text3)', fontSize:13, marginBottom:4 }}>
        <div style={{ width:16, height:16, border:'2px solid var(--border2)', borderTopColor:'var(--accent)', borderRadius:'50%', animation:'spin .8s linear infinite' }}/>
        Loading your sheet{dots}
      </div>
      <LoadingShimmer/>
    </div>
  );
}

/* ─── KPI / Chart / Table for AI-built dashboards ─────────────────── */
function fmtDate2(s) { return fmtDate(s); }

function KpiRow({ items, row }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:12 }}>
      {items.map((item, i) => (
        <div key={i} style={{ background:'var(--bg)', border:'1px solid var(--border)', borderRadius:10, padding:'14px 16px' }}>
          <div style={{ fontSize:11, color:'var(--text3)', marginBottom:6 }}>{item.label}</div>
          <div style={{ fontSize:24, fontWeight:700, color:'var(--text)', fontVariantNumeric:'tabular-nums' }}>
            {fmtV(row?.[item.field], item.format)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChartViz({ section, data, type }) {
  if (!data?.length) return <div style={{padding:'24px',textAlign:'center',color:'var(--text3)',fontSize:13}}>No data</div>;
  const { xField='date', series=[] } = section;
  const C = type==='bar_chart' ? BarChart : type==='line_chart' ? LineChart : AreaChart;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <C data={data} margin={{top:4,right:12,left:0,bottom:4}}>
        {type==='area_chart' && (
          <defs>{series.map((_,i)=>(
            <linearGradient key={i} id={`gdg${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS[i%CHART_COLORS.length]} stopOpacity={0.25}/>
              <stop offset="95%" stopColor={CHART_COLORS[i%CHART_COLORS.length]} stopOpacity={0}/>
            </linearGradient>
          ))}</defs>
        )}
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false}/>
        <XAxis dataKey={xField} tick={{fontSize:10,fill:'var(--text3)'}} stroke="var(--border2)"
          tickFormatter={v=>/^\d{4}-\d{2}/.test(String(v))?fmtDate2(v):v}/>
        <YAxis tick={{fontSize:10,fill:'var(--text3)'}} stroke="var(--border2)" width={56}
          tickFormatter={v=>Math.abs(v)>=1e6?`$${(v/1e6).toFixed(1)}M`:Math.abs(v)>=1e3?`$${(v/1e3).toFixed(0)}K`:String(v)}/>
        <Tooltip contentStyle={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:8,fontSize:12}}
          formatter={(v,n)=>[typeof v==='number'?v.toLocaleString():v,n]}
          labelFormatter={l=>/^\d{4}-\d{2}/.test(String(l))?fmtDate2(l):l}/>
        <Legend wrapperStyle={{fontSize:11}}/>
        {series.map((s,i)=>{
          const c=s.color||CHART_COLORS[i%CHART_COLORS.length];
          if(type==='bar_chart') return <Bar key={i} dataKey={s.field} name={s.label||s.field} fill={c} radius={[3,3,0,0]}/>;
          if(type==='line_chart') return <Line key={i} type="monotone" dataKey={s.field} name={s.label||s.field} stroke={c} strokeWidth={2} dot={false}/>;
          return <Area key={i} type="monotone" dataKey={s.field} name={s.label||s.field} stroke={c} fill={`url(#gdg${i})`} strokeWidth={2} dot={false}/>;
        })}
      </C>
    </ResponsiveContainer>
  );
}

function TableViz({ section, data }) {
  const [sortBy, setSortBy] = useState(null);
  const [sortDir, setSortDir] = useState('desc');
  if (!data?.length) return <div style={{padding:'24px',textAlign:'center',color:'var(--text3)',fontSize:13}}>No data</div>;
  const cols = section.columns || Object.keys(data[0]).map(f=>({field:f,label:f}));
  const rows = sortBy ? [...data].sort((a,b)=>{
    const va=a[sortBy],vb=b[sortBy];
    if(va==null)return 1;if(vb==null)return-1;
    return sortDir==='asc'?(va<vb?-1:1):(vb<va?-1:1);
  }) : data;
  return (
    <div style={{overflowX:'auto',maxHeight:340,overflowY:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
        <thead style={{position:'sticky',top:0,background:'var(--bg3)',zIndex:1}}>
          <tr>{cols.map(c=>(
            <th key={c.field} onClick={()=>{if(sortBy===c.field)setSortDir(d=>d==='asc'?'desc':'asc');else{setSortBy(c.field);setSortDir('desc');}}}
              style={{padding:'7px 10px',textAlign:'right',fontSize:11,fontWeight:600,color:sortBy===c.field?'var(--accent)':'var(--text3)',cursor:'pointer',whiteSpace:'nowrap'}}>
              {c.label||c.field}{sortBy===c.field?(sortDir==='asc'?' ▲':' ▼'):''}
            </th>
          ))}</tr>
        </thead>
        <tbody>{rows.slice(0,200).map((row,i)=>(
          <tr key={i} style={{background:i%2===0?'transparent':'var(--bg3)'}}
            onMouseEnter={e=>e.currentTarget.style.background='var(--accent-dim)'}
            onMouseLeave={e=>e.currentTarget.style.background=i%2===0?'transparent':'var(--bg3)'}>
            {cols.map(c=>(
              <td key={c.field} style={{padding:'6px 10px',textAlign:'right',color:'var(--text2)'}}>
                {fmtV(row[c.field],c.format)}
              </td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function DashSection({ section, data, error }) {
  if (error) {
    return (
      <div style={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:16,marginBottom:12}}>
        {section.title && <div style={{fontSize:13,fontWeight:600,marginBottom:8}}>{section.title}</div>}
        <div style={{padding:'12px',background:'var(--danger-dim)',border:'1px solid rgba(192,57,43,.2)',borderRadius:8,fontSize:12,color:'var(--danger)'}}>
          Query error: {error}
        </div>
      </div>
    );
  }
  const body = section.type==='kpi_row' ? <KpiRow items={section.items||[]} row={data?.[0]}/>
    : section.type==='table' ? <TableViz section={section} data={data}/>
    : ['area_chart','line_chart','bar_chart'].includes(section.type) ? <ChartViz section={section} data={data} type={section.type}/>
    : <div style={{color:'var(--text3)',fontSize:13}}>Unknown type: {section.type}</div>;
  return (
    <div style={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:16,marginBottom:12}}>
      {section.title && <div style={{fontSize:13,fontWeight:600,marginBottom:12}}>{section.title}</div>}
      {body}
    </div>
  );
}

/* ─── Main export ─────────────────────────────────────────────────── */
export default function GenericDashPage({ tab, showToast }) {
  const [sectionData, setSectionData]     = useState({});
  const [sectionErrors, setSectionErrors] = useState({});
  const [loading, setLoading]             = useState(false);

  useEffect(() => {
    if (!tab?.config?.sections) return;
    setLoading(true); setSectionData({}); setSectionErrors({});
    executeDashboard(tab.config)
      .then(res => { setSectionData(res.results||{}); setSectionErrors(res.errors||{}); })
      .catch(() => showToast?.('Could not load dashboard data', 'error'))
      .finally(() => setLoading(false));
  }, [tab?.id]);

  if (!tab) return <div style={{padding:40,color:'var(--text3)'}}>Dashboard not found</div>;

  const Header = () => (
    <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:20, gap:12, flexWrap:'wrap' }}>
      <div>
        <div style={{ fontSize:20, fontWeight:800, color:'var(--text)' }}>{tab.label}</div>
        <div style={{ fontSize:12, color:'var(--text3)', marginTop:4 }}>
          {tab.subtitle || (tab.type === 'sheet' ? `Google Sheet · ${tab.tabs?.length || 0} tabs` : '')}
        </div>
      </div>
      {tab.sheetId && (
        <a href={`https://docs.google.com/spreadsheets/d/${tab.sheetId}`} target="_blank" rel="noopener noreferrer"
          style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 14px', fontSize:12, fontWeight:600,
            background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:8, color:'var(--text2)', textDecoration:'none' }}
          onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--accent)';e.currentTarget.style.color='var(--accent)';}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.color='var(--text2)';}}>
          <Icons.ExternalLink size={12}/> Open in Google Sheets
        </a>
      )}
    </div>
  );

  /* Google Sheet */
  if (tab.type === 'sheet') {
    if (tab.analyzing) {
      return <div><Header/><AnalyzingState/></div>;
    }
    return (
      <div>
        <Header/>
        <AiSheetDashboard tab={tab}/>
      </div>
    );
  }

  /* AI-built dashboard */
  if (!tab.config?.sections) {
    return (
      <div style={{ padding:'60px 32px', textAlign:'center', color:'var(--text3)' }}>
        <Icons.LayoutGrid size={32} style={{ opacity:.3, marginBottom:12 }}/>
        <div style={{ fontSize:15, fontWeight:600 }}>No dashboard config</div>
        <div style={{ fontSize:13, marginTop:8 }}>This dashboard has no sections yet.</div>
      </div>
    );
  }

  return (
    <div>
      <Header/>
      {loading
        ? [1,2,3].map(i=>(
            <div key={i} style={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:16,marginBottom:12}}>
              <div style={{height:12,width:'28%',borderRadius:4,marginBottom:14}} className="shimmer"/>
              <div style={{height:160,borderRadius:8}} className="shimmer"/>
            </div>
          ))
        : tab.config.sections.map((sec,i)=>(
            <DashSection key={i} section={sec} data={sectionData[i]||[]} error={sectionErrors[i]}/>
          ))
      }
    </div>
  );
}
