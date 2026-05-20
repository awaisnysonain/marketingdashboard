import React,{useState,useEffect} from 'react';
import {getTab,fmtPct,fmtNum,fmt$} from '../utils/api';
import PageIntro from '../components/PageIntro';
import { L } from '../copy/plainLanguage';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ResponsiveContainer,Cell,RadarChart,Radar,PolarGrid,PolarAngleAxis} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};
const COLORS=['#4f8ef7','#7b5cf5','#2dd4bf','#4ade80','#f59e0b','#f87171','#a78bfa'];

export default function VariantPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('Variant Activation').then(d=>setRows((d.rows||[]).filter(r=>r['Variant Price']))).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  const totalRow=rows.find(r=>String(r['Variant Price']||'').toUpperCase().includes('TOTAL'));
  const varRows=rows.filter(r=>!String(r['Variant Price']||'').toUpperCase().includes('TOTAL'));

  const chartData=varRows.map((r,i)=>({
    tier:'$'+String(r['Variant Price']||'').trim(),
    attach:(+r['Attach Rate']||0)*100,
    ttp:(+r['TTP Rate']||0)*100,
    activation:(+r['Activation Rate']||0)*100,
    activations:+r['Tot Activations (per 1K)']||0,
    revenue:+r['Total Rev (per 1K)']||0,
    color:COLORS[i%COLORS.length],
  }));

  const kpis=[
    {label:`Overall ${L.attachRate}`,    value:fmtPct(totalRow?.['Attach Rate']),    color:'var(--accent)'},
    {label:`Overall ${L.ttpRate}`,       value:fmtPct(totalRow?.['TTP Rate']),       color:'var(--teal)'},
    {label:`Overall ${L.activationRate}`,value:fmtPct(totalRow?.['Activation Rate']),color:'var(--warn)'},
    {label:'Sales per 1K orders', value:fmt$(totalRow?.['Total Rev (per 1K)']),color:'var(--success)'},
  ];

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageIntro title="Price tier performance" desc="Air add-on rate, trial-to-paid rate, and overall success by subscription price." />

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))',gap:14}}>
        {kpis.map(k=>(
          <div key={k.label} style={{...CARD,position:'relative',overflow:'hidden'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:k.color,borderRadius:'3px 3px 0 0'}}/>
            <div style={{fontSize:11,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.7px',marginBottom:8}}>{k.label}</div>
            <div style={{...TH,fontSize:22,fontWeight:800}}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:14}}>
        {chartData.map(d=>(
          <div key={d.tier} style={{...CARD,position:'relative',overflow:'hidden'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:d.color,borderRadius:'3px 3px 0 0'}}/>
            <div style={{fontSize:14,fontWeight:700,marginBottom:10,color:'var(--text)'}}>{d.tier}<span style={{fontSize:11,fontWeight:400,color:'var(--text3)',marginLeft:4}}>/ mo</span></div>
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              <Stat label="Add-on" val={`${d.attach.toFixed(1)}%`} color="var(--accent)"/>
              <Stat label="Trial→paid" val={`${d.ttp.toFixed(1)}%`}    color="var(--teal)"/>
              <Stat label="Success" val={`${d.activation.toFixed(1)}%`} color="var(--warn)"/>
            </div>
          </div>
        ))}
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="Rates by Tier">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="tier" tick={{fontSize:12,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%"/>
                <Tooltip formatter={v=>`${v.toFixed(1)}%`} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                <Bar dataKey="attach"     name={L.attachRate}     fill="#4f8ef7" radius={[3,3,0,0]}/>
                <Bar dataKey="ttp"        name={L.ttpRate}        fill="#2dd4bf" radius={[3,3,0,0]}/>
                <Bar dataKey="activation" name={L.activationRate}  fill="#f59e0b" radius={[3,3,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Sales per 1K orders by tier">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} barSize={32}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="tier" tick={{fontSize:12,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} tickFormatter={v=>`$${v}`}/>
                <Tooltip formatter={v=>fmt$(v)} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="revenue" name="Sales / 1K" radius={[4,4,0,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title="Full Variant Table">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
            <thead>
              <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                {['Tier',L.attachRate,L.ttpRate,L.activationRate,'Successes / 1K','Sales / 1K','Cancellation'].map((h,i)=>(
                  <th key={h} style={{padding:'10px 14px',textAlign:i===0?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12,whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...varRows,totalRow].filter(Boolean).map((r,i)=>{
                const isTotal=String(r['Variant Price']||'').toUpperCase().includes('TOTAL');
                return(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:isTotal?'rgba(79,142,247,.08)':i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                    <td style={{padding:'9px 14px',fontWeight:isTotal?700:500,color:isTotal?'var(--accent)':'var(--text)'}}>{isTotal?'TOTAL':'$'+String(r['Variant Price']||'').trim()}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--accent)'}}>{fmtPct(r['Attach Rate'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmtPct(r['TTP Rate'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--warn)'}}>{fmtPct(r['Activation Rate'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Tot Activations (per 1K)'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--success)'}}>{fmt$(r['Total Rev (per 1K)'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--danger)'}}>{fmtPct(r['Cancellation'])}</td>
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

function Stat({label,val,color}){
  return(
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
      <span style={{fontSize:10,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.5px'}}>{label}</span>
      <span style={{fontSize:12,fontWeight:600,color}}>{val}</span>
    </div>
  );
}
function Section({title,children}){return <div><div style={{fontSize:13,fontWeight:600,color:'var(--text2)',marginBottom:12,display:'flex',alignItems:'center',gap:8}}><span style={{width:3,height:14,background:'var(--accent)',borderRadius:2,display:'inline-block'}}/>{title}</div>{children}</div>;}
function Loader(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Empty(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>No data available</div>;}
