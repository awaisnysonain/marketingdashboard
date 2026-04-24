import React,{useState,useEffect} from 'react';
import {getTab,fmtPct,fmtNum} from '../utils/api';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ResponsiveContainer,Cell} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};
const DOW_ORDER=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const COLORS=['#4f8ef7','#7b5cf5','#2dd4bf','#4ade80','#f59e0b','#f87171','#a78bfa'];

export default function DayOfWeekPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('Day of Week').then(d=>setRows(d.rows||[])).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  const sorted=DOW_ORDER.map(day=>rows.find(r=>String(r['Day']||'').trim()===day)).filter(Boolean);
  const display=sorted.length?sorted:rows;

  const chartData=display.map((r,i)=>({
    day:String(r['Day']||'').slice(0,3),
    orders:+r['Avg Orders/Day']||0,
    air:+r['Avg Air Orders/Day']||0,
    attach:(+r['Avg Attach Rate']||0)*100,
    subs:+r['Avg New Subs/Day']||0,
    color:COLORS[i%COLORS.length],
  }));

  const best=chartData.reduce((b,r)=>r.attach>b.attach?r:b,chartData[0]||{});
  const worst=chartData.reduce((b,r)=>r.attach<b.attach?r:b,chartData[0]||{});

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageHead title="Day of Week" desc="Average performance metrics broken down by day of week"/>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))',gap:14}}>
        {chartData.map(d=>(
          <div key={d.day} style={{...CARD,position:'relative',overflow:'hidden'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:d.color,borderRadius:'3px 3px 0 0'}}/>
            <div style={{fontSize:13,fontWeight:700,marginBottom:6,color:'var(--text)'}}>{d.day}</div>
            <div style={{fontSize:11,color:'var(--text3)',marginBottom:2}}>Avg Orders</div>
            <div style={{...TH,fontSize:18,fontWeight:700,marginBottom:6}}>{fmtNum(d.orders)}</div>
            <div style={{fontSize:11,color:'var(--text3)',marginBottom:2}}>Attach Rate</div>
            <div style={{fontSize:16,fontWeight:600,color:d.day===best.day?'var(--success)':d.day===worst.day?'var(--danger)':'var(--teal)'}}>{d.attach.toFixed(1)}%</div>
          </div>
        ))}
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="Avg Orders by Day">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="day" tick={{fontSize:12,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                <Bar dataKey="orders" name="Total" fill="#4f8ef7" radius={[4,4,0,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Avg Attach Rate by Day">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="day" tick={{fontSize:12,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%"/>
                <Tooltip formatter={v=>`${v.toFixed(1)}%`} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="attach" name="Attach %" radius={[4,4,0,0]}>
                  {chartData.map((d,i)=><Cell key={i} fill={d.day===best.day?'var(--success)':d.day===worst.day?'var(--danger)':COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title="Full Table">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
            <thead>
              <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                {['Day','# Days in Range','Avg Orders/Day','Avg Air Orders/Day','Avg Attach Rate','Avg New Subs/Day','Notes'].map(h=>(
                  <th key={h} style={{padding:'10px 14px',textAlign:h==='Day'||h==='Notes'?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12,whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {display.map((r,i)=>(
                <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                  <td style={{padding:'9px 14px',fontWeight:600}}>{r['Day']}</td>
                  <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['# Days in Range'])}</td>
                  <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Avg Orders/Day'])}</td>
                  <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Avg Air Orders/Day'])}</td>
                  <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmtPct(r['Avg Attach Rate'])}</td>
                  <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Avg New Subs/Day'])}</td>
                  <td style={{padding:'9px 14px',color:'var(--text3)',fontSize:12}}>{r['Notes']||''}</td>
                </tr>
              ))}
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
