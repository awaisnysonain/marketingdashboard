import React,{useState,useEffect} from 'react';
import {getTab,fmt$,fmtPct,fmtNum} from '../utils/api';
import PageIntro from '../components/PageIntro';
import { L } from '../copy/plainLanguage';

const TH={fontFamily:'var(--font-head)'};
const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};

export default function SummaryPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('Summary').then(d=>setRows(d.rows||[])).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;

  const get=(metric)=>{
    const r=rows.find(r=>String(r['Metric']||'').trim()===metric);
    return r?r['Value']:'';
  };

  // Core KPIs
  const kpis=[
    {label:'Total Orders',       value:fmtNum(get('Total Orders (Shopify GQL)')),     sub:'All Shopify orders',         color:'blue'},
    {label:'Air Orders',         value:fmtNum(get('Orders with Nobl Air')),            sub:'Orders with NOBLAIR SKU',    color:'purple'},
    {label:L.attachRate,        value:fmtPct(get('Overall Attach Rate')),             sub:'Air ÷ total orders',         color:'teal'},
    {label:L.ttpRate,           value:fmtPct(get('TTP Rate (wt avg)')),               sub:'14-day weighted avg',        color:'green'},
    {label:L.activationRate,    value:fmtPct(get('Activation Rate (Attach × TTP)')), sub:'Add-on × trial-to-paid',               color:'warn'},
    {label:'7-day success rate',      value:fmtPct(get('Rolling 7d Activation')),           sub:'Rolling 7-day window',       color:'blue'},
  ];

  // Revenue
  const rev=[
    {label:'Tag net sales',       value:fmt$(get('Tag Net Revenue'))},
    {label:L.subRevenue,  value:fmt$(get('Subscription Net Revenue'))},
    {label:L.combinedNetRevenue,  value:fmt$(get('Combined NOBL Air Net Revenue'))},
    {label:'Sales per Air order',     value:fmt$(get('Blended Rev per Air Order'))},
    {label:'Renewals',               value:fmt$(get('→ Rebills (Appstle, recurring)'))},
    {label:'Tag Gross',             value:fmt$(get('Tag Gross (NOBL Air™ hardware)'))},
    {label:'Tag Net Sales',         value:fmt$(get('Tag Net Sales'))},
    {label:'Sub Gross',             value:fmt$(get('Sub Gross (NOBL Air™ Subscription)'))},
  ];

  // TTP by tier rows
  const tierRows=rows.filter(r=>{
    const m=String(r['Metric']||'');
    return ['79','99','119','129','139','149','TOTAL'].includes(m.trim())&&r['Value']!==''&&r['Notes']!=='';
  });

  // Highlights
  const highlights=[
    {label:'Best Channel',  value:String(get('Best Channel')||'')},
    {label:'Worst Channel', value:String(get('Worst Channel')||'')},
    {label:'Best Product',  value:String(get('Best Product')||'')},
    {label:'Worst Product', value:String(get('Worst Product')||'')},
    {label:'Best Color',    value:String(get('Best Color')||'')},
    {label:'Worst Color',   value:String(get('Worst Color')||'')},
  ].filter(h=>h.value);

  // Intl
  const intl=[
    {label:'International Orders', value:fmtNum(get('International Orders'))},
    {label:'Intl w/ Nobl Air',     value:fmtNum(get('Intl Orders w/ Nobl Air'))},
    {label:'Intl Air add-on rate',     value:fmtPct(get('International Attach Rate'))},
  ];

  const COLORS={blue:'var(--accent)',purple:'var(--accent2)',teal:'var(--teal)',green:'var(--success)',warn:'var(--warn)'};

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageIntro title="Summary" desc="Headline Air metrics for the full reporting period: orders, add-ons, trials, and sales." />

      {/* Core KPIs */}
      <Section title="Core Metrics">
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))',gap:14}}>
          {kpis.map(k=>(
            <div key={k.label} style={{...CARD,position:'relative',overflow:'hidden'}}>
              <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:COLORS[k.color],borderRadius:'3px 3px 0 0'}}/>
              <div style={{fontSize:11,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.7px',marginBottom:8}}>{k.label}</div>
              <div style={{...TH,fontSize:24,fontWeight:800,lineHeight:1.1,marginBottom:4}}>{k.value}</div>
              <div style={{fontSize:11,color:'var(--text3)'}}>{k.sub}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Revenue */}
      <Section title="Sales breakdown">
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))',gap:14}}>
          {rev.map((r,i)=>(
            <div key={i} style={{...CARD,display:'flex',flexDirection:'column',gap:4}}>
              <div style={{fontSize:11,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.6px'}}>{r.label}</div>
              <div style={{...TH,fontSize:20,fontWeight:700,color: i===2?'var(--accent)':'var(--text)'}}>{r.value}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* TTP by tier + Highlights side by side */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        {tierRows.length>0 && (
          <Section title="Trial-to-Paid by Tier">
            <div style={{...CARD,padding:0,overflow:'hidden'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
                <thead>
                  <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                    {['Tier','Total Subs',L.ttpRate,L.sales].map(h=>(
                      <th key={h} style={{padding:'10px 14px',textAlign:h==='Tier'?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tierRows.map((r,i)=>{
                    const isTot=String(r['Metric']).trim()==='TOTAL';
                    return(
                      <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:isTot?'rgba(79,142,247,.08)':i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                        <td style={{padding:'9px 14px',fontWeight:isTot?700:400,color:isTot?'var(--accent)':'var(--text)'}}>{isTot?'TOTAL':'$'+r['Metric']}</td>
                        <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Value'])}</td>
                        <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{r['Notes']&&!isTot?fmtPct(r['Notes']):'—'}</td>
                        <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{r['Notes']&&isTot?'—':'—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {highlights.length>0 && (
          <div style={{display:'flex',flexDirection:'column',gap:0}}>
            <Section title="Air add-on highlights">
              <div style={{...CARD,display:'flex',flexDirection:'column',gap:0,padding:0,overflow:'hidden'}}>
                {highlights.map((h,i)=>{
                  const isGood=h.label.startsWith('Best');
                  return(
                    <div key={i} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'11px 16px',borderBottom:i<highlights.length-1?'1px solid rgba(255,255,255,.04)':'none',background:i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                      <span style={{fontSize:12,color:'var(--text3)',minWidth:110}}>{h.label}</span>
                      <span style={{fontSize:12,fontWeight:500,color:isGood?'var(--success)':'var(--danger)',textAlign:'right',maxWidth:240,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{h.value}</span>
                    </div>
                  );
                })}
              </div>
            </Section>
            <Section title="International" style={{marginTop:20}}>
              <div style={{display:'flex',gap:12}}>
                {intl.map((x,i)=>(
                  <div key={i} style={{...CARD,flex:1}}>
                    <div style={{fontSize:11,color:'var(--text3)',marginBottom:5,textTransform:'uppercase',letterSpacing:'.6px',fontSize:10}}>{x.label}</div>
                    <div style={{...TH,fontSize:18,fontWeight:700}}>{x.value}</div>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({title,children,style={}}){
  return(
    <div style={style}>
      <div style={{fontSize:13,fontWeight:600,color:'var(--text2)',marginBottom:12,display:'flex',alignItems:'center',gap:8}}>
        <span style={{width:3,height:14,background:'var(--accent)',borderRadius:2,display:'inline-block'}}/>
        {title}
      </div>
      {children}
    </div>
  );
}

function Loader(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
