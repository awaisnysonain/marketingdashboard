import React,{useState,useRef,useEffect} from 'react';
import {Icons} from './Icons';

export default function TopBar({auth,onRefresh,refreshing,theme,onToggleTheme,
  spreadsheetTitle,driveSheets,onSelectSpreadsheet,switching}){

  const [open,setOpen]=useState(false);
  const dropRef=useRef(null);
  const fresh=auth?.lastFetched&&(Date.now()-new Date(auth.lastFetched).getTime())<6*60*60*1000;

  // Close dropdown on outside click
  useEffect(()=>{
    const handler=(e)=>{if(dropRef.current&&!dropRef.current.contains(e.target)) setOpen(false);};
    document.addEventListener('mousedown',handler);
    return()=>document.removeEventListener('mousedown',handler);
  },[]);

  const iconBtn={
    display:'flex',alignItems:'center',gap:5,
    background:'none',border:'1px solid var(--border2)',
    color:'var(--text2)',borderRadius:'var(--radius)',
    padding:'5px 11px',cursor:'pointer',transition:'all .15s',
    fontSize:12,fontWeight:500,fontFamily:'var(--font-body)',
  };

  const formatTime=(iso)=>new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});

  return(
    <header style={{
      display:'flex',alignItems:'center',justifyContent:'space-between',
      padding:'0 20px',height:'var(--topbar-h)',
      background:'var(--bg2)',
      borderBottom:'1px solid var(--border)',
      position:'sticky',top:0,zIndex:300,
      gap:12,
    }}>

      {/* ── Left: Logo ─────────────────────────────────────── */}
      <div style={{display:'flex',alignItems:'center',gap:9,flexShrink:0}}>
        <div style={{
          width:26,height:26,
          background:'linear-gradient(135deg,var(--accent),var(--accent2))',
          borderRadius:6,display:'flex',alignItems:'center',justifyContent:'center',
          fontFamily:'var(--font-head)',fontWeight:800,fontSize:12,color:'#fff',
        }}>N</div>
        <span style={{fontFamily:'var(--font-head)',fontSize:14,fontWeight:800,letterSpacing:'-0.2px',whiteSpace:'nowrap'}}>NOBL Air</span>
      </div>

      {/* ── Center: Spreadsheet selector ───────────────────── */}
      <div ref={dropRef} style={{position:'relative',flex:'0 1 340px',minWidth:0}}>
        <button onClick={()=>setOpen(o=>!o)}
          disabled={switching}
          style={{
            display:'flex',alignItems:'center',gap:8,width:'100%',
            background:'var(--bg3)',border:'1px solid var(--border2)',
            color:'var(--text)',borderRadius:'var(--radius)',
            padding:'6px 12px',cursor:'pointer',transition:'all .15s',
            fontSize:13,fontWeight:500,fontFamily:'var(--font-body)',
            opacity:switching?.7:1,
          }}
          onMouseEnter={e=>{if(!switching){e.currentTarget.style.borderColor='var(--accent)';e.currentTarget.style.boxShadow='0 0 0 2px var(--accent-dim)';}}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border2)';e.currentTarget.style.boxShadow='none';}}>
          <Icons.FileSpreadsheet size={14} style={{flexShrink:0,color:'var(--teal)'}}/>
          <span style={{flex:1,textAlign:'left',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontSize:12.5}}>
            {switching?'Loading…':spreadsheetTitle||'Select a spreadsheet'}
          </span>
          <Icons.ChevronRight size={12} style={{flexShrink:0,transform:open?'rotate(90deg)':'none',transition:'transform .15s',opacity:.5}}/>
        </button>

        {open&&(
          <div style={{
            position:'absolute',top:'calc(100% + 6px)',left:0,right:0,
            background:'var(--bg2)',border:'1px solid var(--border2)',
            borderRadius:10,overflow:'hidden',
            boxShadow:'var(--shadow)',zIndex:400,
            maxHeight:320,overflowY:'auto',
          }}>
            {!driveSheets||driveSheets.error?(
              <div style={{padding:'14px 16px'}}>
                {driveSheets?.needsReauth?(
                  <div style={{fontSize:12,color:'var(--text3)',lineHeight:1.6}}>
                    <p style={{marginBottom:8,color:'var(--warn)'}}>Extra permission needed to list your sheets.</p>
                    <a href="/auth/login" style={{color:'var(--accent)',fontSize:12}}>Sign in again to grant access</a>
                  </div>
                ):(
                  <p style={{fontSize:12,color:'var(--text3)'}}>Could not load sheets. Check your connection.</p>
                )}
              </div>
            ):driveSheets.length===0?(
              <div style={{padding:'14px 16px',fontSize:12,color:'var(--text3)'}}>No spreadsheets found in your Drive.</div>
            ):(
              <>
                <div style={{padding:'8px 12px 4px',fontSize:10,fontWeight:700,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'1px',borderBottom:'1px solid var(--border)'}}>Your Google Sheets</div>
                {driveSheets.map(sheet=>{
                  const isActive=sheet.id===auth?.spreadsheetId;
                  return(
                    <button key={sheet.id}
                      onClick={()=>{onSelectSpreadsheet(sheet.id,sheet.name);setOpen(false);}}
                      style={{
                        display:'flex',alignItems:'center',gap:10,width:'100%',
                        padding:'9px 14px',background:isActive?'var(--accent-dim)':'transparent',
                        border:'none',color:isActive?'var(--accent)':'var(--text)',
                        fontSize:13,textAlign:'left',cursor:'pointer',transition:'background .1s',
                        fontFamily:'var(--font-body)',
                      }}
                      onMouseEnter={e=>{if(!isActive)e.currentTarget.style.background='var(--bg4)';}}
                      onMouseLeave={e=>{if(!isActive)e.currentTarget.style.background='transparent';}}>
                      <Icons.FileSpreadsheet size={14} style={{flexShrink:0,color:isActive?'var(--accent)':'var(--teal)',opacity:.8}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontWeight:isActive?600:400,fontSize:13}}>{sheet.name}</div>
                        {sheet.modifiedTime&&(
                          <div style={{fontSize:10,color:'var(--text3)',marginTop:1}}>
                            Modified {formatTime(sheet.modifiedTime)}
                          </div>
                        )}
                      </div>
                      {isActive&&<span style={{width:6,height:6,borderRadius:'50%',background:'var(--accent)',flexShrink:0}}/>}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Right: Status + Actions ─────────────────────────── */}
      <div style={{display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
        {/* Last updated */}
        <div style={{display:'flex',alignItems:'center',gap:5,marginRight:4}}>
          <span style={{
            width:6,height:6,borderRadius:'50%',display:'inline-block',flexShrink:0,
            background:!auth?.lastFetched?'var(--text3)':fresh?'var(--success)':'var(--warn)',
            animation:fresh?'pulse-ring 2.5s infinite':'none',
          }}/>
          <span style={{fontSize:11,color:'var(--text3)',fontFamily:'var(--font-mono)',whiteSpace:'nowrap'}}>
            {auth?.lastFetched?formatTime(auth.lastFetched):'Never'}
          </span>
        </div>

        {/* Theme toggle */}
        <button onClick={onToggleTheme}
          style={iconBtn}
          onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--accent)';e.currentTarget.style.color='var(--accent)';}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border2)';e.currentTarget.style.color='var(--text2)';}}>
          {theme==='dark'?<Icons.Sun size={13}/>:<Icons.Moon size={13}/>}
          <span>{theme==='dark'?'Light':'Dark'}</span>
        </button>

        {/* Refresh */}
        <button onClick={onRefresh} disabled={refreshing}
          style={{...iconBtn,background:'var(--accent)',borderColor:'transparent',color:'#fff',opacity:refreshing?.6:1}}
          onMouseEnter={e=>{if(!refreshing)e.currentTarget.style.filter='brightness(1.1)';}}
          onMouseLeave={e=>e.currentTarget.style.filter=''}>
          <Icons.RefreshCw size={13} style={{animation:refreshing?'spin .7s linear infinite':'none'}}/>
          <span>{refreshing?'Refreshing…':'Refresh'}</span>
        </button>

        {/* Sign out */}
        <button
          onClick={()=>fetch('/auth/logout',{method:'POST'}).then(()=>window.location.reload())}
          style={iconBtn}
          onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--danger)';e.currentTarget.style.color='var(--danger)';}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border2)';e.currentTarget.style.color='var(--text2)';}}>
          <Icons.LogOut size={13}/>
          <span>Out</span>
        </button>
      </div>
    </header>
  );
}
