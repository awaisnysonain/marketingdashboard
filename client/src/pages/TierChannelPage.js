import React,{useState,useEffect} from 'react';
import {getTab,fmtPct,fmtNum,fmt$} from '../utils/api';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ResponsiveContainer,Cell} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};
const TIER_COLORS={'79':'#4f8ef7','99':'#7b5cf5','119':'#2dd4bf','129':'#4ade80','139':'#f59e0b','149':'#f87171'};
const COLORS=Object.values(TIER_COLORS);

export default function TierChannelPage(){
  const [rows,setRows]=useState([]);
  const [headers,setHeaders]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('Tier x Channel').then(d=>{
      setRows(d.rows||[]);
      setHeaders(d.headers||[]);
    }).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  // The first column is the channel/row label
  const labelCol=headers[0]||Object.keys(rows[0]||{})[0]||'Channel';
  // Only keep numeric price-tier columns (e.g. "79","99","119"…), exclude summary cols like "Total Subs","Top Tier","Attach Rate"
  const tierCols=headers.filter(h=>h!==labelCol&&h!==''&&/^\d+$/.test(String(h).trim()));

  // Rows with data
  const dataRows=rows.filter(r=>r[labelCol]&&String(r[labelCol]).trim()!=='');
  const totalRow=dataRows.find(r=>String(r[labelCol]||'').toUpperCase().includes('TOTAL'));
  const chanRows=dataRows.filter(r=>!String(r[labelCol]||'').toUpperCase().includes('TOTAL'));

  // Build chart data: each channel, bars per tier
  const chartData=chanRows.map(r=>({
    channel:String(r[labelCol]||'').slice(0,16),
    ...tierCols.reduce((o,t)=>({...o,[t]:+r[t]||0}),{}),
  }));

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageHead title="Tier × Channel" desc="Subscription distribution across price tiers and channels"/>

      {tierCols.length>0&&(
        <Section title="Subs by Channel and Tier">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)"/>
                <XAxis dataKey="channel" tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:11,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                {tierCols.map((t,i)=>(
                  <Bar key={t} dataKey={t} name={`$${t}`} fill={COLORS[i%COLORS.length]} radius={[3,3,0,0]} stackId="a"/>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      <Section title="Full Table">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead>
                <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                  <th style={{padding:'10px 14px',textAlign:'left',color:'var(--text2)',fontWeight:500,fontSize:12}}>{labelCol}</th>
                  {tierCols.map(t=>(
                    <th key={t} style={{padding:'10px 14px',textAlign:'right',color:'var(--text2)',fontWeight:500,fontSize:12,whiteSpace:'nowrap'}}>${t}</th>
                  ))}
                  <th style={{padding:'10px 14px',textAlign:'right',color:'var(--text2)',fontWeight:500,fontSize:12}}>Total</th>
                </tr>
              </thead>
              <tbody>
                {[...chanRows,totalRow].filter(Boolean).map((r,i)=>{
                  const isTotal=String(r[labelCol]||'').toUpperCase().includes('TOTAL');
                  const rowTotal=tierCols.reduce((s,t)=>s+(+r[t]||0),0);
                  return(
                    <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:isTotal?'rgba(79,142,247,.08)':i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                      <td style={{padding:'9px 14px',fontWeight:isTotal?700:400,color:isTotal?'var(--accent)':'var(--text)'}}>{r[labelCol]}</td>
                      {tierCols.map(t=>(
                        <td key={t} style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r[t])}</td>
                      ))}
                      <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--accent)'}}>{fmtNum(rowTotal||r['Total Subs'])}</td>
                    </tr>
                  );
                })}
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
