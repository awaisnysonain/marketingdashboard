import React,{useState,useEffect} from 'react';
import {getTab,fmt$,fmtPct,fmtNum,fmtDate} from '../utils/api';
import {LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ResponsiveContainer,AreaChart,Area} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};

export default function DailyTrendPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('Daily Trend').then(d=>setRows((d.rows||[]).filter(r=>r['Date']&&String(r['Date'])!=='TOTAL'))).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  // Actual columns: Date, Orders, Air Orders, Attach Rate, New Subs,
  //                 Tag Gross, Sub Rev Gross, Rebill Rev, Combined Net Revenue, Tag Net Rev
  const chartData=rows.map(r=>({
    date:fmtDate(r['Date']),
    attach:(+r['Attach Rate']||0)*100,
    orders:+r['Orders']||0,
    airOrders:+r['Air Orders']||0,
    newSubs:+r['New Subs']||0,
    combinedRev:+r['Combined Net Revenue']||0,
    tagRev:+r['Tag Net Rev']||0,
    rebillRev:+r['Rebill Rev']||0,
  }));

  const interval=Math.max(1,Math.floor(chartData.length/8));

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageHead title="Daily Trend" desc="Daily attach rate, orders, and revenue over time"/>

      <Section title="Attach Rate Trend">
        <div style={{...CARD,padding:'16px'}}>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="gAttach" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
              <XAxis dataKey="date" tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} interval={interval}/>
              <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%"/>
              <Tooltip formatter={v=>`${v.toFixed(1)}%`} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
              <Area type="monotone" dataKey="attach" name="Attach %" stroke="var(--accent)" fill="url(#gAttach)" strokeWidth={2} dot={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Section>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="Combined Net Revenue">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--success)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="var(--success)" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="date" tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} interval={interval}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} tickFormatter={v=>v>=1000?`$${(v/1000).toFixed(0)}k`:`$${v}`}/>
                <Tooltip formatter={v=>[fmt$(v),'Net Rev']} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Area type="monotone" dataKey="combinedRev" name="Combined Net Rev" stroke="var(--success)" fill="url(#gRev)" strokeWidth={2} dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Tag & Rebill Revenue">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="date" tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} interval={interval}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} tickFormatter={v=>v>=1000?`$${(v/1000).toFixed(0)}k`:`$${v}`}/>
                <Tooltip formatter={v=>[fmt$(v)]} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                <Line type="monotone" dataKey="tagRev"    name="Tag Net Rev" stroke="var(--teal)" strokeWidth={2} dot={false}/>
                <Line type="monotone" dataKey="rebillRev" name="Rebill Rev"  stroke="var(--warn)" strokeWidth={2} dot={false}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title="Orders Over Time">
        <div style={{...CARD,padding:'16px'}}>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
              <XAxis dataKey="date" tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false} interval={interval}/>
              <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
              <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
              <Legend wrapperStyle={{fontSize:12}}/>
              <Line type="monotone" dataKey="orders"    name="Orders"     stroke="#4f8ef7" strokeWidth={2} dot={false}/>
              <Line type="monotone" dataKey="airOrders" name="Air Orders" stroke="#7b5cf5" strokeWidth={2} dot={false}/>
              <Line type="monotone" dataKey="newSubs"   name="New Subs"   stroke="#4ade80" strokeWidth={2} dot={false}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>

      <Section title="Data Table">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead>
                <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                  {['Date','Orders','Air Orders','Attach Rate','New Subs','Tag Net Rev','Rebill Rev','Combined Net Rev'].map(h=>(
                    <th key={h} style={{padding:'10px 14px',textAlign:h==='Date'?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12,whiteSpace:'nowrap'}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice().reverse().map((r,i)=>(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                    <td style={{padding:'8px 14px',fontFamily:'var(--font-mono)'}}>{fmtDate(r['Date'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Orders'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Air Orders'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--accent)'}}>{fmtPct(r['Attach Rate'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['New Subs'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmt$(r['Tag Net Rev'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--warn)'}}>{fmt$(r['Rebill Rev'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--success)'}}>{fmt$(r['Combined Net Revenue'])}</td>
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
function PageHead({title,desc}){return <div><h1 style={{fontFamily:'var(--font-head)',fontSize:22,fontWeight:800,marginBottom:4}}>{title}</h1>{desc&&<p style={{color:'var(--text3)',fontSize:13}}>{desc}</p>}</div>;}
function Loader(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Empty(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>No data available</div>;}
