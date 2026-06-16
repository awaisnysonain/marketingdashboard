import React,{useState,useEffect} from 'react';
import {getTab,fmtPct,fmtNum,fmt$} from '../utils/api';
import TablePagination from '../components/TablePagination';
import TableFilterBar from '../components/TableFilterBar';
import { SEARCH_ALL_COLUMNS } from '../constants/tableSearch';
import { filterTableRows } from '../utils/tableFilterSort';
import { TABLE_PAGE_SIZE } from '../constants/pagination';
import PageIntro from '../components/PageIntro';
import { L, plainHeader } from '../copy/plainLanguage';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ResponsiveContainer,Cell} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};
const COLORS=['#4f8ef7','#7b5cf5','#2dd4bf','#4ade80','#f59e0b','#f87171','#a78bfa','#fb923c','#34d399','#60a5fa'];

export default function FbCampaignsPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);
  const [sortCol,setSortCol]=useState('Orders');
  const [sortDir,setSortDir]=useState(-1);
  const [search,setSearch]=useState('');
  const [searchColumn,setSearchColumn]=useState(SEARCH_ALL_COLUMNS);
  const [page,setPage]=useState(1);

  useEffect(()=>{
    getTab('FB Campaigns').then(d=>setRows((d.rows||[]).filter(r=>r['Campaign Name']))).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  const COLS=['Campaign Name','Orders','Air Orders','Attach Rate','New Subs','Sub TTP%','Order Revenue','Adsets','Unique Ads'];
  const totalRow=rows.find(r=>String(r['Campaign Name']||'').toUpperCase().includes('TOTAL'));
  const dataRows=rows.filter(r=>!String(r['Campaign Name']||'').toUpperCase().includes('TOTAL'));

  const filtered=filterTableRows(dataRows, COLS, search, searchColumn);
  const sorted=[...filtered].sort((a,b)=>sortDir*((+b[sortCol]||0)-(+a[sortCol]||0)));
  const totalPages=Math.max(1,Math.ceil(sorted.length/TABLE_PAGE_SIZE));
  const safePage=Math.min(page,totalPages);
  const pageRows=sorted.slice((safePage-1)*TABLE_PAGE_SIZE,safePage*TABLE_PAGE_SIZE);

  const top8=sorted.slice(0,8);
  const chartData=top8.map((r,i)=>({
    name:String(r['Campaign Name']||'').slice(0,20),
    orders:+r['Orders']||0,
    air:+r['Air Orders']||0,
    attach:(+r['Attach Rate']||0)*100,
    revenue:+r['Order Revenue']||0,
    color:COLORS[i%COLORS.length],
  }));

  const kpis=totalRow?[
    {label:'Total Orders',   value:fmtNum(totalRow['Orders']),       color:'var(--accent)'},
    {label:'Air Orders',     value:fmtNum(totalRow['Air Orders']),    color:'var(--accent2)'},
    {label:L.attachRate,    value:fmtPct(totalRow['Attach Rate']),   color:'var(--teal)'},
    {label:L.newSubs,       value:fmtNum(totalRow['New Subs']),      color:'var(--success)'},
    {label:'Order sales',  value:fmt$(totalRow['Order Revenue']),   color:'var(--warn)'},
    {label:'Campaigns',      value:fmtNum(dataRows.length),           color:'var(--text2)'},
  ]:[];

  function handleSort(col){
    if(sortCol===col) setSortDir(d=>-d);
    else{setSortCol(col);setSortDir(-1);}
  }

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageIntro title="Facebook campaigns" desc="Orders, Air add-ons, trial-to-paid rate, and sales by Facebook campaign." />

      {kpis.length>0&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))',gap:14}}>
          {kpis.map(k=>(
            <div key={k.label} style={{...CARD,position:'relative',overflow:'hidden'}}>
              <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:k.color,borderRadius:'3px 3px 0 0'}}/>
              <div style={{fontSize:11,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.7px',marginBottom:8}}>{k.label}</div>
              <div style={{...TH,fontSize:20,fontWeight:800}}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="Top 8 Campaigns by Orders">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} layout="vertical" barGap={3}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis dataKey="name" type="category" tick={{fontSize:9,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={120}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                <Bar dataKey="orders" name="Orders"     fill="rgba(79,142,247,.35)" radius={[0,2,2,0]}/>
                <Bar dataKey="air"    name="Air Orders" fill="#4f8ef7"              radius={[0,2,2,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title={`${L.attachRate} by campaign`}>
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} layout="vertical" barSize={18}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%"/>
                <YAxis dataKey="name" type="category" tick={{fontSize:9,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={120}/>
                <Tooltip formatter={fmtPct} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="attach" name={L.attachRate} radius={[0,4,4,0]}>
                  {chartData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <Section title={`All Campaigns (${dataRows.length})`}>
        <div style={{marginBottom:10}}>
          <TableFilterBar
            headers={COLS}
            searchColumn={searchColumn}
            onSearchColumnChange={(col)=>{setSearchColumn(col);setPage(1);}}
            search={search}
            onSearchChange={(v)=>{setSearch(v);setPage(1);}}
          />
        </div>
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead style={{position:'sticky',top:0,zIndex:1}}>
                <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                  {COLS.map((h,i)=>(
                    <th key={h} onClick={i>0?()=>handleSort(h):undefined}
                      style={{padding:'10px 12px',textAlign:i===0?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:11,whiteSpace:'nowrap',cursor:i>0?'pointer':'default',userSelect:'none'}}>
                      {plainHeader(h)}{sortCol===h?(sortDir<0?' ↓':' ↑'):''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r,i)=>(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                    <td style={{padding:'8px 12px',maxWidth:260,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontSize:12}}>{r['Campaign Name']}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Orders'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Air Orders'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--teal)'}}>{fmtPct(r['Attach Rate'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['New Subs'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--accent)'}}>{fmtPct(r['Sub TTP%'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)',color:'var(--success)'}}>{fmt$(r['Order Revenue'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Adsets'])}</td>
                    <td style={{padding:'8px 12px',textAlign:'right',fontFamily:'var(--font-mono)'}}>{fmtNum(r['Unique Ads'])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination
            page={safePage}
            pageSize={TABLE_PAGE_SIZE}
            totalRows={sorted.length}
            onPageChange={setPage}
          />
        </div>
      </Section>
    </div>
  );
}

function Section({title,children}){return <div><div style={{fontSize:13,fontWeight:600,color:'var(--text2)',marginBottom:12,display:'flex',alignItems:'center',gap:8}}><span style={{width:3,height:14,background:'var(--accent)',borderRadius:2,display:'inline-block'}}/>{title}</div>{children}</div>;}
function Loader(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Empty(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>No data available</div>;}
