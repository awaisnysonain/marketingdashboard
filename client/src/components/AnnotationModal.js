import React,{useState,useEffect} from 'react';
import {addAnnotation,updateAnnotation,deleteAnnotation} from '../utils/api';

const COLORS=['yellow','blue','green','red'];
const COLOR_MAP={yellow:'#fbbf24',blue:'#4f8ef7',green:'#22c55e',red:'#f05252'};

export default function AnnotationModal({tab,rowKey,metric,existing,onClose,onSaved}){
  const [note,setNote]=useState(existing?.note||'');
  const [color,setColor]=useState(existing?.color||'yellow');
  const [saving,setSaving]=useState(false);

  useEffect(()=>{
    function onKey(e){ if(e.key==='Escape') onClose(); }
    document.addEventListener('keydown',onKey);
    return()=>document.removeEventListener('keydown',onKey);
  },[onClose]);

  async function save(){
    if(!note.trim()) return;
    setSaving(true);
    try{
      let result;
      if(existing) result=await updateAnnotation(existing.id,{note,color});
      else result=await addAnnotation({tab,row_key:rowKey,metric,note,color});
      onSaved(result);
      onClose();
    }catch(e){console.error(e);}
    finally{setSaving(false);}
  }

  async function del(){
    if(!existing) return;
    await deleteAnnotation(existing.id);
    onSaved(null);
    onClose();
  }

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.65)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000}}
      onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:'var(--radius-lg)',padding:24,width:400,maxWidth:'90vw',boxShadow:'0 24px 64px rgba(0,0,0,.6)'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
          <div style={{fontFamily:'var(--font-head)',fontSize:15,fontWeight:700}}>
            {existing ? 'Edit note' : 'Add note'}
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',color:'var(--text3)',fontSize:18,lineHeight:1}}>×</button>
        </div>
        <div style={{fontSize:12,color:'var(--text3)',marginBottom:12,fontFamily:'var(--font-mono)'}}>{rowKey}{metric?` › ${metric}`:''}</div>
        <textarea
          value={note}
          onChange={e=>setNote(e.target.value)}
          placeholder="Add a note…"
          autoFocus
          style={{width:'100%',background:'var(--bg4)',border:'1px solid var(--border2)',borderRadius:8,color:'var(--text)',padding:'10px 12px',fontSize:13,resize:'vertical',minHeight:80,outline:'none',lineHeight:1.5}}
        />
        <div style={{display:'flex',gap:8,margin:'12px 0'}}>
          {COLORS.map(c=>(
            <button key={c} onClick={()=>setColor(c)}
              style={{width:24,height:24,borderRadius:'50%',background:COLOR_MAP[c],border:color===c?`2px solid #fff`:'2px solid transparent',cursor:'pointer',transition:'transform .1s',transform:color===c?'scale(1.2)':'scale(1)'}}
              title={c}/>
          ))}
          <span style={{fontSize:12,color:'var(--text3)',marginLeft:4,alignSelf:'center'}}>Color tag</span>
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:16}}>
          {existing && <button onClick={del} style={{background:'none',border:'1px solid var(--danger)',color:'var(--danger)',borderRadius:8,padding:'8px 14px',fontSize:13}}>Delete</button>}
          <button onClick={onClose} style={{background:'none',border:'1px solid var(--border2)',color:'var(--text2)',borderRadius:8,padding:'8px 14px',fontSize:13}}>Cancel</button>
          <button onClick={save} disabled={saving||!note.trim()}
            style={{background:'var(--accent)',border:'none',color:'#fff',borderRadius:8,padding:'8px 18px',fontSize:13,fontWeight:500,opacity:saving||!note.trim()?0.5:1}}>
            {saving?'Saving…':'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
