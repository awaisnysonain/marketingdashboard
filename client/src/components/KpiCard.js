import React from 'react';
const COLORS={blue:'var(--accent)',purple:'var(--accent2)',teal:'var(--teal)',green:'var(--success)',warn:'var(--warn)',danger:'var(--danger)'};
export default function KpiCard({label,value,sub,color='blue',onClick}){
  return(
    <div onClick={onClick} style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'16px 18px',position:'relative',overflow:'hidden',cursor:onClick?'pointer':'default',transition:'border-color .15s'}}
      onMouseEnter={e=>onClick&&(e.currentTarget.style.borderColor='var(--border2)')}
      onMouseLeave={e=>onClick&&(e.currentTarget.style.borderColor='var(--border)')}>
      <div style={{position:'absolute',top:0,left:0,right:0,height:2,background:COLORS[color]||color,borderRadius:'2px 2px 0 0'}}/>
      <div style={{fontSize:11,fontWeight:500,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.6px',marginBottom:8}}>{label}</div>
      <div style={{fontFamily:'var(--font-head)',fontSize:22,fontWeight:700,lineHeight:1.1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{value??'—'}</div>
      {sub && <div style={{fontSize:11,color:'var(--text3)',marginTop:5,fontFamily:'var(--font-mono)'}}>{sub}</div>}
    </div>
  );
}
