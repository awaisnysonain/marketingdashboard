import React,{useState,useCallback} from 'react';
import {setHighlight,removeHighlight} from '../utils/api';
import {fmtCell} from '../utils/api';
import AnnotationModal from './AnnotationModal';

const HL_COLORS=['yellow','green','red','blue',null];
const HL_BG={yellow:'var(--hl-yellow)',green:'var(--hl-green)',red:'var(--hl-red)',blue:'var(--hl-blue)'};
const ANN_COLOR={yellow:'#fbbf24',blue:'#4f8ef7',green:'#22c55e',red:'#f05252'};

export default function DataTable({tab,headers,rows,onRowsChange,maxHeight='520px',searchable=true}){
  const [search,setSearch]=useState('');
  const [modal,setModal]=useState(null);
  const [localRows,setLocalRows]=useState(rows);

  React.useEffect(()=>setLocalRows(rows),[rows]);

  const filtered=search
    ? localRows.filter(r=>Object.values(r).some(v=>String(v).toLowerCase().includes(search.toLowerCase())))
    : localRows;

  const cycleHighlight=useCallback(async(row)=>{
    const curr=row._highlighted;
    const idx=HL_COLORS.indexOf(curr);
    const next=HL_COLORS[(idx+1)%HL_COLORS.length];
    if(next===null){
      await removeHighlight({tab,row_key:row._rowKey});
    } else {
      await setHighlight({tab,row_key:row._rowKey,color:next});
    }
    setLocalRows(prev=>prev.map(r=>r._rowKey===row._rowKey?{...r,_highlighted:next}:r));
    onRowsChange&&onRowsChange();
  },[tab,onRowsChange]);

  function openAnnotate(e,row){
    e.preventDefault();
    const existing=row._annotations?.[0]||null;
    setModal({tab,rowKey:row._rowKey,metric:'',existing});
  }

  function onAnnotationSaved(row,result){
    setLocalRows(prev=>prev.map(r=>{
      if(r._rowKey!==row._rowKey) return r;
      if(!result) return {...r,_annotations:[]};
      const anns=(r._annotations||[]).filter(a=>a.id!==result.id);
      return {...r,_annotations:[result,...anns]};
    }));
  }

  const visibleHeaders=headers.filter(h=>!h.startsWith('_'));

  return(
    <div>
      {searchable && (
        <div style={{marginBottom:12,display:'flex',alignItems:'center',gap:10}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…"
            style={{background:'var(--bg4)',border:'1px solid var(--border2)',borderRadius:8,color:'var(--text)',padding:'8px 12px',fontSize:13,width:260,outline:'none'}}/>
          {search && <button onClick={()=>setSearch('')} style={{background:'none',border:'none',color:'var(--text3)',fontSize:18,cursor:'pointer'}}>×</button>}
          <span style={{fontSize:12,color:'var(--text3)',marginLeft:'auto'}}>{filtered.length} rows</span>
        </div>
      )}
      <div style={{overflowX:'auto',overflowY:'auto',maxHeight,borderRadius:'var(--radius)',border:'1px solid var(--border)'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
          <thead>
            <tr style={{background:'var(--bg4)',position:'sticky',top:0,zIndex:1}}>
              <th style={{width:28,padding:'10px 6px',borderBottom:'1px solid var(--border2)'}}/>
              {visibleHeaders.map(h=>(
                <th key={h} style={{padding:'10px 12px',textAlign:'left',fontWeight:500,color:'var(--text2)',whiteSpace:'nowrap',borderBottom:'1px solid var(--border2)',fontSize:12}}>
                  {h}
                </th>
              ))}
              <th style={{width:28,borderBottom:'1px solid var(--border2)'}}/>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row,i)=>{
              const bg=row._highlighted ? HL_BG[row._highlighted] : i%2===1?'rgba(255,255,255,0.015)':'transparent';
              const hasAnn=(row._annotations||[]).length>0;
              return(
                <tr key={row._rowKey||i}
                  style={{background:bg,transition:'background .1s'}}
                  onContextMenu={e=>openAnnotate(e,row)}
                  onMouseEnter={e=>e.currentTarget.style.background=row._highlighted?HL_BG[row._highlighted]:'rgba(255,255,255,0.04)'}
                  onMouseLeave={e=>e.currentTarget.style.background=bg}>
                  <td style={{padding:'0 6px',textAlign:'center',cursor:'pointer'}} onClick={()=>cycleHighlight(row)}>
                    <div style={{width:8,height:8,borderRadius:'50%',background:row._highlighted?HL_BG[row._highlighted].replace('var(--hl-','').replace(')',''):HL_BG.yellow,border:`1px solid ${row._highlighted?'currentColor':'var(--border2)'}`,margin:'0 auto',opacity:row._highlighted?1:0.3}}/>
                  </td>
                  {visibleHeaders.map(h=>(
                    <td key={h} style={{padding:'9px 12px',borderBottom:'1px solid rgba(255,255,255,0.04)',color:String(row[h]).includes('TOTAL')||String(row[h]).includes('Total')?'var(--text)':'var(--text)',fontFamily:typeof row[h]==='number'||(!isNaN(parseFloat(row[h]))&&row[h]!=='')?'var(--font-mono)':'var(--font-body)',whiteSpace:'nowrap'}}>
                      {fmtCell(row[h],h)}
                    </td>
                  ))}
                  <td style={{padding:'0 8px',textAlign:'center',cursor:'pointer'}} onClick={e=>openAnnotate(e,row)}>
                    {hasAnn ? (
                      <div style={{width:8,height:8,borderRadius:'50%',background:ANN_COLOR[row._annotations[0].color]||ANN_COLOR.yellow,margin:'0 auto'}} title={row._annotations[0].note}/>
                    ) : (
                      <div style={{width:16,height:16,borderRadius:4,border:'1px dashed var(--border2)',margin:'0 auto',opacity:0.4,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,color:'var(--text3)'}}>+</div>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length===0 && (
              <tr><td colSpan={visibleHeaders.length+2} style={{padding:32,textAlign:'center',color:'var(--text3)'}}>No data</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{fontSize:11,color:'var(--text3)',marginTop:6}}>Left-click row dot to highlight · Right-click row to annotate</div>
      {modal && (
        <AnnotationModal
          tab={modal.tab} rowKey={modal.rowKey} metric={modal.metric} existing={modal.existing}
          onClose={()=>setModal(null)}
          onSaved={(result)=>{
            const row=filtered.find(r=>r._rowKey===modal.rowKey);
            if(row) onAnnotationSaved(row,result);
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
