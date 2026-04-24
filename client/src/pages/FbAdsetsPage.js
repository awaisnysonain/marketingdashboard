import React,{useState,useEffect} from 'react';
import {getTab,fmtPct,fmtNum,fmt$} from '../utils/api';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,ResponsiveContainer,Cell} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};
const COLORS=['#4f8ef7','#7b5cf5','#2dd4bf','#4ade80','#f59e0b','#f87171','#a78bfa','#fb923c','#34d399','#60a5fa'];

export default function FbAdsetsPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);
  const [sortCol,setSortCol]=useState('Orders');
  const [sortDir,setSortDir]=useState(-1);
  const [search,setSearch]=useState('');
  const [campaign,setCampaign]=useState('All');

  useEffect(()=>{
    getTab('FB Adsets').then(d=>setRows((d.rows||[]).filter(r=>r['Adset Name']||r['Campaign Name']))).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  const totalRow=rows.find(r=>String(r['Adset Name']||'').toUpperCase().includes('TOTAL'));
  const dataRows=rows.filter(r=>!String(r['Adset Name']||'').toUpperCase().includes('TOTAL')&&r['Adset Name']);

  const campaigns=['All',...new Set(dataRows.map(r=>String(r['Campaign Name']||'')).filter(Boolean))];
  const byCampaign=campaign==='All'?dataRows:dataRows.filter(r=>String(r['Campaign Name']||'')===campaign);
  const filtered=byCampaign.filter(r=>!search||String(r['Adset Name']||'').toLowerCase().includes(search.toLowerCase())||String(r['Campaign Name']||'').toLowerCase().includes(search.toLowerCase()));
  const sorted=[...filtered].sort((a,b)=>((+b[sortCol]||0)-(+a[sortCol]||0))*sortDir);

  const top8=sorted.slice(0,8);
  const chartData=top8.map((r,i)=>({
    name:String(r['Adset Name']||'').slice(0,18),
    orders:+r['Orders']||0,
    air:+r['Air Orders']||0,
    attach:(+r['Attach Rate']||0)*100,
    color:COLORS[i%COLORS.length],
  }));

  const kpis=totalRow?[
    {label:'Total Adsets',  value:fmtNum(dataRows.length),            color:'var(--accent)'},
    {label:'Total Orders',  value:fmtNum(totalRow['Orders']),          color:'var(--accent2)'},
    {label:'Air Orders',    value:fmtNum(totalRow['Air Orders']),       color:'var(--teal)'},
    {label:'Attach Rate',   value:fmtPct(totalRow['Attach Rate']),      color:'var(--success)'},
    {label:'Revenue',       value:fmt$(totalRow['Order Revenue']),      color:'var(--warn)'},
  ]:[];

  function handleSort(col){
    if(sortCol===col) setSortDir(d=>-d);
    else{setSortCol(col);setSortDir(-1);}
  }

  const COLS=['Adset Name','Campaign Name','Orders','Air Orders','Attach Rate','New Subs','Sub TTP%','Order Revenue'];

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageHead title="FB Adsets" desc="Facebook adset performance — drill down from campaign level"/>

      {kpis.length>0&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))',gap:14}}>
          {kpis.map(k=>(
            <div key={k.label} style={{...CARD,position:'relative',overflow:'hidden'}}>
              <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:k.color,borderRadius:'3px 3px 0 0'}}/>
              <div style={{fontSize:11,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.7px',marginBottom:8}}>{k.label}</div>
              <div style={{...TH,fontSize:20,fontWeight:800}}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="Top 8 Adsets by Orders">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chartData} layout="vertical" barSize={14}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis dataKey="name" type="category" tick={{fontSize:9,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={110}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="air" name="Air Orders" radius={[0,4,4,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Top 8 Adsets by Attach Rate">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={[...chartData].sort((a,b)=>b.attach-a.attach)} layout="vertical" barSize={14}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%"/>
                <YAxis dataKey="name" type="category" tick={{fontSize:9,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={110}/>
                <Tooltip formatter={v=>`${v.toFixed(1)}%`} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="attach" name="Attach %" radius={[0,4,4,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title={`All Adsets (${dataRows.length})`}>
        <div style={{display:'flex',gap:10,marginBottom:10,flexWrap:'wrap',alignItems:'center'}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search adsets…"
            style={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,padding:'7px 14px',color:'var(--text)',fontSize:13,width:220,outline:'none'}}/>
          <select value={campaign} onChange={e=>setCampaign(e.target.value)}
            style={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,padding:'7px 12px',color:'var(--text)',fontSize:12,outline:'none',maxWidth:260}}>
            {campaigns.map(c=><option key={c} value={c}>{c==='All'?'All Campaigns':c.slice(0,40)}</option>)}
          </select>
          <span style={{fontSize:12,color:'var(--text3)'}}>{sorted.length} adsets</span>
        </div>
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <div style={{overflowX:'auto',maxHeight:500,overflowY:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead style={{position:'sticky',top:0,zIndex:1}}>
                <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                  {COLS.map((h,i)=>(
                    <th key={h} onClick={i>1?()=>handleSort(h):undefined}
                      style={{padding:'10px 12px',textAlign:i<2?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:11,whiteSpace:'nowrap',cursor:i>1?'pointer':'default',userSelect:'none'}}>
                      {h}{sortCol===h?(sortDir<0?' ↓':' ↑'):''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r,i)=>(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                    <td style={{padding:'8px 12px',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r['Adset Name']}</td>
                    <td style={{padding:'8px 12px',maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:'var(--text3)',fontSize:11}}>{r['Campaign Name']}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Orders'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Air Orders'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmtPct(r['Attach Rate'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['New Subs'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--accent)'}}>{fmtPct(r['Sub TTP%'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--success)'}}>{fmt$(r['Order Revenue'])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({title,children}){return <div><div style={{fontSize:13,fontWeight:600,color:'var(--text2)',marginBottom:12,display:'flex',alignItems:'center',gap:8}}><span style={{width:3,height:14,background:'var(--accent)',borderRadius:2,display:'inline-block'}}/>{title}</div>{children}</div>;}
function PageHead({title,desc}){return <div><h1 style={{fontFamily:'var(--font-head)',fontSize:22,fontWeight:800,marginBottom:4}}>{title}</h1>{desc&&<p style={{color:'var(--text3)',fontSize:13}}>{desc}</p>}</div>;}
function Loader(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Empty(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>No data available</div>;}
