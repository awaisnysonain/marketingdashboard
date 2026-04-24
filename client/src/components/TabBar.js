import React,{useRef,useEffect,useState} from 'react';
import {sheetIcon} from './Icons';
import {Icons} from './Icons';

export default function TabBar({tabs,active,onChange}){
  const scrollRef=useRef(null);
  const activeRef=useRef(null);
  const [canScrollLeft,setCanScrollLeft]=useState(false);
  const [canScrollRight,setCanScrollRight]=useState(false);

  const checkScroll=()=>{
    const el=scrollRef.current;
    if(!el) return;
    setCanScrollLeft(el.scrollLeft>4);
    setCanScrollRight(el.scrollLeft+el.clientWidth<el.scrollWidth-4);
  };

  useEffect(()=>{
    checkScroll();
    const el=scrollRef.current;
    if(el) el.addEventListener('scroll',checkScroll,{passive:true});
    return()=>{if(el) el.removeEventListener('scroll',checkScroll);};
  },[tabs]);

  // Scroll active tab into view
  useEffect(()=>{
    if(activeRef.current){
      activeRef.current.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
    }
  },[active]);

  const scroll=(dir)=>{
    const el=scrollRef.current;
    if(el) el.scrollBy({left:dir*200,behavior:'smooth'});
  };

  return(
    <div style={{
      display:'flex',alignItems:'stretch',
      background:'var(--bg2)',
      borderBottom:'1px solid var(--border)',
      position:'sticky',top:'var(--topbar-h)',
      zIndex:100,
      boxShadow:'0 1px 0 var(--border)',
    }}>
      {/* Left arrow */}
      <button onClick={()=>scroll(-1)} disabled={!canScrollLeft}
        style={{
          flexShrink:0,width:36,
          background:'none',border:'none',borderRight:'1px solid var(--border)',
          color:canScrollLeft?'var(--text2)':'var(--text3)',
          cursor:canScrollLeft?'pointer':'default',
          display:'flex',alignItems:'center',justifyContent:'center',
          transition:'color .15s',
        }}>
        <Icons.ChevronLeft size={14}/>
      </button>

      {/* Tabs scroll area */}
      <div ref={scrollRef} style={{
        display:'flex',alignItems:'stretch',
        overflowX:'auto',flex:1,
        scrollbarWidth:'none',msOverflowStyle:'none',
      }}
        className="hide-scrollbar">
        {tabs.map(tab=>{
          const IcComp=sheetIcon(tab);
          const isActive=active===tab;
          return(
            <button
              key={tab}
              ref={isActive?activeRef:null}
              onClick={()=>onChange(tab)}
              style={{
                display:'inline-flex',alignItems:'center',gap:7,
                padding:'0 18px',
                flexShrink:0,
                background:'none',border:'none',
                borderBottom:`2px solid ${isActive?'var(--accent)':'transparent'}`,
                color:isActive?'var(--accent)':'var(--text2)',
                fontSize:13,fontWeight:isActive?600:400,
                cursor:'pointer',
                whiteSpace:'nowrap',
                transition:'color .15s, border-color .15s',
                height:42,
                fontFamily:'var(--font-body)',
              }}
              onMouseEnter={e=>{if(!isActive){e.currentTarget.style.color='var(--text)';e.currentTarget.style.background='var(--bg4)';}}}
              onMouseLeave={e=>{if(!isActive){e.currentTarget.style.color='var(--text2)';e.currentTarget.style.background='none';}}}>
              <IcComp size={13} style={{opacity:isActive?1:.7}}/>
              {tab}
            </button>
          );
        })}
      </div>

      {/* Right arrow */}
      <button onClick={()=>scroll(1)} disabled={!canScrollRight}
        style={{
          flexShrink:0,width:36,
          background:'none',border:'none',borderLeft:'1px solid var(--border)',
          color:canScrollRight?'var(--text2)':'var(--text3)',
          cursor:canScrollRight?'pointer':'default',
          display:'flex',alignItems:'center',justifyContent:'center',
          transition:'color .15s',
        }}>
        <Icons.ChevronRight size={14}/>
      </button>
    </div>
  );
}
