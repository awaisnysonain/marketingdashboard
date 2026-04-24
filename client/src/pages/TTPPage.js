import React,{useState,useEffect} from 'react';
import {getTab,fmtPct,fmtNum,fmt$} from '../utils/api';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,ResponsiveContainer,Cell} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};

export default function TTPPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('Trial to Paid').then(d=>setRows(d.rows||[])).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  const totalRow=rows.find(r=>String(r['Variant']||'').trim()==='TOTAL')||{};
  const tierRows=rows.filter(r=>String(r['Variant']||'').trim()!=='TOTAL'&&r['Variant']);

  const chartData=tierRows.map(r=>({
    tier:'$'+String(r['Variant']||'').trim(),
    ttp:(+r['Conv%']||0)*100,
    subs:+r['Total']||0,
    converted:+r['Converted']||0,
  }));

  const COLORS=['#4f8ef7','#7b5cf5','#2dd4bf','#4ade80','#f59e0b','#f87171'];

  const kpis=[
    {label:'Overall TTP Rate', value:fmtPct(totalRow['Conv%']),    color:'var(--teal)'},
    {label:'Total Subs',       value:fmtNum(totalRow['Total']),     color:'var(--accent)'},
    {label:'Total Converted',  value:fmtNum(totalRow['Converted']), color:'var(--success)'},
    {label:'On Trial',         value:fmtNum(totalRow['On Trial']),  color:'var(--warn)'},
  ];

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageHead title="Trial to Paid" desc="Subscription conversion rates by price tier"/>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))',gap:14}}>
        {kpis.map(k=>(
          <div key={k.label} style={{...CARD,position:'relative',overflow:'hidden'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:k.color,borderRadius:'3px 3px 0 0'}}/>
            <div style={{fontSize:11,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.7px',marginBottom:8}}>{k.label}</div>
            <div style={{...TH,fontSize:24,fontWeight:800}}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="TTP Rate by Tier">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} barSize={32}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="tier" tick={{fontSize:12,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%"/>
                <Tooltip formatter={v=>`${v.toFixed(1)}%`} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="ttp" name="TTP Rate %" radius={[4,4,0,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Total vs Converted by Tier">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="tier" tick={{fontSize:12,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="subs"      name="Total Subs" fill="#4f8ef7" radius={[3,3,0,0]}/>
                <Bar dataKey="converted" name="Converted"  fill="#4ade80" radius={[3,3,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title="Tier Breakdown">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
            <thead>
              <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                {['Tier','Total','Converted','TTP Rate','On Trial','Cancelled','Revenue'].map(h=>(
                  <th key={h} style={{padding:'10px 14px',textAlign:h==='Tier'?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...tierRows,totalRow].filter(Boolean).map((r,i)=>{
                const isTotal=String(r['Variant']||'').trim()==='TOTAL';
                return(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:isTotal?'rgba(79,142,247,.08)':i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                    <td style={{padding:'9px 14px',fontWeight:isTotal?700:400,color:isTotal?'var(--accent)':'var(--text)'}}>{isTotal?'TOTAL':'$'+String(r['Variant']||'').trim()}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Total'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--success)'}}>{fmtNum(r['Converted'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmtPct(r['Conv%'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--warn)'}}>{fmtNum(r['On Trial'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--danger)'}}>{fmtNum(r['Cancelled'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmt$(r['Revenue'])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Section({title,children}){
  return(
    <div>
      <div style={{fontSize:13,fontWeight:600,color:'var(--text2)',marginBottom:12,display:'flex',alignItems:'center',gap:8}}>
        <span style={{width:3,height:14,background:'var(--accent)',borderRadius:2,display:'inline-block'}}/>
        {title}
      </div>
      {children}
    </div>
  );
}
function PageHead({title,desc}){return <div><h1 style={{fontFamily:'var(--font-head)',fontSize:22,fontWeight:800,marginBottom:4}}>{title}</h1>{desc&&<p style={{color:'var(--text3)',fontSize:13}}>{desc}</p>}</div>;}
function Loader(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Empty(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>No data available</div>;}
