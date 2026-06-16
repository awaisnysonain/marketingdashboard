import React,{useState,useEffect} from 'react';
import {getTab,fmtPct,fmtNum} from '../utils/api';
import PageIntro from '../components/PageIntro';
import { L } from '../copy/plainLanguage';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ResponsiveContainer,Cell,ReferenceLine} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};
const COLORS=['#4f8ef7','#7b5cf5','#2dd4bf','#4ade80','#f59e0b','#f87171','#a78bfa','#fb923c','#34d399','#60a5fa'];

export default function ByChannelPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('By Channel').then(d=>setRows((d.rows||[]).filter(r=>r['Channel']))).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  const totalRow=rows.find(r=>String(r['Channel']||'').toUpperCase().includes('TOTAL')||String(r['Channel']||'').toUpperCase()==='ALL');
  const chanRows=rows.filter(r=>!String(r['Channel']||'').toUpperCase().includes('TOTAL')&&String(r['Channel']||'').toUpperCase()!=='ALL');

  const avgAttach=totalRow?+totalRow['Attach Rate']||0:chanRows.reduce((s,r)=>s+(+r['Attach Rate']||0),0)/Math.max(chanRows.length,1);

  const sorted=[...chanRows].sort((a,b)=>(+b['Orders w/ Nobl Air']||0)-(+a['Orders w/ Nobl Air']||0));

  const chartData=sorted.map((r,i)=>({
    channel:String(r['Channel']||'').slice(0,18),
    orders:+r['Total Orders']||0,
    air:+r['Orders w/ Nobl Air']||0,
    attach:(+r['Attach Rate']||0)*100,
    vsAvg:(+r['vs. Avg']||0)*100,
    color:COLORS[i%COLORS.length],
  }));

  const avgPct=(avgAttach||0)*100;

  const kpis=[
    {label:'Channels Tracked', value:fmtNum(chanRows.length),          color:'var(--accent)'},
    {label:'Total Orders',     value:fmtNum(totalRow?.['Total Orders']??chanRows.reduce((s,r)=>s+(+r['Total Orders']||0),0)), color:'var(--accent2)'},
    {label:'Air Orders',       value:fmtNum(totalRow?.['Orders w/ Nobl Air']??chanRows.reduce((s,r)=>s+(+r['Orders w/ Nobl Air']||0),0)), color:'var(--teal)'},
    {label:`Avg ${L.attachRate}`,  value:fmtPct(avgAttach),                 color:'var(--success)'},
  ];

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageIntro title="By Channel" desc="Air add-on rate and order volume for each sales channel." />

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))',gap:14}}>
        {kpis.map(k=>(
          <div key={k.label} style={{...CARD,position:'relative',overflow:'hidden'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:k.color,borderRadius:'3px 3px 0 0'}}/>
            <div style={{fontSize:11,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.7px',marginBottom:8}}>{k.label}</div>
            <div style={{...TH,fontSize:22,fontWeight:800}}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="Orders by Channel">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} layout="vertical" barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis dataKey="channel" type="category" tick={{fontSize:11,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={100}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                <Bar dataKey="orders" name="Total Orders" fill="rgba(79,142,247,.4)" radius={[0,3,3,0]}/>
                <Bar dataKey="air"    name="Air Orders"   fill="#4f8ef7"             radius={[0,3,3,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title={`${L.attachRate} vs avg (${fmtPct(avgPct)})`}>
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} layout="vertical" barSize={18}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%"/>
                <YAxis dataKey="channel" type="category" tick={{fontSize:11,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={100}/>
                <Tooltip formatter={fmtPct} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <ReferenceLine x={avgPct} stroke="var(--warn)" strokeDasharray="4 2" label={{value:'avg',position:'top',fontSize:10,fill:'var(--warn)'}}/>
                <Bar dataKey="attach" name={L.attachRate} radius={[0,4,4,0]}>
                  {chartData.map((d,i)=><Cell key={i} fill={d.attach>=avgPct?'var(--success)':'var(--danger)'}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title="Channel Table">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
            <thead>
              <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                {['Channel','Total Orders',L.airOrders,L.attachRate,'Vs average'].map((h,i)=>(
                  <th key={h} style={{padding:'10px 14px',textAlign:i===0?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12,whiteSpace:'nowrap'}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...sorted,totalRow].filter(Boolean).map((r,i)=>{
                const isTotal=String(r['Channel']||'').toUpperCase().includes('TOTAL')||String(r['Channel']||'').toUpperCase()==='ALL';
                const attach=+r['Attach Rate']||0;
                const vsAvg=+r['vs. Avg']||0;
                return(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:isTotal?'rgba(79,142,247,.08)':i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                    <td style={{padding:'9px 14px',fontWeight:isTotal?700:400,color:isTotal?'var(--accent)':'var(--text)'}}>{r['Channel']}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Total Orders'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Orders w/ Nobl Air'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmtPct(attach)}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:vsAvg>=0?'var(--success)':'var(--danger)'}}>{vsAvg>=0?'+':''}{fmtPct(vsAvg)}</td>
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

function Section({title,children}){return <div><div style={{fontSize:13,fontWeight:600,color:'var(--text2)',marginBottom:12,display:'flex',alignItems:'center',gap:8}}><span style={{width:3,height:14,background:'var(--accent)',borderRadius:2,display:'inline-block'}}/>{title}</div>{children}</div>;}
function Loader(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Empty(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>No data available</div>;}
