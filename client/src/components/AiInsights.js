import React,{useState,useEffect,useRef} from 'react';
import {aiInsights} from '../utils/api';

const TYPE_STYLE={
  positive:{color:'var(--success)',bg:'rgba(16,185,129,.1)',border:'rgba(16,185,129,.25)',icon:'↑'},
  negative:{color:'var(--danger)', bg:'rgba(239,68,68,.1)', border:'rgba(239,68,68,.25)', icon:'↓'},
  warning: {color:'var(--warn)',   bg:'rgba(245,158,11,.1)',border:'rgba(245,158,11,.25)',icon:'⚠'},
  neutral: {color:'var(--accent)', bg:'var(--accent-dim)',  border:'rgba(59,130,246,.25)',icon:'→'},
};

export default function AiInsights({tab, headers, rows}){
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(false);
  const [open,setOpen]=useState(false);
  const [error,setError]=useState(null);
  const fetched=useRef(false);

  useEffect(()=>{ fetched.current=false; setData(null); setOpen(false); setError(null); },[tab]);

  async function load(){
    if(fetched.current||loading) return;
    fetched.current=true;
    setLoading(true);
    setOpen(true);
    try{
      const res=await aiInsights(tab, headers, rows);
      if(res.error) setError(res.error);
      else setData(res);
    }catch(e){ setError('Could not load insights'); }
    finally{ setLoading(false); }
  }

  return(
    <div style={{marginBottom:20}}>
      {!open&&(
        <button onClick={load} style={{
          display:'inline-flex',alignItems:'center',gap:8,
          padding:'8px 16px',
          background:'linear-gradient(135deg,rgba(139,92,246,.12),rgba(59,130,246,.12))',
          border:'1px solid rgba(139,92,246,.3)',
          borderRadius:9,cursor:'pointer',
          color:'var(--accent2)',fontSize:13,fontWeight:600,
          transition:'all .15s',
        }}
          onMouseEnter={e=>{e.currentTarget.style.background='linear-gradient(135deg,rgba(139,92,246,.2),rgba(59,130,246,.2))';}}
          onMouseLeave={e=>{e.currentTarget.style.background='linear-gradient(135deg,rgba(139,92,246,.12),rgba(59,130,246,.12))';}}
        >
          <SparkleIcon/> AI Insights for this tab
        </button>
      )}

      {open&&(
        <div style={{
          background:'var(--bg3)',
          border:'1px solid var(--border2)',
          borderRadius:12,
          padding:'16px 18px',
          animation:'fadein .25s ease',
        }}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <SparkleIcon color="var(--accent2)"/>
              <span style={{fontWeight:700,fontSize:13,fontFamily:'var(--font-head)'}}>AI Insights — {tab}</span>
            </div>
            <button onClick={()=>{setOpen(false);fetched.current=false;setData(null);}} style={{
              background:'none',border:'none',cursor:'pointer',
              color:'var(--text3)',fontSize:12,padding:'2px 8px',borderRadius:6,
            }}>✕</button>
          </div>

          {loading&&(
            <div style={{display:'flex',gap:10,alignItems:'center',color:'var(--text3)',fontSize:13,padding:'8px 0'}}>
              <div style={{width:16,height:16,border:'2px solid var(--border2)',borderTopColor:'var(--accent2)',borderRadius:'50%',animation:'spin .7s linear infinite'}}/>
              Analyzing {rows?.length} rows with GPT-4o…
            </div>
          )}

          {error&&<div style={{color:'var(--danger)',fontSize:13}}>{error}</div>}

          {data&&(
            <>
              {data.summary&&(
                <div style={{
                  fontSize:13,color:'var(--text2)',
                  borderLeft:'3px solid var(--accent2)',
                  paddingLeft:12,marginBottom:14,lineHeight:1.6,
                  fontStyle:'italic',
                }}>
                  {data.summary}
                </div>
              )}
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))',gap:10}}>
                {(data.insights||[]).map((ins,i)=>{
                  const s=TYPE_STYLE[ins.type]||TYPE_STYLE.neutral;
                  return(
                    <div key={i} style={{
                      background:s.bg,border:`1px solid ${s.border}`,
                      borderRadius:9,padding:'11px 14px',
                    }}>
                      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:5}}>
                        <span style={{color:s.color,fontWeight:700,fontSize:14}}>{s.icon}</span>
                        <span style={{fontWeight:600,fontSize:12,color:s.color}}>{ins.title}</span>
                      </div>
                      <div style={{fontSize:12,color:'var(--text2)',lineHeight:1.6}}>{ins.text}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SparkleIcon({color='var(--accent2)',size=14}){
  return(
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
    </svg>
  );
}
