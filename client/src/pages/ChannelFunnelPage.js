import React,{useState,useEffect,useMemo} from 'react';
import {getTab,fmtPct,fmtNum,fmt$} from '../utils/api';
import TablePagination from '../components/TablePagination';
import { useClientPagination } from '../hooks/useClientPagination';
import { TABLE_PAGE_SIZE } from '../constants/pagination';
import PageIntro from '../components/PageIntro';
import { L } from '../copy/plainLanguage';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ResponsiveContainer,Cell} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};
const COLORS=['#4f8ef7','#7b5cf5','#2dd4bf','#4ade80','#f59e0b','#f87171','#a78bfa','#fb923c','#34d399','#60a5fa'];

export default function ChannelFunnelPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('Channel Funnel').then(d=>setRows((d.rows||[]).filter(r=>r['Channel']))).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  const { totalRow, sorted } = useMemo(() => {
    if (!rows.length) return { totalRow: null, sorted: [] };
    const tr = rows.find(r => String(r['Channel'] || '').toUpperCase().includes('TOTAL') || String(r['Channel'] || '').toUpperCase() === 'ALL');
    const cr = rows.filter(r => !String(r['Channel'] || '').toUpperCase().includes('TOTAL') && String(r['Channel'] || '').toUpperCase() !== 'ALL');
    return { totalRow: tr, sorted: [...cr].sort((a, b) => (+b['Orders'] || 0) - (+a['Orders'] || 0)) };
  }, [rows]);

  const { page, setPage, pageItems, totalRows } = useClientPagination(sorted, TABLE_PAGE_SIZE, [rows]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  const chartData=sorted.map((r,i)=>({
    channel:String(r['Channel']||'').slice(0,16),
    orders:+r['Orders']||0,
    air:+r['Air Orders']||0,
    subs:+r['New Subs']||0,
    attach:(+r['Attach Rate']||0)*100,
    ttp:(+r['Sub TTP Rate']||0)*100,
    revenue:+r['Sub Revenue']||0,
    avgRev:+r['Avg Order Rev']||0,
    color:COLORS[i%COLORS.length],
  }));

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageIntro title="Channel funnel" desc="Orders, Air add-ons, new subscriptions, and subscription sales by channel." />

      {totalRow&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))',gap:14}}>
          {[
            {label:'Total Orders',  value:fmtNum(totalRow['Orders']),      color:'var(--accent)'},
            {label:'Air Orders',    value:fmtNum(totalRow['Air Orders']),   color:'var(--accent2)'},
            {label:L.attachRate,   value:fmtPct(totalRow['Attach Rate']),  color:'var(--teal)'},
            {label:L.newSubs,      value:fmtNum(totalRow['New Subs']),     color:'var(--success)'},
            {label:L.ttpRate,  value:fmtPct(totalRow['Sub TTP Rate']), color:'var(--warn)'},
            {label:L.subRevenue,   value:fmt$(totalRow['Sub Revenue']),    color:'var(--success)'},
          ].map(k=>(
            <div key={k.label} style={{...CARD,position:'relative',overflow:'hidden'}}>
              <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:k.color,borderRadius:'3px 3px 0 0'}}/>
              <div style={{fontSize:11,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.7px',marginBottom:8}}>{k.label}</div>
              <div style={{...TH,fontSize:20,fontWeight:800}}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="Orders → Air → Subs Funnel">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} layout="vertical" barGap={3}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis dataKey="channel" type="category" tick={{fontSize:10,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={90}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                <Bar dataKey="orders" name="Orders"    fill="rgba(79,142,247,.3)"  radius={[0,2,2,0]}/>
                <Bar dataKey="air"    name="Air Orders" fill="#4f8ef7"             radius={[0,2,2,0]}/>
                <Bar dataKey="subs"   name="New Subs"   fill="#4ade80"             radius={[0,2,2,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title={`${L.attachRate} by channel`}>
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} layout="vertical" barSize={18}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%"/>
                <YAxis dataKey="channel" type="category" tick={{fontSize:10,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={90}/>
                <Tooltip formatter={fmtPct} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="attach" name={L.attachRate} radius={[0,4,4,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title="Channel Funnel Table">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead>
                <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                  {['Channel','Orders',L.airOrders,L.attachRate,L.newSubs,L.ttpRate,L.subRevenue,'Avg order sales','Notes'].map((h,i)=>(
                    <th key={h} style={{padding:'10px 14px',textAlign:i===0||i===8?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12,whiteSpace:'nowrap'}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageItems.map((r,i)=>(
                    <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                      <td style={{padding:'9px 14px'}}>{r['Channel']}</td>
                      <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Orders'])}</td>
                      <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Air Orders'])}</td>
                      <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmtPct(r['Attach Rate'])}</td>
                      <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['New Subs'])}</td>
                      <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--accent)'}}>{fmtPct(r['Sub TTP Rate'])}</td>
                      <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--success)'}}>{fmt$(r['Sub Revenue'])}</td>
                      <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmt$(r['Avg Order Rev'])}</td>
                      <td style={{padding:'9px 14px',color:'var(--text3)',fontSize:12,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r['Notes']||''}</td>
                    </tr>
                ))}
                {totalRow && (
                  <tr style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:'rgba(79,142,247,.08)'}}>
                    <td style={{padding:'9px 14px',fontWeight:700,color:'var(--accent)'}}>{totalRow['Channel']}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(totalRow['Orders'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(totalRow['Air Orders'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmtPct(totalRow['Attach Rate'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(totalRow['New Subs'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--accent)'}}>{fmtPct(totalRow['Sub TTP Rate'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--success)'}}>{fmt$(totalRow['Sub Revenue'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmt$(totalRow['Avg Order Rev'])}</td>
                    <td style={{padding:'9px 14px',color:'var(--text3)',fontSize:12}}>{totalRow['Notes']||''}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <TablePagination page={page} pageSize={TABLE_PAGE_SIZE} totalRows={totalRows} onPageChange={setPage} />
        </div>
      </Section>
    </div>
  );
}

function Section({title,children}){return <div><div style={{fontSize:13,fontWeight:600,color:'var(--text2)',marginBottom:12,display:'flex',alignItems:'center',gap:8}}><span style={{width:3,height:14,background:'var(--accent)',borderRadius:2,display:'inline-block'}}/>{title}</div>{children}</div>;}
function Loader(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Empty(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>No data available</div>;}
