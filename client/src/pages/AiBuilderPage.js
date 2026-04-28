import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { generateDashboard, executeDashboard, saveDashboard, fmt$, aiChat } from '../utils/api';
import { Icons } from '../components/Icons';

const CHART_COLORS = ['#6366f1','#14b8a6','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#1877f2','#ea4335'];

const LS_MESSAGES = 'nobl-ai-messages';
const LS_CONFIG   = 'nobl-ai-config';
const LS_HISTORY  = 'nobl-ai-history';
const LS_SAVE_NAME= 'nobl-ai-savename';

function loadLS(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function saveLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(mo)-1]} ${parseInt(dy)}`;
}
function formatCell(v, format) {
  if (v === null || v === undefined) return '—';
  if (format === 'currency') return fmt$(v);
  if (format === 'percent') return `${(parseFloat(v)*100).toFixed(1)}%`;
  if (format === 'number') return typeof v === 'number' ? v.toLocaleString(undefined,{maximumFractionDigits:2}) : v;
  if (format === 'date') return fmtDateLabel(v);
  return typeof v === 'number' ? v.toLocaleString(undefined,{maximumFractionDigits:2}) : String(v);
}

function KpiSection({ section, data }) {
  if (!data?.length) return <EmptyState />;
  const row = data[0];
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:12 }}>
      {(section.items||[]).map((item,i) => (
        <div key={i} style={{
          background:'var(--bg)', border:'1px solid var(--border)', borderRadius:10,
          padding:'14px 16px',
        }}>
          <div style={{ fontSize:11, color:'var(--text3)', marginBottom:6 }}>{item.label}</div>
          <div style={{ fontSize:24, fontWeight:700, color:'var(--text)', fontVariantNumeric:'tabular-nums' }}>
            {formatCell(row[item.field], item.format)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChartSection({ section, data, type }) {
  if (!data?.length) return <EmptyState />;
  const { xField='date', series=[] } = section;
  const C = type==='bar_chart' ? BarChart : type==='line_chart' ? LineChart : AreaChart;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <C data={data} margin={{top:4,right:12,left:0,bottom:4}}>
        {type==='area_chart' && (
          <defs>{series.map((s,i)=>(
            <linearGradient key={i} id={`g${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={s.color||CHART_COLORS[i]} stopOpacity={0.25}/>
              <stop offset="95%" stopColor={s.color||CHART_COLORS[i]} stopOpacity={0}/>
            </linearGradient>
          ))}</defs>
        )}
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false}/>
        <XAxis dataKey={xField} tick={{fontSize:10,fill:'var(--text3)'}} stroke="var(--border2)"
          tickFormatter={v => /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? fmtDateLabel(v) : v}/>
        <YAxis tick={{fontSize:10,fill:'var(--text3)'}} stroke="var(--border2)" width={56}
          tickFormatter={v => Math.abs(v)>=1e6 ? `$${(v/1e6).toFixed(1)}M` : Math.abs(v)>=1e3 ? `$${(v/1e3).toFixed(0)}K` : String(v)}/>
        <Tooltip
          contentStyle={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:8,fontSize:12}}
          formatter={(v,n)=>[typeof v==='number'?v.toLocaleString(undefined,{maximumFractionDigits:2}):v,n]}
          labelFormatter={l=>/^\d{4}-\d{2}-\d{2}/.test(String(l))?fmtDateLabel(l):l}/>
        <Legend wrapperStyle={{fontSize:11}}/>
        {series.map((s,i)=>{
          const col = s.color||CHART_COLORS[i%CHART_COLORS.length];
          if (type==='bar_chart')  return <Bar   key={i} dataKey={s.field} name={s.label||s.field} fill={col} radius={[3,3,0,0]}/>;
          if (type==='line_chart') return <Line  key={i} type="monotone" dataKey={s.field} name={s.label||s.field} stroke={col} strokeWidth={2} dot={false}/>;
          return <Area key={i} type="monotone" dataKey={s.field} name={s.label||s.field} stroke={col} fill={`url(#g${i})`} strokeWidth={2} dot={false}/>;
        })}
      </C>
    </ResponsiveContainer>
  );
}

function TableSection({ section, data }) {
  const [sortBy,setSortBy] = useState(null);
  const [sortDir,setSortDir] = useState('desc');
  if (!data?.length) return <EmptyState />;
  const cols = section.columns || Object.keys(data[0]).map(f=>({field:f,label:f}));
  const sorted = sortBy ? [...data].sort((a,b)=>{
    const va=a[sortBy],vb=b[sortBy];
    if (va==null) return 1; if (vb==null) return -1;
    return sortDir==='asc' ? (va<vb?-1:1) : (vb<va?-1:1);
  }) : data;
  return (
    <div style={{overflowX:'auto',maxHeight:320,overflowY:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
        <thead style={{position:'sticky',top:0,background:'var(--bg3)',zIndex:1}}>
          <tr>
            {cols.map(c=>(
              <th key={c.field} onClick={()=>{if(sortBy===c.field)setSortDir(d=>d==='asc'?'desc':'asc');else{setSortBy(c.field);setSortDir('desc');}}}
                style={{padding:'7px 10px',textAlign:'right',fontSize:11,fontWeight:600,
                  color:sortBy===c.field?'var(--accent)':'var(--text3)',cursor:'pointer',whiteSpace:'nowrap',userSelect:'none'}}>
                {c.label||c.field} {sortBy===c.field?(sortDir==='asc'?'▲':'▼'):''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0,200).map((row,i)=>(
            <tr key={i} style={{background:i%2===0?'transparent':'var(--bg3)',transition:'background .1s'}}
              onMouseEnter={e=>e.currentTarget.style.background='var(--accent-dim)'}
              onMouseLeave={e=>e.currentTarget.style.background=i%2===0?'transparent':'var(--bg3)'}>
              {cols.map(c=>(
                <td key={c.field} style={{padding:'6px 10px',textAlign:'right',color:'var(--text2)'}}>
                  {formatCell(row[c.field],c.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState() {
  return <div style={{padding:'24px',textAlign:'center',color:'var(--text3)',fontSize:13}}>No data available</div>;
}

function Section({ section, data }) {
  const inner = section.type==='kpi_row' ? <KpiSection section={section} data={data}/>
    : section.type==='table' ? <TableSection section={section} data={data}/>
    : ['area_chart','line_chart','bar_chart'].includes(section.type) ? <ChartSection section={section} data={data} type={section.type}/>
    : <div style={{color:'var(--text3)',fontSize:13}}>Unknown: {section.type}</div>;
  return (
    <div style={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:16,marginBottom:14}}>
      {section.title && <div style={{fontSize:13,fontWeight:700,marginBottom:12,color:'var(--text)'}}>{section.title}</div>}
      {inner}
    </div>
  );
}

function Skeleton() {
  return (
    <div style={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:16,marginBottom:14}}>
      <div style={{height:13,width:'35%',borderRadius:6,marginBottom:14}} className="shimmer"/>
      <div style={{height:180,borderRadius:8}} className="shimmer"/>
    </div>
  );
}

function Bubble({ role, content, isLoading }) {
  if (isLoading) return (
    <div style={{display:'flex',alignItems:'flex-start',marginBottom:12}}>
      <div style={{background:'var(--bg3)',borderRadius:'12px 12px 12px 2px',padding:'12px 16px'}}>
        <div style={{display:'flex',gap:5}}>
          {[0,1,2].map(i=>(
            <div key={i} style={{width:6,height:6,borderRadius:'50%',background:'var(--accent)',
              animation:`pulse 1s ease-in-out ${i*0.2}s infinite`}}/>
          ))}
        </div>
      </div>
    </div>
  );
  return (
    <div style={{marginBottom:14,display:'flex',flexDirection:'column',alignItems:role==='user'?'flex-end':'flex-start'}}>
      <div style={{
        maxWidth:'88%',padding:'9px 14px',
        borderRadius:role==='user'?'12px 12px 2px 12px':'12px 12px 12px 2px',
        background:role==='user'?'var(--accent)':'var(--bg3)',
        color:role==='user'?'#fff':'var(--text)',
        fontSize:13,lineHeight:1.6,
      }}>
        {content.split('\n').map((line,i) => {
          const stripped = line.replace(/\*\*(.*?)\*\*/g,'$1');
          return <div key={i} style={{minHeight:line?undefined:'8px'}}>{stripped}</div>;
        })}
      </div>
      <div style={{fontSize:10,color:'var(--text4)',marginTop:3,paddingLeft:4}}>
        {role==='user'?'You':'Nysonian AI'}
      </div>
    </div>
  );
}

const STARTERS = [
  { label:'NOBL Meta performance', text:'I want a dashboard for NOBL Air META channel performance' },
  { label:'FLO product revenue',   text:'Show me Pilates FLO revenue breakdown by product' },
  { label:'Channel comparison',    text:'Compare all channels for both brands' },
  { label:'Subscription trends',   text:'NOBL Air subscription revenue and trends' },
  { label:'Import Google Sheet',   text:'Import a Google Sheet to create a dashboard' },
  { label:'Daily MER trend',       text:'NOBL Air daily MER trend last 90 days' },
];

function fmtHistDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  if (diff < 7*86400000) return `${Math.floor(diff/86400000)}d ago`;
  return d.toLocaleDateString('en-US', {month:'short', day:'numeric'});
}

function HistoryDrawer({ history, onRestore, onDelete, onClose, onClearAll }) {
  return (
    <div style={{
      position:'absolute', top:0, left:0, bottom:0, width:'100%',
      background:'var(--bg2)', zIndex:20, display:'flex', flexDirection:'column',
      borderRight:'1px solid var(--border)',
    }}>
      {/* Header */}
      <div style={{
        padding:'14px 16px', borderBottom:'1px solid var(--border)',
        display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0,
      }}>
        <div style={{fontSize:13, fontWeight:700, color:'var(--text)'}}>Chat History</div>
        <div style={{display:'flex', gap:6}}>
          {history.length > 0 && (
            <button onClick={onClearAll} title="Clear all history" style={{
              padding:'4px 8px', fontSize:11, background:'none',
              border:'1px solid var(--border)', borderRadius:6,
              color:'var(--text3)', cursor:'pointer',
            }}>Clear all</button>
          )}
          <button onClick={onClose} style={{
            width:26, height:26, display:'flex', alignItems:'center', justifyContent:'center',
            background:'none', border:'none', cursor:'pointer', color:'var(--text3)',
            borderRadius:6,
          }}>
            <Icons.X size={14}/>
          </button>
        </div>
      </div>

      {/* List */}
      <div style={{flex:1, overflowY:'auto', padding:'10px 12px'}} className="hide-scrollbar">
        {history.length === 0 ? (
          <div style={{padding:'32px 16px', textAlign:'center', color:'var(--text4)', fontSize:12, lineHeight:1.6}}>
            No history yet. Start a conversation and your sessions will appear here.
          </div>
        ) : (
          [...history].reverse().map(session => (
            <div key={session.id} style={{
              marginBottom:8, padding:'10px 12px',
              background:'var(--bg3)', borderRadius:10,
              border:'1px solid var(--border)', cursor:'pointer',
              transition:'border-color .12s',
              position:'relative',
            }}
              onClick={() => onRestore(session)}
              onMouseEnter={e => e.currentTarget.style.borderColor='var(--accent)'}
              onMouseLeave={e => e.currentTarget.style.borderColor='var(--border)'}
            >
              <div style={{fontSize:12, fontWeight:600, color:'var(--text)', marginBottom:3, paddingRight:24,
                overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                {session.title || 'Conversation'}
              </div>
              <div style={{fontSize:10, color:'var(--text4)'}}>
                {session.messages.length} messages · {fmtHistDate(session.id)}
              </div>
              {session.configTitle && (
                <div style={{
                  marginTop:5, padding:'3px 8px',
                  background:'var(--accent-dim)', borderRadius:4,
                  fontSize:10, color:'var(--accent)', fontWeight:500,
                  display:'inline-block',
                }}>
                  📊 {session.configTitle}
                </div>
              )}
              <button
                onClick={e => { e.stopPropagation(); onDelete(session.id); }}
                style={{
                  position:'absolute', top:8, right:8,
                  width:20, height:20, display:'flex', alignItems:'center', justifyContent:'center',
                  background:'none', border:'none', cursor:'pointer',
                  color:'var(--text4)', borderRadius:4, padding:0,
                }}
                title="Remove"
              >
                <Icons.X size={11}/>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function AiBuilderPage({ showToast, onDashboardCreated }) {
  // ── Persisted state ──────────────────────────────────────────────
  const [messages, setMessages] = useState(() => loadLS(LS_MESSAGES, []));
  const [config, setConfig]     = useState(() => loadLS(LS_CONFIG, null));
  const [saveName, setSaveName] = useState(() => loadLS(LS_SAVE_NAME, ''));
  const [history, setHistory]   = useState(() => loadLS(LS_HISTORY, []));

  // ── Ephemeral state ──────────────────────────────────────────────
  const [input, setInput]             = useState('');
  const [aiLoading, setAiLoading]     = useState(false);
  const [sectionData, setSectionData] = useState({});
  const [dataLoading, setDataLoading] = useState(false);
  const [showSave, setShowSave]       = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [sheetUrl, setSheetUrl]       = useState('');
  const [sheetLoading, setSheetLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const [leftWidth, setLeftWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('nobl-ai-split') || '420', 10); } catch { return 420; }
  });
  const chatEndRef   = useRef(null);
  const inputRef     = useRef(null);
  const containerRef = useRef(null);
  const dragRef      = useRef(false);

  // ── Drag-to-resize ───────────────────────────────────────────────
  function handleDividerMouseDown(e) {
    e.preventDefault();
    dragRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  useEffect(() => {
    function onMouseMove(e) {
      if (!dragRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newW = Math.min(Math.max(e.clientX - rect.left, 280), rect.width - 320);
      setLeftWidth(newW);
      try { localStorage.setItem('nobl-ai-split', String(Math.round(newW))); } catch {}
    }
    function onMouseUp() {
      if (!dragRef.current) return;
      dragRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, []);

  // ── Persist to localStorage on change ───────────────────────────
  useEffect(() => { saveLS(LS_MESSAGES, messages); }, [messages]);
  useEffect(() => { if (config) saveLS(LS_CONFIG, config); }, [config]);
  useEffect(() => { saveLS(LS_SAVE_NAME, saveName); }, [saveName]);
  useEffect(() => { saveLS(LS_HISTORY, history); }, [history]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior:'smooth' }); }, [messages, aiLoading]);

  const executeConfig = useCallback(async (cfg) => {
    if (!cfg?.sections) return;
    setDataLoading(true);
    setSectionData({});
    try {
      const res = await executeDashboard(cfg);
      setSectionData(res.results || {});
    } catch(e) {
      console.error('[Execute]', e);
      showToast?.('Could not load data', 'error');
    } finally {
      setDataLoading(false);
    }
  }, [showToast]);

  // Re-execute saved config on first mount
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      const savedCfg = loadLS(LS_CONFIG, null);
      if (savedCfg?.sections) executeConfig(savedCfg);
    }
  }, [executeConfig]);

  // ── Save current session to history ─────────────────────────────
  function saveToHistory(msgs, cfg) {
    if (!msgs.length) return;
    const firstUser = msgs.find(m => m.role === 'user');
    const title = cfg?.title || firstUser?.content?.slice(0, 60) || 'Conversation';
    const session = {
      id: Date.now(),
      title,
      configTitle: cfg?.title || null,
      messages: msgs,
    };
    setHistory(prev => [...prev.slice(-49), session]); // keep last 50
  }

  // ── New session ──────────────────────────────────────────────────
  function handleNewSession() {
    if (messages.length > 0) saveToHistory(messages, config);
    setMessages([]);
    setConfig(null);
    setSectionData({});
    setSaveName('');
    setShowSave(false);
    setShowHistory(false);
    try { localStorage.removeItem(LS_CONFIG); } catch {}
    inputRef.current?.focus();
  }

  // ── Restore from history ─────────────────────────────────────────
  function handleRestore(session) {
    if (messages.length > 0) saveToHistory(messages, config);
    setMessages(session.messages || []);
    setConfig(null);
    setSectionData({});
    setShowSave(false);
    setShowHistory(false);
    showToast?.('Session restored', 'info');
  }

  function handleDeleteHistory(id) {
    setHistory(prev => prev.filter(s => s.id !== id));
  }

  function handleClearHistory() {
    setHistory([]);
  }

  // ── Send message ─────────────────────────────────────────────────
  async function handleSend() {
    const text = input.trim();
    if (!text || aiLoading) return;

    if (text.includes('docs.google.com/spreadsheets') || text.includes('sheets.google.com')) {
      setInput('');
      await handleSheetImport(text);
      return;
    }

    const userMsg = { role:'user', content:text };
    const hist = [...messages, userMsg];
    setMessages(hist);
    setInput('');
    setAiLoading(true);

    try {
      const res = await fetch('/api/ai/dashboard-generate', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ messages: hist, mode: 'clarify' }),
      }).then(r=>r.json());

      if (res.error) throw new Error(res.error);

      let rawContent = res.message || '';
      const jsonMatch = rawContent.match(/\{[\s\S]*"sections"[\s\S]*\}/);

      if (jsonMatch) {
        let cfg;
        try { cfg = JSON.parse(jsonMatch[0]); } catch {}
        if (cfg?.sections) {
          const aiMsg = { role:'assistant', content:`Dashboard ready: **${cfg.title}**\n${cfg.description||''}\n\nPreview is showing on the right.` };
          const newMsgs = [...hist, aiMsg];
          setMessages(newMsgs);
          setConfig(cfg);
          setSaveName(cfg.title||'My Dashboard');
          setShowSave(true);
          executeConfig(cfg);
          // Auto-save to history when dashboard is generated
          saveToHistory(newMsgs, cfg);
        } else {
          setMessages(p=>[...p, { role:'assistant', content: rawContent }]);
        }
      } else {
        setMessages(p=>[...p, { role:'assistant', content: rawContent }]);
      }
    } catch(e) {
      setMessages(p=>[...p, { role:'assistant', content:`Sorry, I hit an error: ${e.message}. Please try again.` }]);
    } finally {
      setAiLoading(false);
    }
  }

  async function handleSheetImport(url) {
    const urlToUse = url || sheetUrl.trim();
    if (!urlToUse) return;
    const match = urlToUse.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) { showToast?.('Invalid Google Sheets URL', 'error'); return; }
    const spreadsheetId = match[1];
    setSheetLoading(true);
    setSheetUrl('');

    // Step 1: tell user we're starting
    setMessages(p => [...p,
      { role:'user', content:`Import this Google Sheet: ${urlToUse}` },
      { role:'assistant', content:`Reading your Google Sheet…` },
    ]);

    try {
      // Step 2: import (get metadata + tab list)
      const importRes = await fetch('/api/sheets/import', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ spreadsheetId }),
      }).then(r => r.json());
      if (importRes.error) throw new Error(importRes.error);

      const tabCount = importRes.tabs?.length || 0;

      // Step 3: update message — now analyzing
      setMessages(p => p.map((m, i) => i === p.length - 1
        ? { ...m, content:`Found **${tabCount} tabs** in "${importRes.title}".\n\nNow analyzing the data with AI to build a proper dashboard…` }
        : m
      ));

      // Step 4: AI analysis — reads tab data + generates dashboard config
      let aiConfig = null;
      try {
        const analyzeRes = await fetch('/api/sheets/analyze', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ spreadsheetId, tabs: importRes.tabs }),
        }).then(r => r.json());
        if (!analyzeRes.error) aiConfig = analyzeRes.config;
      } catch(e) {
        console.warn('[Sheet analyze]', e.message);
        // Non-fatal — fall back to raw view
      }

      const analyzedCount = aiConfig?.analyzedTabs?.length || 0;

      // Step 5: create dashboard entry
      if (importRes.tabs && onDashboardCreated) {
        const dashId = `sheet_${spreadsheetId}_${Date.now()}`;
        const dash = {
          id: dashId,
          label: importRes.title || 'Imported Sheet',
          subtitle: analyzedCount > 0
            ? `${analyzedCount} AI dashboards · from ${tabCount} tabs`
            : `Google Sheet · ${tabCount} tabs`,
          type: 'sheet',
          sheetId: spreadsheetId,
          tabs: importRes.tabs,
          aiConfig,
        };
        onDashboardCreated(dash);

        const successMsg = analyzedCount > 0
          ? `Done! Built **${analyzedCount} dashboards** from "${importRes.title}" with KPI cards, charts, and tables in your style.\n\nClick it in the sidebar to explore.`
          : `Imported "${importRes.title}" (${tabCount} tabs). The AI analysis didn't return a config — showing raw data view.\n\nIt's in your sidebar now.`;

        setMessages(p => [...p, { role:'assistant', content: successMsg }]);
      }
    } catch(e) {
      const msg = e.message || '';
      const isCredErr = msg.includes('not configured') || msg.includes('API_KEY');
      const friendly = isCredErr
        ? `Google Sheets is not configured.\n\nFix:\n1. console.cloud.google.com → APIs & Services → Credentials → Create API Key\n2. Enable "Google Sheets API"\n3. Add GOOGLE_API_KEY=your_key to .env\n4. Share sheet as "Anyone with the link can view"\n5. Restart the server`
        : `Couldn't import the sheet: ${msg}`;
      setMessages(p => [...p, { role:'assistant', content: friendly }]);
      showToast?.('Sheet import failed', 'warn');
    } finally {
      setSheetLoading(false);
    }
  }

  function handleKey(e) {
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  async function handleSaveDash() {
    if (!config || !saveName.trim()) return;
    setSaveLoading(true);
    try {
      const saved = await saveDashboard({ name:saveName.trim(), description:config.description||'', config });
      const dash = { id:`dash_${saved.id||Date.now()}`, label:saveName.trim(), subtitle:config.description||'Custom AI dashboard', type:'dashboard', config, dbId:saved.id };
      onDashboardCreated?.(dash);
      setShowSave(false);
      showToast?.(`"${saveName}" added to sidebar`, 'success');
    } catch(e) { showToast?.('Could not save', 'error'); }
    finally { setSaveLoading(false); }
  }

  function handleStarter(text) { setInput(text); inputRef.current?.focus(); }

  const hasContent = messages.length > 0;

  return (
    <div ref={containerRef} style={{ display:'flex', flex:1, minHeight:0, overflow:'hidden', position:'relative' }}>

      {/* ── Left: Chat ────────────────────────── */}
      <div style={{
        width: leftWidth, minWidth:280, flexShrink:0,
        display:'flex', flexDirection:'column',
        background:'var(--bg2)',
        position:'relative',
        overflow:'hidden',
      }}>
        {/* History drawer overlay */}
        {showHistory && (
          <HistoryDrawer
            history={history}
            onRestore={handleRestore}
            onDelete={handleDeleteHistory}
            onClose={() => setShowHistory(false)}
            onClearAll={handleClearHistory}
          />
        )}

        {/* Header */}
        <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <div style={{
                width:30, height:30, borderRadius:8, flexShrink:0,
                background:'var(--accent)',
                display:'flex', alignItems:'center', justifyContent:'center',
              }}>
                <Icons.Wand size={14} style={{color:'#fff'}}/>
              </div>
              <div>
                <div style={{ fontSize:14, fontWeight:700, color:'var(--text)' }}>AI Dashboard Builder</div>
                <div style={{ fontSize:11, color:'var(--text3)' }}>Ask questions · import sheets · build dashboards</div>
              </div>
            </div>

            {/* Header actions */}
            <div style={{ display:'flex', gap:4 }}>
              {/* History button */}
              <button
                onClick={() => setShowHistory(v => !v)}
                title="Chat history"
                style={{
                  width:30, height:30, display:'flex', alignItems:'center', justifyContent:'center',
                  background: showHistory ? 'var(--accent-dim)' : 'none',
                  border:'1px solid var(--border)',
                  borderRadius:7, cursor:'pointer',
                  color: showHistory ? 'var(--accent)' : 'var(--text3)',
                  position:'relative',
                }}
              >
                <Icons.Clock size={13}/>
                {history.length > 0 && (
                  <span style={{
                    position:'absolute', top:-4, right:-4,
                    width:14, height:14, borderRadius:'50%',
                    background:'var(--accent)', color:'#fff',
                    fontSize:8, fontWeight:700,
                    display:'flex', alignItems:'center', justifyContent:'center',
                  }}>
                    {history.length > 9 ? '9+' : history.length}
                  </span>
                )}
              </button>

              {/* New session button */}
              {hasContent && (
                <button
                  onClick={handleNewSession}
                  title="New session (saves current to history)"
                  style={{
                    width:30, height:30, display:'flex', alignItems:'center', justifyContent:'center',
                    background:'none', border:'1px solid var(--border)',
                    borderRadius:7, cursor:'pointer', color:'var(--text3)',
                  }}
                >
                  <Icons.Plus size={13}/>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex:1, overflowY:'auto', padding:'16px' }} className="hide-scrollbar">
          {!hasContent ? (
            <div>
              <div style={{ fontSize:13, color:'var(--text3)', marginBottom:12, lineHeight:1.6 }}>
                Tell me what you want to build, or paste a Google Sheets link to import it.
                I'll ask a few quick questions to make sure I get it right.
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                {STARTERS.map((s,i) => (
                  <button key={i} onClick={() => handleStarter(s.text)} style={{
                    padding:'10px 12px', textAlign:'left',
                    background:'var(--bg3)', border:'1px solid var(--border)',
                    borderRadius:9, cursor:'pointer', fontSize:12, color:'var(--text2)',
                    transition:'all .14s', fontFamily:'inherit', lineHeight:1.4,
                  }}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--accent)';e.currentTarget.style.color='var(--accent)';}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.color='var(--text2)';}}>
                    <div style={{ fontSize:10, color:'var(--text4)', marginBottom:2 }}>Quick start</div>
                    {s.label}
                  </button>
                ))}
              </div>

              {/* Sheet import */}
              <div style={{ marginTop:16, padding:'12px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--border)' }}>
                <div style={{ fontSize:12, fontWeight:600, color:'var(--text)', marginBottom:8, display:'flex', alignItems:'center', gap:6 }}>
                  <Icons.ExternalLink size={13} style={{color:'var(--accent)'}}/>
                  Import Google Sheet
                </div>
                <div style={{ display:'flex', gap:6 }}>
                  <input
                    value={sheetUrl} onChange={e=>setSheetUrl(e.target.value)}
                    placeholder="Paste sheet URL…"
                    style={{ flex:1, padding:'7px 10px', fontSize:12, borderRadius:7,
                      border:'1px solid var(--border)', background:'var(--bg2)',
                      color:'var(--text)', outline:'none', fontFamily:'inherit' }}
                  />
                  <button onClick={()=>handleSheetImport()} disabled={!sheetUrl.trim()||sheetLoading}
                    style={{ padding:'7px 14px', fontSize:12, fontWeight:600, background:'var(--accent)',
                      color:'#fff', border:'none', borderRadius:7, cursor:'pointer',
                      opacity:!sheetUrl.trim()||sheetLoading?.6:1 }}>
                    {sheetLoading ? '…' : 'Import'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              {messages.map((m,i) => <Bubble key={i} role={m.role} content={m.content}/>)}
              {aiLoading && <Bubble isLoading />}
            </>
          )}
          <div ref={chatEndRef}/>
        </div>

        {/* Save form */}
        {showSave && config && (
          <div style={{ padding:'10px 16px', borderTop:'1px solid var(--border)', background:'var(--accent-dim)', flexShrink:0 }}>
            <div style={{ fontSize:11, color:'var(--accent)', fontWeight:600, marginBottom:6 }}>
              ✦ Add this dashboard to your sidebar:
            </div>
            <div style={{ display:'flex', gap:6 }}>
              <input value={saveName} onChange={e=>setSaveName(e.target.value)}
                placeholder="Dashboard name"
                style={{ flex:1, padding:'6px 10px', fontSize:12, borderRadius:7,
                  border:'1px solid var(--border)', background:'var(--bg2)',
                  color:'var(--text)', outline:'none' }}/>
              <button onClick={handleSaveDash} disabled={saveLoading||!saveName.trim()}
                style={{ padding:'6px 14px', fontSize:12, fontWeight:600, background:'var(--accent)',
                  color:'#fff', border:'none', borderRadius:7, cursor:'pointer',
                  opacity:saveLoading||!saveName.trim()?.6:1 }}>
                {saveLoading ? '…' : 'Add'}
              </button>
              <button onClick={()=>setShowSave(false)} style={{ padding:'6px 8px', fontSize:12,
                background:'none', border:'1px solid var(--border)', borderRadius:7,
                cursor:'pointer', color:'var(--text3)' }}>
                <Icons.X size={12}/>
              </button>
            </div>
          </div>
        )}

        {/* Input */}
        <div style={{ padding:'12px 16px', borderTop:'1px solid var(--border)', flexShrink:0 }}>
          <div style={{ display:'flex', gap:8 }}>
            <textarea ref={inputRef} value={input}
              onChange={e=>setInput(e.target.value)} onKeyDown={handleKey}
              placeholder="Describe what you want, or paste a Google Sheets URL…"
              rows={2}
              style={{ flex:1, padding:'9px 12px', fontSize:13,
                borderRadius:9, border:'1px solid var(--border)',
                background:'var(--bg3)', color:'var(--text)',
                resize:'none', outline:'none', fontFamily:'inherit', lineHeight:1.5 }}/>
            <button onClick={handleSend} disabled={aiLoading||!input.trim()}
              style={{
                padding:'0 16px', borderRadius:9, border:'none',
                background:aiLoading||!input.trim()?'var(--bg4)':'var(--accent)',
                color:aiLoading||!input.trim()?'var(--text3)':'#fff',
                cursor:aiLoading||!input.trim()?'not-allowed':'pointer',
                fontSize:18, fontWeight:700, transition:'all .14s',
              }}>
              <Icons.Send size={15}/>
            </button>
          </div>
          <div style={{ fontSize:10, color:'var(--text4)', marginTop:5 }}>Enter ↵ to send · Shift+Enter for new line</div>
        </div>
      </div>

      {/* ── Drag handle ───────────────────────── */}
      <div
        onMouseDown={handleDividerMouseDown}
        style={{
          width:5, flexShrink:0, cursor:'col-resize',
          background:'var(--border)',
          transition:'background .15s',
          position:'relative', zIndex:10,
          display:'flex', alignItems:'center', justifyContent:'center',
        }}
        onMouseEnter={e => e.currentTarget.style.background='var(--accent)'}
        onMouseLeave={e => e.currentTarget.style.background='var(--border)'}
        title="Drag to resize"
      >
        {/* grip dots */}
        <div style={{ display:'flex', flexDirection:'column', gap:3, pointerEvents:'none' }}>
          {[0,1,2].map(i => (
            <div key={i} style={{ width:3, height:3, borderRadius:'50%', background:'var(--text4)' }}/>
          ))}
        </div>
      </div>

      {/* ── Right: Preview ────────────────────── */}
      <div style={{
        flex:1, background:'var(--bg)',
        overflowY:'auto', padding:24,
        minWidth:0,
      }}>
        {!config && !dataLoading ? (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:16, color:'var(--text3)', textAlign:'center' }}>
            <div style={{
              width:56, height:56, borderRadius:16,
              background:'var(--bg3)',
              display:'flex', alignItems:'center', justifyContent:'center',
              border:'1px solid var(--border)',
            }}>
              <Icons.LayoutGrid size={24} style={{opacity:.5}}/>
            </div>
            <div>
              <div style={{ fontSize:16, fontWeight:700, color:'var(--text2)', marginBottom:6 }}>Dashboard preview</div>
              <div style={{ fontSize:13 }}>Your dashboard will render here as you chat.</div>
            </div>
          </div>
        ) : (
          <>
            {config && (
              <div style={{ marginBottom:20 }}>
                <div style={{ fontSize:20, fontWeight:800, color:'var(--text)' }}>{config.title}</div>
                {config.description && <div style={{ fontSize:12, color:'var(--text3)', marginTop:4 }}>{config.description}</div>}
              </div>
            )}
            {dataLoading
              ? [1,2,3].map(i=><Skeleton key={i}/>)
              : (config?.sections||[]).map((sec,i)=>(
                  <Section key={i} section={sec} data={sectionData[i]||[]}/>
                ))
            }
          </>
        )}
      </div>
    </div>
  );
}
