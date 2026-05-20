import React,{useState,useEffect,useMemo} from 'react';
import {getTab,fmt$,fmtNum,fmtPct} from '../utils/api';
import TablePagination from '../components/TablePagination';
import { useClientPagination } from '../hooks/useClientPagination';
import { TABLE_PAGE_SIZE } from '../constants/pagination';
import PageIntro from '../components/PageIntro';
import { L } from '../copy/plainLanguage';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,ResponsiveContainer,Cell} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};
const COLORS=['#4f8ef7','#7b5cf5','#2dd4bf','#4ade80','#f59e0b','#f87171','#a78bfa','#fb923c','#34d399','#60a5fa'];

export default function ByProductPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    getTab('By Product').then(d=>setRows((d.rows||[]).filter(r=>r['Product / Bundle']&&String(r['Product / Bundle']).trim()!==''))).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  const { totalRow, sorted } = useMemo(() => {
    if (!rows.length) return { totalRow: null, sorted: [] };
    const tr = rows.find(r => String(r['Product / Bundle'] || '').toUpperCase().includes('TOTAL'));
    const dr = rows.filter(r => !String(r['Product / Bundle'] || '').toUpperCase().includes('TOTAL'));
    return { totalRow: tr, sorted: [...dr].sort((a, b) => (+b['Air Orders'] || 0) - (+a['Air Orders'] || 0)) };
  }, [rows]);

  const { page, setPage, pageItems, totalRows, rowOffset } = useClientPagination(sorted, TABLE_PAGE_SIZE, [rows]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;
  const top10=sorted.slice(0,10);

  const chartData=top10.map((r,i)=>({
    name:String(r['Product / Bundle']||'').replace('NOBL Air™ ','').slice(0,22),
    air:+r['Air Orders']||0,
    rev:+r['Gross Revenue']||0,
    intl:+r['Intl Orders']||0,
    color:COLORS[i%COLORS.length],
  }));

  const kpis=[
    {label:'Total Products',   value:fmtNum(sorted.length),                               color:'var(--accent)'},
    {label:'Total Air Orders', value:fmtNum(totalRow?.['Air Orders']??sorted.reduce((s,r)=>s+(+r['Air Orders']||0),0)), color:'var(--accent2)'},
    {label:'Gross sales',    value:fmt$(totalRow?.['Gross Revenue']??sorted.reduce((s,r)=>s+(+r['Gross Revenue']||0),0)), color:'var(--success)'},
    {label:'Intl Orders',      value:fmtNum(totalRow?.['Intl Orders']??sorted.reduce((s,r)=>s+(+r['Intl Orders']||0),0)), color:'var(--warn)'},
  ];

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageIntro title="By product" desc="Air orders and sales broken down by product bundle." />

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
        <Section title="Top 10 by Air Orders">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData} layout="vertical" barSize={16}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis dataKey="name" type="category" tick={{fontSize:10,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={130}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="air" name="Air Orders" radius={[0,4,4,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Top 10 by sales">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={[...chartData].sort((a,b)=>b.rev-a.rev)} layout="vertical" barSize={16}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} tickFormatter={v=>v>=1000?`$${(v/1000).toFixed(0)}k`:`$${v}`}/>
                <YAxis dataKey="name" type="category" tick={{fontSize:10,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={130}/>
                <Tooltip formatter={v=>fmt$(v)} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="rev" name={L.sales} radius={[0,4,4,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title="All Products">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead>
                <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                  {['#','Product / Bundle',L.airOrders,'Gross sales','Intl Orders'].map((h,i)=>(
                    <th key={h} style={{padding:'10px 14px',textAlign:i<=1?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12,whiteSpace:'nowrap'}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageItems.map((r,i)=>(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                    <td style={{padding:'8px 14px',color:'var(--text3)',fontSize:12,fontFamily:'var(--font-mono)'}}>{rowOffset+i+1}</td>
                    <td style={{padding:'8px 14px',maxWidth:300,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r['Product / Bundle']}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',fontWeight:600}}>{fmtNum(r['Air Orders'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--success)'}}>{fmt$(r['Gross Revenue'])}</td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--text3)'}}>{fmtNum(r['Intl Orders'])}</td>
                  </tr>
                ))}
                {totalRow&&(
                  <tr style={{background:'rgba(79,142,247,.08)',borderTop:'1px solid var(--border2)'}}>
                    <td style={{padding:'9px 14px'}}/>
                    <td style={{padding:'9px 14px',fontWeight:700,color:'var(--accent)'}}>TOTAL</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',fontWeight:700}}>{fmtNum(totalRow['Air Orders'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',fontWeight:700,color:'var(--success)'}}>{fmt$(totalRow['Gross Revenue'])}</td>
                    <td style={{padding:'9px 14px',textAlign:'right',fontFamily:'var(--font-mono)',fontWeight:700}}>{fmtNum(totalRow['Intl Orders'])}</td>
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
