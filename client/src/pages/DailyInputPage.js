import React,{useState,useEffect} from 'react';
import {getTab,fmt$,fmtPct,fmtNum,fmtDate} from '../utils/api';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ResponsiveContainer,LineChart,Line} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};

// All columns and how to format/display them
const ALL_COLS=[
  {key:'Date',           label:'Date',              fmt:'date',   align:'left',  sticky:true},
  {key:'Total Orders',   label:'Total Orders',       fmt:'num',    align:'right'},
  {key:'Air Orders',     label:'Air Orders',         fmt:'num',    align:'right', color:'var(--accent)'},
  {key:'Attach Rate',    label:'Attach %',           fmt:'pct',    align:'right', color:'var(--teal)'},
  {key:'TTP Rate',       label:'TTP %',              fmt:'pct',    align:'right', color:'var(--accent2)'},
  {key:'Activation Rate',label:'Activation %',       fmt:'pct',    align:'right', color:'var(--warn)'},
  {key:'$0 Air Orders',  label:'$0 Air',             fmt:'num',    align:'right'},
  {key:'Paid Air Orders',label:'Paid Air',           fmt:'num',    align:'right'},
  {key:'Same-Day Cancel',label:'Same-Day Cancel',    fmt:'num',    align:'right', color:'var(--danger)'},
  {key:'Tag Gross',      label:'Tag Gross',          fmt:'$',      align:'right'},
  {key:'Tag Discounts',  label:'Tag Discounts',      fmt:'$',      align:'right'},
  {key:'Tag Net Sales',  label:'Tag Net Sales',      fmt:'$',      align:'right'},
  {key:'Tag Refunds',    label:'Tag Refunds',        fmt:'$',      align:'right', color:'var(--danger)'},
  {key:'Sub Gross',      label:'Sub Gross',          fmt:'$',      align:'right'},
  {key:'Sub Discounts',  label:'Sub Discounts',      fmt:'$',      align:'right'},
  {key:'Sub Net Sales',  label:'Sub Net Sales',      fmt:'$',      align:'right'},
  {key:'Sub Refunds',    label:'Sub Refunds',        fmt:'$',      align:'right', color:'var(--danger)'},
  {key:'Rebill Revenue', label:'Rebill Revenue',     fmt:'$',      align:'right', color:'var(--success)'},
  {key:'New Sub Revenue',label:'New Sub Revenue',    fmt:'$',      align:'right'},
  {key:'Combined Gross', label:'Combined Gross',     fmt:'$',      align:'right'},
  {key:'Combined Net Sales',label:'Combined Net Sales',fmt:'$',   align:'right'},
  {key:'Combined Net Revenue',label:'Combined Net Rev',fmt:'$',   align:'right', color:'var(--success)'},
  {key:'New $79',        label:'New $79',            fmt:'num',    align:'right'},
  {key:'New $99',        label:'New $99',            fmt:'num',    align:'right'},
  {key:'New $119',       label:'New $119',           fmt:'num',    align:'right'},
  {key:'New $129',       label:'New $129',           fmt:'num',    align:'right'},
  {key:'New $139',       label:'New $139',           fmt:'num',    align:'right'},
  {key:'New $149',       label:'New $149',           fmt:'num',    align:'right'},
  {key:'Rebill $79',     label:'Rebill $79',         fmt:'num',    align:'right'},
  {key:'Rebill $99',     label:'Rebill $99',         fmt:'num',    align:'right'},
  {key:'Rebill $119',    label:'Rebill $119',        fmt:'num',    align:'right'},
  {key:'Rebill $129',    label:'Rebill $129',        fmt:'num',    align:'right'},
  {key:'Rebill $139',    label:'Rebill $139',        fmt:'num',    align:'right'},
  {key:'Rebill $149',    label:'Rebill $149',        fmt:'num',    align:'right'},
];

function fmtCell(val,type){
  if(val===''||val===null||val===undefined) return '—';
  switch(type){
    case 'date': return fmtDate(val);
    case 'pct':  return fmtPct(val);
    case '$':    return fmt$(val);
    case 'num':  return fmtNum(val);
    default:     return String(val);
  }
}

// Column groups for visual separators
const COL_GROUPS=[
  {label:'Core',      keys:['Date','Total Orders','Air Orders','Attach Rate','TTP Rate','Activation Rate','$0 Air Orders','Paid Air Orders','Same-Day Cancel']},
  {label:'Tag',       keys:['Tag Gross','Tag Discounts','Tag Net Sales','Tag Refunds']},
  {label:'Sub',       keys:['Sub Gross','Sub Discounts','Sub Net Sales','Sub Refunds']},
  {label:'Combined',  keys:['Rebill Revenue','New Sub Revenue','Combined Gross','Combined Net Sales','Combined Net Revenue']},
  {label:'New Subs',  keys:['New $79','New $99','New $119','New $129','New $139','New $149']},
  {label:'Rebills',   keys:['Rebill $79','Rebill $99','Rebill $119','Rebill $129','Rebill $139','Rebill $149']},
];

export default function DailyInputPage(){
  const [allRows,setAllRows]=useState([]);
  const [headers,setHeaders]=useState([]);
  const [loading,setLoading]=useState(true);
  const [colFilter,setColFilter]=useState('All');

  useEffect(()=>{
    getTab('Daily Input').then(d=>{
      setAllRows(d.rows||[]);
      setHeaders(d.headers||[]);
    }).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!allRows.length) return <Empty/>;

  const totalRow=allRows.find(r=>String(r['Date']||'').toUpperCase()==='TOTAL');
  const dataRows=allRows.filter(r=>String(r['Date']||'').toUpperCase()!=='TOTAL'&&r['Date']);

  // Pick which columns to show
  const activeGroup=COL_GROUPS.find(g=>g.label===colFilter);
  const visibleCols=colFilter==='All'
    ? ALL_COLS.filter(c=>headers.includes(c.key)||c.key==='Date')
    : ALL_COLS.filter(c=>activeGroup?.keys.includes(c.key));

  // Chart data — current month-to-date
  const now=new Date();
  const currentMonthRows=dataRows.filter(r=>{
    const d=new Date(r['Date']);
    return !isNaN(d) && d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
  });
  const recent=currentMonthRows.length ? currentMonthRows : dataRows.slice(-30);
  const chartData=recent.map(r=>({
    date:fmtDate(r['Date']),
    orders:+r['Total Orders']||0,
    air:+r['Air Orders']||0,
    attach:((+r['Attach Rate']||0)*100),
    revenue:+r['Combined Net Revenue']||0,
  }));

  // Summary KPIs from TOTAL row
  const T=totalRow||{};
  const kpis=[
    {label:'Total Orders',        value:fmtNum(T['Total Orders']),         color:'var(--accent)'},
    {label:'Air Orders',          value:fmtNum(T['Air Orders']),            color:'var(--accent2)'},
    {label:'Attach Rate',         value:fmtPct(T['Attach Rate']),           color:'var(--teal)'},
    {label:'TTP Rate',            value:fmtPct(T['TTP Rate']),              color:'var(--accent2)'},
    {label:'Activation Rate',     value:fmtPct(T['Activation Rate']),       color:'var(--warn)'},
    {label:'Same-Day Cancel',     value:fmtNum(T['Same-Day Cancel']),       color:'var(--danger)'},
    {label:'Combined Net Rev',    value:fmt$(T['Combined Net Revenue']),     color:'var(--success)'},
    {label:'Rebill Revenue',      value:fmt$(T['Rebill Revenue']),           color:'var(--success)'},
    {label:'New Sub Revenue',     value:fmt$(T['New Sub Revenue']),          color:'var(--text2)'},
    {label:'Tag Net Sales',       value:fmt$(T['Tag Net Sales']),            color:'var(--text2)'},
  ];

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageHead title="Daily Input" desc={`${dataRows.length} days of data · all columns from the sheet`}/>

      {/* KPI Strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(155px,1fr))',gap:12}}>
        {kpis.map(k=>(
          <div key={k.label} style={{...CARD,position:'relative',overflow:'hidden',padding:'14px 16px'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:k.color,borderRadius:'3px 3px 0 0'}}/>
            <div style={{fontSize:10,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.7px',marginBottom:6}}>{k.label}</div>
            <div style={{...TH,fontSize:20,fontWeight:800,lineHeight:1.1}}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:20}}>
        <Section title="Orders (Current Month)">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.05)"/>
                <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} interval={4}/>
                <YAxis tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                <Bar dataKey="orders" name="Total Orders" fill="rgba(79,142,247,.3)" radius={[2,2,0,0]}/>
                <Bar dataKey="air"    name="Air Orders"   fill="#4f8ef7"             radius={[2,2,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Attach Rate (Current Month)">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.05)"/>
                <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} interval={4}/>
                <YAxis tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} unit="%" tickFormatter={v=>v.toFixed(0)}/>
                <Tooltip formatter={v=>`${v.toFixed(1)}%`} contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Line type="monotone" dataKey="attach" name="Attach %" stroke="var(--teal)" strokeWidth={2} dot={false}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      {/* Full Data Table */}
      <Section title={`Full Daily Data — ${dataRows.length} rows × ${visibleCols.length} columns`}>
        {/* Column group filter */}
        <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap'}}>
          {['All',...COL_GROUPS.map(g=>g.label)].map(g=>(
            <button key={g} onClick={()=>setColFilter(g)}
              style={{padding:'4px 12px',borderRadius:20,border:'1px solid var(--border2)',background:colFilter===g?'var(--accent)':'transparent',color:colFilter===g?'#fff':'var(--text2)',fontSize:11,cursor:'pointer',fontWeight:colFilter===g?600:400,transition:'all .12s'}}>
              {g}
            </button>
          ))}
        </div>

        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <div style={{overflowX:'auto',maxHeight:520,overflowY:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
              <thead style={{position:'sticky',top:0,zIndex:2}}>
                <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                  {visibleCols.map(c=>(
                    <th key={c.key} style={{
                      padding:'9px 12px',
                      textAlign:c.align,
                      color:'var(--text2)',
                      fontWeight:600,
                      fontSize:11,
                      whiteSpace:'nowrap',
                      position:c.sticky?'sticky':'static',
                      left:c.sticky?0:undefined,
                      background:c.sticky?'var(--bg4)':undefined,
                      zIndex:c.sticky?3:undefined,
                    }}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataRows.slice().reverse().map((r,i)=>(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.035)',background:i%2===1?'rgba(255,255,255,.012)':'transparent'}}>
                    {visibleCols.map(c=>{
                      const val=r[c.key];
                      const display=fmtCell(val,c.fmt);
                      const isEmpty=val===''||val===null||val===undefined||val===0;
                      return(
                        <td key={c.key} style={{
                          padding:'7px 12px',
                          textAlign:c.align,
                          fontFamily:c.fmt!=='date'?'var(--font-mono)':'inherit',
                          color:isEmpty&&c.fmt!=='date'?'var(--text3)':c.color||'var(--text)',
                          whiteSpace:'nowrap',
                          position:c.sticky?'sticky':'static',
                          left:c.sticky?0:undefined,
                          background:c.sticky?(i%2===1?'var(--bg3)':'#181d2c'):undefined,
                          fontWeight:c.key==='Date'?500:400,
                        }}>{display}</td>
                      );
                    })}
                  </tr>
                ))}
                {/* TOTAL row */}
                {totalRow&&(
                  <tr style={{borderTop:'2px solid var(--border2)',background:'rgba(79,142,247,.07)'}}>
                    {visibleCols.map(c=>(
                      <td key={c.key} style={{
                        padding:'9px 12px',
                        textAlign:c.align,
                        fontFamily:c.fmt!=='date'?'var(--font-mono)':'inherit',
                        fontWeight:700,
                        color:c.key==='Date'?'var(--accent)':c.color||'var(--text)',
                        whiteSpace:'nowrap',
                        position:c.sticky?'sticky':'static',
                        left:c.sticky?0:undefined,
                        background:c.sticky?'rgba(15,20,40,1)':undefined,
                      }}>
                        {c.key==='Date'?'TOTAL':fmtCell(totalRow[c.key],c.fmt)}
                      </td>
                    ))}
                  </tr>
                )}
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
