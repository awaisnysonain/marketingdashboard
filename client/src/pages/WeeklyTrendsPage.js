import React,{useState,useEffect} from 'react';
import {getTab,fmt$,fmtPct,fmtNum} from '../utils/api';
import PageIntro from '../components/PageIntro';
import { L } from '../copy/plainLanguage';
import {LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ResponsiveContainer,BarChart,Bar} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};

export default function WeeklyTrendsPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('Weekly Trends').then(d=>setRows((d.rows||[]).filter(r=>r['Week (Mon)']&&String(r['Week (Mon)'])!=='TOTAL'))).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  const chartData=rows.map(r=>({
    week:String(r['Week (Mon)']||'').slice(5),
    orders:+r['Orders']||0,
    air:+r['Air Orders']||0,
    attach:(+r['Attach Rate']||0)*100,
    newSubs:+r['New Subs']||0,
    revenue:+r['Combined Net Rev']||0,
    ttp:(+r['Sub TTP%']||0)*100,
  }));

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageIntro title="Weekly Trends" desc="Week-by-week orders, Air add-ons, subscriptions, and sales." />

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="Weekly Orders">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="week" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                <Bar dataKey="orders" name="Total" fill="#4f8ef7" radius={[3,3,0,0]}/>
                <Bar dataKey="air"    name="Air"   fill="#7b5cf5" radius={[3,3,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title={`Weekly ${L.attachRate}`}>
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="week" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%"/>
                <Tooltip formatter={fmtPct} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Line type="monotone" dataKey="attach" name={L.attachRate} stroke="var(--teal)" strokeWidth={2} dot={false}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="New Subs per Week">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="week" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="newSubs" name="New Subs" fill="#4ade80" radius={[3,3,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Weekly sales">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="week" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} tickFormatter={fmt$}/>
                <Tooltip formatter={v=>fmt$(v)} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Line type="monotone" dataKey="revenue" name={L.sales} stroke="var(--warn)" strokeWidth={2} dot={false}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title="Weekly Table">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead>
                <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                  {['Week','Orders',L.airOrders,L.attachRate,L.newSubs,L.ttpRate,L.combinedNetRevenue,L.rebillRevenue,'Tag net sales'].map(h=>(
                    <th key={h} style={{padding:'10px 14px',textAlign:h==='Week'?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12,whiteSpace:'nowrap'}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice().reverse().map((r,i)=>(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                    <td style={{padding:'8px 14px',fontFamily:'var(--font-mono)'}}>{r['Week (Mon)']}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Orders'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Air Orders'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmtPct(r['Attach Rate'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['New Subs'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--accent)'}}>{fmtPct(r['Sub TTP%'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--success)'}}>{fmt$(r['Combined Net Rev'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--warn)'}}>{fmt$(r['Rebill Rev'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmt$(r['Tag Net Rev'])}</td>
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
