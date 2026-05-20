import React,{useState,useEffect} from 'react';
import {getTabs,getTab} from '../utils/api';
import DataTable from '../components/DataTable';
import PageIntro from '../components/PageIntro';

export default function RawTablePage(){
  const [tabs,setTabs]=useState([]);
  const [selected,setSelected]=useState('');
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);

  useEffect(()=>{
    getTabs().then(t=>{setTabs(t);if(t.length) setSelected(t[0]);}).catch(()=>{});
  },[]);

  useEffect(()=>{
    if(!selected) return;
    setLoading(true);setError(null);setData(null);
    getTab(selected).then(setData).catch(e=>setError(String(e))).finally(()=>setLoading(false));
  },[selected]);

  return(
    <div>
      <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:20,flexWrap:'wrap'}}>
        <PageIntro title="Raw tables" desc="Browse any sheet tab as a searchable table." />
        <select value={selected} onChange={e=>setSelected(e.target.value)}
          style={{background:'var(--bg3)',border:'1px solid var(--border2)',color:'var(--text)',borderRadius:8,padding:'8px 12px',fontSize:13,outline:'none',minWidth:220}}>
          {tabs.map(t=><option key={t} value={t}>{t}</option>)}
        </select>
        {data&&<span style={{fontSize:12,color:'var(--text3)',marginLeft:'auto'}}>{data.rows?.length??0} rows · Last fetched: {data.lastFetched?new Date(data.lastFetched).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—'}</span>}
      </div>

      {loading&&<div style={{padding:40,textAlign:'center',color:'var(--text3)'}}>Loading "{selected}"…</div>}
      {error&&<div style={{padding:24,background:'rgba(240,82,82,.1)',border:'1px solid var(--danger)',borderRadius:10,color:'var(--danger)',fontSize:13}}><strong>Error:</strong> {error}</div>}

      {data&&!loading&&(
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'20px 22px'}}>
          <DataTable
            tab={selected}
            headers={data.headers||[]}
            rows={data.rows||[]}
            maxHeight="620px"
            searchable={true}
          />
        </div>
      )}
    </div>
  );
}
