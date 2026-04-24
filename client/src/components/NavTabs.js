import React from 'react';
export default function NavTabs({tabs,active,onChange}){
  return(
    <nav style={{display:'flex',padding:'0 28px',background:'var(--bg2)',borderBottom:'1px solid var(--border)',overflowX:'auto'}}>
      {tabs.map(t=>(
        <button key={t.id} onClick={()=>onChange(t.id)}
          style={{padding:'12px 18px',fontSize:13,fontWeight:500,color:active===t.id?'var(--accent)':'var(--text2)',background:'none',border:'none',borderBottom:`2px solid ${active===t.id?'var(--accent)':'transparent'}`,cursor:'pointer',transition:'all .15s',whiteSpace:'nowrap'}}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
