import React,{useMemo} from 'react';
import {fmt$,fmtNum,isCurrency,isPercent} from '../utils/api';

export default function SelectionBar({selectedRows, headers, onClear}){
  const stats=useMemo(()=>{
    if(!selectedRows?.length) return [];
    const numericCols=headers.filter(h=>{
      if(isPercent(h)) return false; // skip % cols — avg makes no sense
      return selectedRows.some(r=>{
        const v=parseFloat(r[h]);
        return !isNaN(v)&&v!==0;
      });
    });
    return numericCols.slice(0,6).map(h=>{
      const vals=selectedRows.map(r=>parseFloat(r[h])||0);
      const sum=vals.reduce((a,b)=>a+b,0);
      const avg=sum/vals.length;
      const min=Math.min(...vals);
      const max=Math.max(...vals);
      const fmt=v=>isCurrency(h)?fmt$(v):fmtNum(v);
      return {col:h,sum:fmt(sum),avg:fmt(avg),min:fmt(min),max:fmt(max),count:vals.length};
    });
  },[selectedRows,headers]);

  if(!selectedRows?.length) return null;

  return(
    <div style={{
      position:'fixed',bottom:90,left:'50%',transform:'translateX(-50%)',
      background:'var(--bg2)',border:'1px solid var(--border2)',
      borderRadius:12,padding:'10px 16px',
      display:'flex',alignItems:'center',gap:16,
      boxShadow:'0 8px 32px rgba(0,0,0,.35)',
      zIndex:9980,
      animation:'fadein .15s ease',
      maxWidth:'90vw',overflowX:'auto',
      flexWrap:'wrap',
    }}>
      <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}}>
        <div style={{
          background:'var(--accent)',color:'#fff',
          borderRadius:6,padding:'2px 9px',
          fontSize:12,fontWeight:700,
        }}>
          {selectedRows.length} row{selectedRows.length!==1?'s':''} selected
        </div>
        <button onClick={onClear} style={{
          background:'none',border:'1px solid var(--border2)',
          borderRadius:6,padding:'2px 9px',
          fontSize:11,color:'var(--text3)',cursor:'pointer',
        }}>Clear</button>
      </div>

      {stats.length>0&&(
        <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
          {stats.map(s=>(
            <div key={s.col} style={{
              background:'var(--bg3)',border:'1px solid var(--border)',
              borderRadius:8,padding:'6px 12px',minWidth:110,flexShrink:0,
            }}>
              <div style={{fontSize:10,color:'var(--text3)',fontWeight:600,textTransform:'uppercase',letterSpacing:'.5px',marginBottom:4,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:120}}>{s.col}</div>
              <div style={{display:'flex',gap:10,fontSize:12,flexWrap:'wrap'}}>
                <StatItem label="Sum" value={s.sum} color="var(--accent)"/>
                <StatItem label="Avg" value={s.avg} color="var(--teal)"/>
                <StatItem label="Min" value={s.min} color="var(--text2)"/>
                <StatItem label="Max" value={s.max} color="var(--warn)"/>
              </div>
            </div>
          ))}
        </div>
      )}

      {stats.length===0&&(
        <div style={{fontSize:12,color:'var(--text3)'}}>No numeric columns in selection</div>
      )}
    </div>
  );
}

function StatItem({label,value,color}){
  return(
    <span style={{display:'flex',flexDirection:'column',alignItems:'center',minWidth:36}}>
      <span style={{fontSize:9,color:'var(--text3)',fontWeight:600,letterSpacing:'.4px'}}>{label}</span>
      <span style={{fontFamily:'var(--font-mono)',fontWeight:600,color,fontSize:12}}>{value}</span>
    </span>
  );
}
