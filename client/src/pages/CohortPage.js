import React,{useState,useEffect} from 'react';
import {getTab,fmtPct,fmtNum} from '../utils/api';
import PageIntro from '../components/PageIntro';
import { L } from '../copy/plainLanguage';
import {LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ResponsiveContainer} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};

export default function CohortPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('Cohort Analysis').then(d=>setRows((d.rows||[]).filter(r=>r['Cohort Week']))).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  const chartData=rows.map(r=>({
    cohort:String(r['Cohort Week']||'').slice(5),
    totalSubs:+r['Total Subs']||0,
    mature:+r['Mature']||0,
    converted:+r['Converted']||0,
    ttp:(+r['TTP Rate']||0)*100,
    onTrial:+r['Still on Trial']||0,
  }));

  const COLORS=['#4f8ef7','#7b5cf5','#2dd4bf','#4ade80','#f59e0b'];

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageIntro title="Cohort analysis" desc="How each signup week performed: trials ended, now paying, and trial-to-paid rate." />

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="Subs by Cohort">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="cohort" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} interval={Math.max(1,Math.floor(chartData.length/6))}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                <Line type="monotone" dataKey="totalSubs" name="Total Subs" stroke={COLORS[0]} strokeWidth={2} dot={false}/>
                <Line type="monotone" dataKey="converted" name={L.converted}  stroke={COLORS[2]} strokeWidth={2} dot={false}/>
                <Line type="monotone" dataKey="onTrial"   name="On Trial"   stroke={COLORS[4]} strokeWidth={2} dot={false}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title={`${L.ttpRate} by cohort`}>
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="cohort" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} interval={Math.max(1,Math.floor(chartData.length/6))}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%"/>
                <Tooltip formatter={v=>`${v.toFixed(1)}%`} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Line type="monotone" dataKey="ttp" name={L.ttpRate} stroke={COLORS[1]} strokeWidth={2} dot={false}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title="Cohort Table">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead>
                <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                  {['Cohort Week','Total Subs',L.matureSubs,L.converted,L.ttpRate,'Still on Trial','Status'].map(h=>(
                    <th key={h} style={{padding:'10px 14px',textAlign:h==='Cohort Week'||h==='Status'?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12,whiteSpace:'nowrap'}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r,i)=>(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                    <td style={{padding:'8px 14px',fontFamily:'var(--font-mono)'}}>{r['Cohort Week']}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Total Subs'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--accent)'}}>{fmtNum(r['Mature'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--success)'}}>{fmtNum(r['Converted'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmtPct(r['TTP Rate'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--warn)'}}>{fmtNum(r['Still on Trial'])}</td>
                    <td style={{padding:'8px 14px',color:'var(--text3)',fontSize:12}}>{r['Status']||''}</td>
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
function Loader(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Empty(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>No data available</div>;}
