import React,{useState,useRef,useEffect,useCallback} from 'react';
import {aiChat} from '../utils/api';

const SUGGESTED = [
  'What are the key trends in the current data?',
  'Which metric needs immediate attention?',
  'How is the attach rate performing?',
  'What is driving revenue this period?',
  'Compare this week vs last week',
];

function TypingDots(){
  return(
    <div style={{display:'flex',gap:4,alignItems:'center',padding:'10px 14px'}}>
      {[0,1,2].map(i=>(
        <div key={i} style={{width:7,height:7,borderRadius:'50%',background:'var(--accent)',
          animation:`aiDot 1.2s ease-in-out ${i*0.2}s infinite`}}/>
      ))}
    </div>
  );
}

export default function AiAssistant({activeTab, getTabData}){
  const [open,setOpen]=useState(false);
  const [messages,setMessages]=useState([
    {role:'assistant',content:"Hi! I'm your NOBL Air analytics assistant. I can analyze your dashboard data, spot trends, explain metrics, and answer any business questions. What would you like to know?"}
  ]);
  const [input,setInput]=useState('');
  const [loading,setLoading]=useState(false);
  const [pulse,setPulse]=useState(true);
  const bottomRef=useRef(null);
  const inputRef=useRef(null);

  useEffect(()=>{
    if(open){
      setPulse(false);
      setTimeout(()=>inputRef.current?.focus(),200);
    }
  },[open]);

  useEffect(()=>{
    bottomRef.current?.scrollIntoView({behavior:'smooth'});
  },[messages,loading]);

  const send=useCallback(async(text)=>{
    const msg=text||input.trim();
    if(!msg||loading) return;
    setInput('');
    const newMessages=[...messages,{role:'user',content:msg}];
    setMessages(newMessages);
    setLoading(true);
    try{
      const apiMessages=newMessages.map(m=>({role:m.role,content:m.content}));
      const {reply,error}=await aiChat(apiMessages,'',activeTab||'');
      setMessages(prev=>[...prev,{role:'assistant',content:error?`Sorry, I ran into an error: ${error}`:reply}]);
    }catch(e){
      setMessages(prev=>[...prev,{role:'assistant',content:'Sorry, I could not reach the AI service. Please try again.'}]);
    }finally{
      setLoading(false);
    }
  },[input,loading,messages,activeTab]);

  const handleKey=e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
  };

  const clearChat=()=>setMessages([
    {role:'assistant',content:"Chat cleared! What would you like to analyze?"}
  ]);

  return(
    <>
      <style>{`
        @keyframes aiDot{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}
        @keyframes aiSlideIn{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:translateX(0)}}
        @keyframes aiPulse{0%,100%{box-shadow:0 0 0 0 rgba(139,92,246,.5)}50%{box-shadow:0 0 0 10px rgba(139,92,246,0)}}
        .ai-msg-user{animation:aiSlideIn .2s ease}
        .ai-msg-assistant{animation:aiSlideIn .2s ease}
        .ai-suggest:hover{background:var(--bg4)!important;border-color:var(--accent)!important}
        .ai-send:hover{opacity:.85}
        .ai-input:focus{outline:none;border-color:var(--accent)!important}
      `}</style>

      {/* ── Floating Button ── */}
      <button onClick={()=>setOpen(o=>!o)} style={{
        position:'fixed',bottom:24,right:24,
        width:52,height:52,borderRadius:'50%',
        background:'linear-gradient(135deg,var(--accent2),var(--accent))',
        border:'none',cursor:'pointer',zIndex:9990,
        display:'flex',alignItems:'center',justifyContent:'center',
        boxShadow:'0 4px 20px rgba(139,92,246,.45)',
        animation:pulse&&!open?'aiPulse 2s ease infinite':undefined,
        transition:'transform .15s ease,box-shadow .15s ease',
        transform:open?'scale(.9)':'scale(1)',
      }}>
        {open
          ? <XIcon/>
          : <SparkleIcon/>
        }
      </button>

      {/* ── Panel ── */}
      {open&&(
        <div style={{
          position:'fixed',bottom:88,right:24,
          width:380,height:560,
          background:'var(--bg2)',
          border:'1px solid var(--border2)',
          borderRadius:16,
          display:'flex',flexDirection:'column',
          zIndex:9989,
          boxShadow:'0 8px 40px rgba(0,0,0,.4)',
          animation:'aiSlideIn .2s ease',
          overflow:'hidden',
        }}>

          {/* Header */}
          <div style={{
            padding:'14px 16px',
            background:'linear-gradient(135deg,rgba(139,92,246,.15),rgba(59,130,246,.1))',
            borderBottom:'1px solid var(--border)',
            display:'flex',alignItems:'center',justifyContent:'space-between',
            flexShrink:0,
          }}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{width:32,height:32,borderRadius:8,
                background:'linear-gradient(135deg,var(--accent2),var(--accent))',
                display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                <SparkleIcon size={16}/>
              </div>
              <div>
                <div style={{fontWeight:700,fontSize:13,fontFamily:'var(--font-head)'}}>AI Analytics Assistant</div>
                <div style={{fontSize:11,color:'var(--text3)'}}>
                  {activeTab?`Viewing: ${activeTab}`:'NOBL Air · Pilates Flo'}
                </div>
              </div>
            </div>
            <button onClick={clearChat} title="Clear chat" style={{
              background:'none',border:'none',cursor:'pointer',
              color:'var(--text3)',fontSize:11,padding:'4px 8px',
              borderRadius:6,transition:'color .15s',
            }} onMouseEnter={e=>e.target.style.color='var(--text)'}
              onMouseLeave={e=>e.target.style.color='var(--text3)'}>
              Clear
            </button>
          </div>

          {/* Messages */}
          <div style={{flex:1,overflowY:'auto',padding:'12px 14px',display:'flex',flexDirection:'column',gap:10}}>
            {messages.map((m,i)=>(
              <div key={i} className={`ai-msg-${m.role}`} style={{
                display:'flex',flexDirection:'column',
                alignItems:m.role==='user'?'flex-end':'flex-start',
              }}>
                {m.role==='assistant'&&(
                  <div style={{fontSize:10,color:'var(--text3)',marginBottom:3,paddingLeft:2,fontWeight:500}}>AI Assistant</div>
                )}
                <div style={{
                  maxWidth:'88%',
                  padding:'9px 13px',
                  borderRadius:m.role==='user'?'12px 12px 4px 12px':'12px 12px 12px 4px',
                  background:m.role==='user'
                    ?'linear-gradient(135deg,var(--accent2),var(--accent))'
                    :'var(--bg3)',
                  color:m.role==='user'?'#fff':'var(--text)',
                  fontSize:13,lineHeight:1.6,
                  border:m.role==='assistant'?'1px solid var(--border)':'none',
                  whiteSpace:'pre-wrap',wordBreak:'break-word',
                }}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading&&(
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-start'}}>
                <div style={{fontSize:10,color:'var(--text3)',marginBottom:3,paddingLeft:2,fontWeight:500}}>AI Assistant</div>
                <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'12px 12px 12px 4px'}}>
                  <TypingDots/>
                </div>
              </div>
            )}

            {/* Suggestions (only when 1 message = initial) */}
            {messages.length===1&&!loading&&(
              <div style={{marginTop:8,display:'flex',flexDirection:'column',gap:6}}>
                <div style={{fontSize:11,color:'var(--text3)',fontWeight:500,paddingLeft:2}}>Quick questions:</div>
                {SUGGESTED.map((s,i)=>(
                  <button key={i} className="ai-suggest" onClick={()=>send(s)} style={{
                    textAlign:'left',padding:'8px 12px',
                    background:'var(--bg3)',border:'1px solid var(--border)',
                    borderRadius:9,cursor:'pointer',
                    color:'var(--text2)',fontSize:12,lineHeight:1.4,
                    transition:'all .15s',
                  }}>{s}</button>
                ))}
              </div>
            )}
            <div ref={bottomRef}/>
          </div>

          {/* Input */}
          <div style={{
            padding:'10px 12px',
            borderTop:'1px solid var(--border)',
            flexShrink:0,
            background:'var(--bg2)',
          }}>
            <div style={{display:'flex',gap:8,alignItems:'flex-end'}}>
              <textarea
                ref={inputRef}
                className="ai-input"
                value={input}
                onChange={e=>setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Ask about your data… (Enter to send)"
                rows={1}
                style={{
                  flex:1,resize:'none',
                  background:'var(--bg3)',
                  border:'1px solid var(--border2)',
                  borderRadius:10,
                  padding:'9px 12px',
                  color:'var(--text)',
                  fontSize:13,
                  fontFamily:'var(--font-body)',
                  lineHeight:1.5,
                  maxHeight:100,
                  overflowY:'auto',
                }}
              />
              <button className="ai-send" onClick={()=>send()} disabled={!input.trim()||loading} style={{
                width:38,height:38,borderRadius:10,flexShrink:0,
                background:input.trim()&&!loading
                  ?'linear-gradient(135deg,var(--accent2),var(--accent))'
                  :'var(--bg4)',
                border:'none',cursor:input.trim()&&!loading?'pointer':'not-allowed',
                display:'flex',alignItems:'center',justifyContent:'center',
                transition:'all .15s',
              }}>
                <SendIcon color={input.trim()&&!loading?'#fff':'var(--text3)'}/>
              </button>
            </div>
            <div style={{fontSize:10,color:'var(--text3)',marginTop:5,textAlign:'center'}}>
              Powered by GPT-4o · Data stays on your server
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── Inline Icon components ── */
function SparkleIcon({size=20}){
  return(
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
    </svg>
  );
}
function XIcon(){
  return(
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}
function SendIcon({color='#fff'}){
  return(
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  );
}
