import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';

const CHART_COLORS = ['#6366f1','#22c55e','#f59e0b','#ef4444','#3b82f6','#ec4899','#14b8a6','#f97316'];

function fmtVal(v) {
  if (v == null || v === '') return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return String(v);
  if (Math.abs(n) >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1000) return n % 1 === 0 ? n.toLocaleString() : '$' + (n/1000).toFixed(1) + 'K';
  if (Math.abs(n) < 10 && String(v).includes('.')) return n.toFixed(2) + (String(v).includes('%') ? '%' : 'x');
  return n.toFixed(n % 1 ? 1 : 0);
}

function QueryTable({ columns, rows }) {
  if (!columns?.length || !rows?.length) return null;
  return (
    <div style={{ overflowX: 'auto', marginTop: 10, borderRadius: 8, border: '1px solid var(--border2)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: 'var(--bg3)' }}>
            {columns.map(c => (
              <th key={c} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((row, i) => (
            <tr key={i} style={{ background: i % 2 ? 'var(--bg3)' : 'transparent' }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '6px 10px', color: 'var(--text2)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{fmtVal(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 50 && <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text3)' }}>Showing 50 of {rows.length} rows</div>}
    </div>
  );
}

function QueryChart({ columns, rows, chartHint }) {
  if (!columns?.length || !rows?.length) return null;

  // Build objects from columns + rows
  const data = rows.slice(0, 60).map(row => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });

  const dateCol = columns.find(c => c.includes('date') || c === 'day' || c === 'week');
  const numCols = columns.filter(c => c !== dateCol && !c.includes('id') && !c.includes('brand') && !c.includes('channel') && !c.includes('region') && data.some(r => !isNaN(parseFloat(r[c]))));
  const catCol  = columns.find(c => ['channel','region','brand','tw_channel','name','label'].includes(c));

  if (chartHint === 'line_chart' && dateCol && numCols.length) {
    const mainCols = numCols.slice(0, 3);
    return (
      <div style={{ marginTop: 10, background: 'var(--bg3)', borderRadius: 8, padding: '12px 8px 8px' }}>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {mainCols.map((c, i) => (
                <linearGradient key={c} id={`cg${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={CHART_COLORS[i]} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS[i]} stopOpacity={0}   />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey={dateCol} tick={{ fontSize: 9, fill: 'var(--text3)' }} tickFormatter={v => String(v||'').slice(5)} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 9, fill: 'var(--text3)' }} width={44} tickFormatter={v => fmtVal(v)} />
            <Tooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 6, fontSize: 11 }} formatter={(v,n)=>[fmtVal(v),n]} />
            {mainCols.map((c, i) => (
              <Area key={c} type="monotone" dataKey={c} stroke={CHART_COLORS[i]} strokeWidth={2} fill={`url(#cg${i})`} dot={false} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chartHint === 'bar_chart' && (catCol || !dateCol) && numCols.length) {
    const labelCol = catCol || columns[0];
    const valCol   = numCols[0];
    const barData  = data.slice(0, 12).map(r => ({ name: String(r[labelCol]||''), value: parseFloat(r[valCol])||0 }));
    return (
      <div style={{ marginTop: 10, background: 'var(--bg3)', borderRadius: 8, padding: '12px 8px 8px' }}>
        <ResponsiveContainer width="100%" height={Math.max(120, barData.length * 28)}>
          <BarChart data={barData} layout="vertical" margin={{ top: 4, right: 16, left: 60, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 9, fill: 'var(--text3)' }} tickFormatter={fmtVal} />
            <YAxis dataKey="name" type="category" tick={{ fontSize: 10, fill: 'var(--text2)' }} width={58} />
            <Tooltip contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 6, fontSize: 11 }} formatter={(v)=>[fmtVal(v), valCol]} />
            <Bar dataKey="value" radius={[0, 4, 4, 0]}>
              {barData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chartHint === 'kpi_cards' && numCols.length && rows.length === 1) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {numCols.slice(0, 8).map((c, i) => (
          <div key={c} style={{ background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 8, padding: '10px 14px', minWidth: 90 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', marginBottom: 4 }}>{c.replace(/_/g,' ')}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: CHART_COLORS[i % CHART_COLORS.length] }}>{fmtVal(data[0][c])}</div>
          </div>
        ))}
      </div>
    );
  }

  // Default: table
  return <QueryTable columns={columns} rows={rows} />;
}

function MsgContent({ content, queryResult, chartHint }) {
  // Render markdown-lite: bold, bullets, line breaks
  const lines = (content || '').split('\n');
  return (
    <div style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--text)' }}>
      {lines.map((line, i) => {
        if (!line.trim()) return <br key={i} />;
        const parts = line.split(/\*\*(.*?)\*\*/g);
        const rendered = parts.map((p, j) => j % 2 === 1 ? <strong key={j}>{p}</strong> : p);
        if (line.startsWith('• ') || line.startsWith('- ') || line.startsWith('* ')) {
          return <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 2 }}><span style={{ color: 'var(--accent)', flexShrink: 0 }}>•</span><span>{rendered}</span></div>;
        }
        return <div key={i}>{rendered}</div>;
      })}
      {queryResult && (
        <QueryChart columns={queryResult.columns} rows={queryResult.rows} chartHint={chartHint} />
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '10px 14px' }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', animation: `aiDot 1.2s ease-in-out ${i * 0.2}s infinite` }} />
      ))}
    </div>
  );
}

export default function AiAssistant({ activeTab }) {
  const [open, setOpen]       = useState(false);
  const [messages, setMessages] = useState([
    { role: 'assistant', content: "Ask me anything — MER, ROAS, channel spend, trends, regional breakdown. I'll query the database and show you the data." }
  ]);
  const [input, setInput]     = useState('');
  const [loading, setLoading] = useState(false);
  const [pulse, setPulse]     = useState(true);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => {
    if (open) { setPulse(false); setTimeout(() => inputRef.current?.focus(), 200); }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const send = useCallback(async (text) => {
    const msg = text || input.trim();
    if (!msg || loading) return;
    setInput('');
    const newMessages = [...messages, { role: 'user', content: msg }];
    setMessages(newMessages);
    setLoading(true);
    try {
      const apiMessages = newMessages.map(m => ({ role: m.role, content: m.content }));
      const r = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ messages: apiMessages, activeTab: activeTab || '' })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: d.reply || '',
        queryResult: d.queryResult || null,
        chartHint: d.chartHint || null,
      }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, activeTab]);

  const handleKey = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  const QUICK = [
    "What's NOBL's MER yesterday?",
    "Show channel ROAS this week",
    "Compare NOBL vs FLO revenue last 30 days",
    "Which channel has best ROAS?",
    "Regional MER breakdown",
    "Klaviyo email performance",
  ];

  return (
    <>
      <style>{`
        @keyframes aiDot{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}
        @keyframes aiSlide{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes aiPulse{0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,.5)}50%{box-shadow:0 0 0 10px rgba(99,102,241,0)}}
      `}</style>

      {/* Bubble */}
      <button onClick={() => setOpen(o => !o)} style={{
        position: 'fixed', bottom: 24, right: 24, zIndex: 9000,
        width: 52, height: 52, borderRadius: '50%',
        background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
        border: 'none', cursor: 'pointer', color: '#fff', fontSize: 22,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 4px 20px rgba(99,102,241,.5)',
        animation: pulse ? 'aiPulse 2s ease-in-out infinite' : 'none',
        transition: 'transform .15s',
      }}>
        {open ? '✕' : '✦'}
      </button>

      {/* Panel */}
      {open && (
        <div style={{
          position: 'fixed', bottom: 84, right: 24, zIndex: 8999,
          width: 420, height: 600,
          background: 'var(--bg2)', border: '1px solid var(--border2)',
          borderRadius: 16, display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,.35)',
          animation: 'aiSlide .2s ease',
        }}>
          {/* Header */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: '#fff', fontWeight: 700 }}>✦</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Analytics AI</div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>Queries your database live</div>
            </div>
            <button onClick={() => setMessages([{ role: 'assistant', content: "Chat cleared." }])}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 11, padding: '4px 8px', borderRadius: 6, hover: 'var(--bg3)' }}>
              Clear
            </button>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: m.role === 'user' ? 'row-reverse' : 'row', gap: 8, alignItems: 'flex-start' }}>
                {m.role === 'assistant' && (
                  <div style={{ width: 24, height: 24, borderRadius: 6, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', flexShrink: 0, marginTop: 2 }}>✦</div>
                )}
                <div style={{
                  maxWidth: '90%',
                  background: m.role === 'user' ? 'var(--accent)' : 'var(--bg3)',
                  color: m.role === 'user' ? '#fff' : 'var(--text)',
                  borderRadius: m.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                  padding: '9px 13px',
                  fontSize: 13,
                }}>
                  {m.role === 'assistant'
                    ? <MsgContent content={m.content} queryResult={m.queryResult} chartHint={m.chartHint} />
                    : m.content
                  }
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', flexShrink: 0 }}>✦</div>
                <div style={{ background: 'var(--bg3)', borderRadius: '12px 12px 12px 2px', minWidth: 60 }}><TypingDots /></div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Quick prompts — only show if 1 message (fresh) */}
          {messages.length === 1 && (
            <div style={{ padding: '6px 14px 0', display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {QUICK.map(q => (
                <button key={q} onClick={() => send(q)} style={{
                  padding: '4px 10px', borderRadius: 20,
                  border: '1px solid var(--border2)',
                  background: 'var(--bg3)', color: 'var(--text2)',
                  fontSize: 11, cursor: 'pointer',
                }}>{q}</button>
              ))}
            </div>
          )}

          {/* Input */}
          <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask anything about your data…"
              disabled={loading}
              style={{
                flex: 1, padding: '9px 13px', borderRadius: 10,
                border: '1px solid var(--border2)',
                background: 'var(--bg3)', color: 'var(--text)',
                fontSize: 13, outline: 'none',
                opacity: loading ? 0.6 : 1,
              }}
            />
            <button onClick={() => send()} disabled={loading || !input.trim()} style={{
              width: 38, height: 38, borderRadius: 10,
              background: loading || !input.trim() ? 'var(--bg3)' : 'var(--accent)',
              border: '1px solid var(--border2)',
              color: loading || !input.trim() ? 'var(--text3)' : '#fff',
              cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>↑</button>
          </div>
        </div>
      )}
    </>
  );
}
