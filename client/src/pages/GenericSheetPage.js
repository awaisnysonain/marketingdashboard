import React,{useState,useEffect,useMemo,useCallback} from 'react';
import {getTab,fmt$,fmtPct,fmtNum,fmtDate} from '../utils/api';
import AiInsights from '../components/AiInsights';
import SelectionBar from '../components/SelectionBar';
import TableFilterBar from '../components/TableFilterBar';
import { SEARCH_ALL_COLUMNS } from '../constants/tableSearch';
import { filterTableRows } from '../utils/tableFilterSort';
import {
  AreaChart,Area,BarChart,Bar,LineChart,Line,
  XAxis,YAxis,CartesianGrid,Tooltip,Legend,
  ResponsiveContainer,ReferenceLine
} from 'recharts';

// ── Palette ───────────────────────────────────────────────────────
const COLORS=['var(--accent)','var(--teal)','var(--success)','var(--warn)','var(--accent2)','#a78bfa','#fb923c','#38bdf8'];
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;

// ── Column type detection ─────────────────────────────────────────
const PCT_K =['rate','%','pct','ratio','conv','activation','attach'];
const MONEY_K=['revenue','gross','net','sales','refund','discount','price','amount','cost','rev','ltv','arpu'];
const NUM_K =['orders','count','qty','quantity','volume','subs','sessions','clicks','impressions',
              'trials','paid','new','rebill','customers','users','visits','views','leads','days'];

function colType(key){
  const k=String(key).toLowerCase();
  if(k==='date'||k==='week'||k==='day'||k.includes('week (')|| k==='cohort week') return 'date';
  if(PCT_K.some(p=>k.includes(p))) return 'pct';
  if(MONEY_K.some(p=>k.includes(p))) return '$';
  if(NUM_K.some(p=>k.includes(p))) return 'num';
  return 'text';
}

function isNumeric(key,rows){
  const t=colType(key);
  if(t==='pct'||t==='$'||t==='num') return true;
  const sample=rows.slice(0,15).map(r=>r[key]).filter(v=>v!==''&&v!=null);
  if(!sample.length) return false;
  return sample.filter(v=>!isNaN(parseFloat(v))).length/sample.length>0.7;
}

function fmtCell(val,key){
  if(val===''||val===null||val===undefined) return '—';
  const s=String(val);
  if(s.toUpperCase()==='TOTAL'||s==='Total') return s;
  const t=colType(key);
  if(t==='date'&&DATE_RE.test(s)) return fmtDate(val);
  if(t==='pct') return fmtPct(val);
  if(t==='$') return fmt$(val);
  if(t==='num') return fmtNum(val);
  if(DATE_RE.test(s)) return fmtDate(val);
  const n=parseFloat(val);
  if(!isNaN(n)&&s.trim().replace(',','').match(/^-?[\d.]+$/)){
    if(Math.abs(n)<=1.5&&n!==0&&n!==1&&s.includes('.')) return fmtPct(n);
    if(n>999||n<-999) return fmtNum(n);
    if(!Number.isInteger(n)) return n.toLocaleString(undefined,{maximumFractionDigits:2});
    return fmtNum(n);
  }
  return s;
}

// ── Shape detection ───────────────────────────────────────────────
function detectShape(headers,rows){
  const vis=headers.filter(h=>h&&!h.startsWith('_'));
  if(!vis.length||!rows.length) return {type:'raw',numCols:[],vis};

  const dateCol=vis.find(h=>{
    if(colType(h)!=='date') return false;
    return rows.slice(0,8).map(r=>r[h]).some(v=>v&&DATE_RE.test(String(v)));
  });

  const numCols=vis.filter(h=>h!==dateCol&&isNumeric(h,rows));
  const textCols=vis.filter(h=>h!==dateCol&&!numCols.includes(h));

  // Key-Value sheet (e.g. Summary): 2-4 cols, first is label, rest are values
  if(vis.length<=4&&textCols.length===1&&numCols.length>=1&&rows.length>=3){
    return {type:'kv',vis,labelCol:textCols[0],valueCols:numCols,dateCol,numCols};
  }

  // Time series: has a date column + numeric columns
  if(dateCol&&numCols.length>0){
    return {type:'timeseries',vis,dateCol,numCols,textCols};
  }

  // Categorical: first text col is category, rest are numbers
  if(textCols.length>=1&&numCols.length>=1){
    return {type:'categorical',vis,categoryCol:textCols[0],numCols,textCols};
  }

  return {type:'raw',vis,numCols};
}

// ── Total row detector ─────────────────────────────────────────────
function isTotalRow(row,vis){
  return vis.slice(0,3).some(h=>{
    const v=String(row[h]||'').trim().toUpperCase();
    return v==='TOTAL'||v==='TOTALS'||v==='GRAND TOTAL'||v==='ALL';
  });
}

// ── Chart column picker ────────────────────────────────────────────
function pickChartCols(numCols){
  const pct=numCols.filter(h=>colType(h)==='pct');
  const dol=numCols.filter(h=>colType(h)==='$');
  const num=numCols.filter(h=>colType(h)==='num');
  // Prefer: a few % cols, then $, then counts — but max 4
  return [...pct.slice(0,3),...dol.slice(0,2),...num.slice(0,2)].slice(0,4);
}

// ── Custom tooltip ─────────────────────────────────────────────────
function ChartTooltip({active,payload,label}){
  if(!active||!payload?.length) return null;
  return(
    <div style={{background:'var(--bg2)',border:'1px solid var(--border2)',borderRadius:9,padding:'10px 14px',fontSize:12,boxShadow:'var(--shadow)'}}>
      <div style={{fontWeight:600,marginBottom:6,color:'var(--text2)'}}>{label}</div>
      {payload.map((p,i)=>(
        <div key={i} style={{display:'flex',justifyContent:'space-between',gap:16,color:p.color,marginBottom:2}}>
          <span style={{color:'var(--text3)'}}>{p.dataKey}</span>
          <span style={{fontFamily:'var(--font-mono)',fontWeight:600}}>{
            colType(p.dataKey)==='pct'?`${Number(p.value).toFixed(1)}%`:
            colType(p.dataKey)==='$'?fmt$(p.value):
            fmtNum(p.value)
          }</span>
        </div>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────
export default function GenericSheetPage({tabName}){
  const [rawData,setRawData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [search,setSearch]=useState('');
  const [searchColumn,setSearchColumn]=useState(SEARCH_ALL_COLUMNS);
  const [page,setPage]=useState(0);
  const [selCols,setSelCols]=useState(null);
  const [selectedRows,setSelectedRows]=useState([]);
  const PER_PAGE=20; // matches TABLE_PAGE_SIZE

  useEffect(()=>{
    setLoading(true);
    setSearch(''); setSearchColumn(SEARCH_ALL_COLUMNS); setPage(0); setSelCols(null); setSelectedRows([]);
    getTab(tabName).then(d=>setRawData(d)).catch(()=>setRawData(null)).finally(()=>setLoading(false));
  },[tabName]);

  const toggleRow=useCallback((row)=>{
    setSelectedRows(prev=>prev.includes(row)?prev.filter(r=>r!==row):[...prev,row]);
  },[]);

  const toggleAll=useCallback((rows)=>{
    setSelectedRows(prev=>prev.length===rows.length?[]:rows);
  },[]);

  // ── ALL hooks must be unconditional — no early returns before this block ──
  const shape=useMemo(()=>rawData?detectShape(rawData.headers||[],rawData.rows||[]):null,[rawData]);
  const allChartCols=useMemo(()=>shape?.numCols?pickChartCols(shape.numCols):[],[shape]);
  const activeCols=selCols||(allChartCols.length?allChartCols.slice(0,3):[]);

  // Split total row from data rows (must be useMemo so chartData can depend on dataRows stably)
  const {vis,totalRow,dataRows}=useMemo(()=>{
    if(!rawData?.rows?.length) return {vis:[],totalRow:null,dataRows:[]};
    const v=(shape?.vis)||[];
    const tot=rawData.rows.find(r=>isTotalRow(r,v));
    const dr=rawData.rows.filter(r=>r!==tot);
    return {vis:v,totalRow:tot,dataRows:dr};
  },[rawData,shape]);

  // Chart data — depends on dataRows, must be a hook, hoisted before early returns
  const chartData=useMemo(()=>{
    if(!shape||!activeCols.length||!dataRows.length) return [];
    const col=shape.dateCol||shape.categoryCol;
    if(!col) return [];
    return dataRows
      .filter(r=>{const v=r[col];return v&&String(v).toUpperCase()!=='TOTAL';})
      .map(r=>{
        const obj={label:shape.dateCol?fmtDate(r[col]):String(r[col]||'')};
        activeCols.forEach(c=>{
          const v=parseFloat(r[c]);
          const t=colType(c);
          obj[c]=isNaN(v)?0:(t==='pct'&&Math.abs(v)<=1.5?v*100:v);
        });
        return obj;
      });
  },[dataRows,activeCols,shape]);

  // ── Early returns (after all hooks) ───────────────────────────────
  if(loading) return <Loader/>;
  if(!rawData||!rawData.rows?.length) return <Empty tabName={tabName}/>;

  // ── Plain JS (no hooks allowed below) ────────────────────────────
  const filtered=search ? filterTableRows(dataRows, vis, search, searchColumn) : dataRows;
  const totalPages=Math.ceil(filtered.length/PER_PAGE);
  const pageRows=filtered.slice(page*PER_PAGE,(page+1)*PER_PAGE);

  const kpiSource=totalRow||dataRows[dataRows.length-1];
  const kpiCols=shape?.numCols?.slice(0,6)||[];

  const shapeLabel=shape.type==='timeseries'?'Time series':shape.type==='categorical'?'Category breakdown':shape.type==='kv'?'Key-value':'Data table';

  return(
    <div style={{display:'flex',flexDirection:'column',gap:24}}>

      {/* ── Page header ──────────────────────────────────────────── */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',flexWrap:'wrap',gap:12}}>
        <div>
          <h1 style={{fontFamily:'var(--font-head)',fontSize:22,fontWeight:800,marginBottom:4}}>{tabName}</h1>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <span style={{color:'var(--text3)',fontSize:13}}>{dataRows.length.toLocaleString()} rows · {vis.length} columns</span>
            <span style={{fontSize:10,fontWeight:600,padding:'2px 7px',borderRadius:20,background:'var(--accent-dim)',color:'var(--accent)',textTransform:'uppercase',letterSpacing:'.6px'}}>{shapeLabel}</span>
          </div>
        </div>
        <TableFilterBar
          headers={vis}
          searchColumn={searchColumn}
          onSearchColumnChange={(col)=>{setSearchColumn(col);setPage(0);}}
          search={search}
          onSearchChange={(v)=>{setSearch(v);setPage(0);}}
        />
      </div>

      {/* ── AI Insights ──────────────────────────────────────────── */}
      <AiInsights tab={tabName} headers={rawData?.headers||[]} rows={rawData?.rows||[]}/>

      {/* ── KPI Cards ────────────────────────────────────────────── */}
      {kpiCols.length>0&&kpiSource&&(
        <Section title={totalRow?'Totals / Averages':'Latest Row'}>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(148px,1fr))',gap:12}}>
            {kpiCols.map((col,i)=>{
              const val=kpiSource[col];
              const t=colType(col);
              const color=t==='pct'?'var(--teal)':t==='$'?'var(--success)':COLORS[i%COLORS.length];
              return <KpiCard key={col} label={col} value={fmtCell(val,col)} color={color}/>;
            })}
          </div>
        </Section>
      )}

      {/* ── Chart ────────────────────────────────────────────────── */}
      {chartData.length>1&&activeCols.length>0&&(
        <Section title={shape.type==='timeseries'?'Trend Over Time':'Comparison Chart'}>
          {/* Column toggles */}
          {allChartCols.length>1&&(
            <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:14}}>
              {allChartCols.map((col,i)=>{
                const on=activeCols.includes(col);
                const c=COLORS[i%COLORS.length];
                return(
                  <button key={col} onClick={()=>setSelCols(prev=>{
                    const cur=prev||allChartCols.slice(0,3);
                    if(on&&cur.length>1) return cur.filter(c=>c!==col);
                    if(!on) return [...cur,col];
                    return cur;
                  })}
                    style={{fontSize:11,padding:'3px 11px',borderRadius:20,border:`1px solid ${on?c:'var(--border2)'}`,background:on?`${c}22`:'transparent',color:on?c:'var(--text3)',cursor:'pointer',fontWeight:on?600:400,transition:'all .15s',fontFamily:'var(--font-body)'}}>
                    {col}
                  </button>
                );
              })}
            </div>
          )}
          <div style={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,padding:'16px 8px 8px'}}>
            <ResponsiveContainer width="100%" height={240}>
              {shape.type==='categorical'?(
                <BarChart data={chartData} margin={{left:4,right:8,bottom:allChartCols.length>6?30:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.05)" vertical={false}/>
                  <XAxis dataKey="label" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}
                    interval={chartData.length>12?Math.floor(chartData.length/12):0}
                    angle={chartData.length>8?-30:0} textAnchor={chartData.length>8?'end':'middle'} height={chartData.length>8?44:24}/>
                  <YAxis tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} width={50}/>
                  <Tooltip content={<ChartTooltip/>}/>
                  {activeCols.length>1&&<Legend wrapperStyle={{fontSize:11,paddingTop:8}}/>}
                  {activeCols.map((col,i)=>(
                    <Bar key={col} dataKey={col} fill={COLORS[i%COLORS.length]} radius={[3,3,0,0]} maxBarSize={40}/>
                  ))}
                </BarChart>
              ):(
                <AreaChart data={chartData} margin={{left:4,right:8}}>
                  <defs>
                    {activeCols.map((col,i)=>(
                      <linearGradient key={col} id={`grad${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={COLORS[i%COLORS.length]} stopOpacity={0.2}/>
                        <stop offset="95%" stopColor={COLORS[i%COLORS.length]} stopOpacity={0}/>
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.05)" vertical={false}/>
                  <XAxis dataKey="label" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}
                    interval={Math.max(1,Math.floor(chartData.length/9))}/>
                  <YAxis tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false} width={50}/>
                  <Tooltip content={<ChartTooltip/>}/>
                  {activeCols.length>1&&<Legend wrapperStyle={{fontSize:11,paddingTop:8}}/>}
                  {activeCols.map((col,i)=>(
                    <Area key={col} type="monotone" dataKey={col}
                      stroke={COLORS[i%COLORS.length]} fill={`url(#grad${i})`}
                      strokeWidth={2} dot={false} activeDot={{r:4}}/>
                  ))}
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* ── Data Table ───────────────────────────────────────────── */}
      <Section title={`Data${selectedRows.length>0?` · ${selectedRows.length} selected`:''}`}>
        <div style={{background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:12,overflow:'hidden'}}>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
              <thead style={{position:'sticky',top:0,zIndex:2}}>
                <tr style={{background:'var(--bg4)',borderBottom:'2px solid var(--border2)'}}>
                  {/* Select-all checkbox */}
                  <th style={{padding:'9px 10px 9px 14px',width:32,borderRight:'1px solid rgba(255,255,255,.04)'}}>
                    <input type="checkbox"
                      checked={pageRows.length>0&&pageRows.every(r=>selectedRows.includes(r))}
                      onChange={()=>toggleAll(pageRows)}
                      style={{cursor:'pointer',accentColor:'var(--accent)',width:14,height:14}}/>
                  </th>
                  {vis.map(h=>{
                    const t=colType(h);
                    const isNum=t==='pct'||t==='$'||t==='num';
                    const typeHint=t==='pct'?'%':t==='$'?'$':t==='date'?'date':t==='num'?'#':'';
                    return(
                      <th key={h} style={{padding:'9px 14px',textAlign:isNum?'right':'left',
                        color:'var(--text2)',fontWeight:600,fontSize:11,whiteSpace:'nowrap',
                        borderRight:'1px solid rgba(255,255,255,.04)'}}>
                        <span>{h}</span>
                        {typeHint&&<span style={{marginLeft:4,fontSize:9,opacity:.5,fontWeight:400}}>{typeHint}</span>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r,i)=>{
                  const isTotal=isTotalRow(r,vis);
                  const isSel=selectedRows.includes(r);
                  return(
                    <tr key={i}
                      style={{borderBottom:'1px solid var(--border)',
                        background:isSel?'rgba(59,130,246,.12)':isTotal?'rgba(59,130,246,.07)':i%2===1?'rgba(255,255,255,.016)':'transparent',
                        transition:'background .1s',fontWeight:isTotal?700:400,
                        outline:isSel?'1px solid rgba(59,130,246,.3)':undefined}}
                      onMouseEnter={e=>{if(!isTotal&&!isSel)e.currentTarget.style.background='var(--accent-dim)';}}
                      onMouseLeave={e=>{e.currentTarget.style.background=isSel?'rgba(59,130,246,.12)':isTotal?'rgba(59,130,246,.07)':i%2===1?'rgba(255,255,255,.016)':'transparent';}}>
                      <td style={{padding:'7px 10px 7px 14px',width:32,borderRight:'1px solid rgba(255,255,255,.03)'}}>
                        {!isTotal&&<input type="checkbox" checked={isSel} onChange={()=>toggleRow(r)}
                          style={{cursor:'pointer',accentColor:'var(--accent)',width:14,height:14}}/>}
                      </td>
                      {vis.map(h=>{
                        const v=r[h];
                        const t=colType(h);
                        const isNum=t==='pct'||t==='$'||t==='num';
                        const isEmpty=v===''||v===null||v===undefined;
                        const textColor=isEmpty?'var(--text3)':
                          isTotal?(t==='pct'?'var(--teal)':t==='$'?'var(--success)':'var(--accent)'):
                          t==='pct'?'var(--teal)':t==='$'?'var(--success)':'var(--text)';
                        return(
                          <td key={h} style={{padding:'7px 14px',
                            fontFamily:isNum?'var(--font-mono)':'var(--font-body)',
                            textAlign:isNum?'right':'left',
                            color:textColor,
                            whiteSpace:'nowrap',maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',
                            borderRight:'1px solid rgba(255,255,255,.03)'}}>
                            {fmtCell(v,h)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
              {/* Pinned TOTAL row */}
              {totalRow&&!search&&(
                <tfoot>
                  <tr style={{borderTop:'2px solid var(--border2)',background:'rgba(59,130,246,.1)',fontWeight:700,position:'sticky',bottom:0}}>
                    {vis.map(h=>{
                      const v=totalRow[h];
                      const t=colType(h);
                      const isNum=t==='pct'||t==='$'||t==='num';
                      return(
                        <td key={h} style={{padding:'8px 14px',
                          fontFamily:isNum?'var(--font-mono)':'var(--font-body)',
                          textAlign:isNum?'right':'left',
                          color:t==='pct'?'var(--teal)':t==='$'?'var(--success)':'var(--accent)',
                          whiteSpace:'nowrap',borderRight:'1px solid rgba(255,255,255,.04)'}}>
                          {fmtCell(v,h)}
                        </td>
                      );
                    })}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Pagination */}
          {totalPages>1&&(
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 16px',borderTop:'1px solid var(--border)',background:'var(--bg3)'}}>
              <span style={{fontSize:12,color:'var(--text3)'}}>
                {filtered.length.toLocaleString()} rows · page {page+1} of {totalPages}
              </span>
              <div style={{display:'flex',gap:5}}>
                {[['«',()=>setPage(0)],['‹',()=>setPage(p=>p-1)],['›',()=>setPage(p=>p+1)],['»',()=>setPage(totalPages-1)]].map(([label,fn],i)=>{
                  const disabled=(i<2&&page===0)||(i>=2&&page>=totalPages-1);
                  return(
                    <button key={label} onClick={fn} disabled={disabled}
                      style={{padding:'4px 10px',borderRadius:6,border:'1px solid var(--border2)',background:'transparent',
                        color:disabled?'var(--text3)':'var(--text2)',fontSize:13,cursor:disabled?'default':'pointer',opacity:disabled?.35:1}}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* ── Selection Calculator ─────────────────────────────────── */}
      <SelectionBar selectedRows={selectedRows} headers={vis} onClear={()=>setSelectedRows([])}/>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────
function KpiCard({label,value,color}){
  return(
    <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:12,padding:'14px 16px',position:'relative',overflow:'hidden'}}>
      <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:color,borderRadius:'3px 3px 0 0'}}/>
      <div style={{fontSize:10,fontWeight:700,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.7px',marginBottom:7,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{label}</div>
      <div style={{fontSize:22,fontWeight:800,fontFamily:'var(--font-head)',lineHeight:1,color:color}}>{value}</div>
    </div>
  );
}

function Section({title,children}){
  return(
    <div>
      <div style={{fontSize:12,fontWeight:700,color:'var(--text2)',marginBottom:12,display:'flex',alignItems:'center',gap:8,textTransform:'uppercase',letterSpacing:'.6px'}}>
        <span style={{width:3,height:13,background:'var(--accent)',borderRadius:2,display:'inline-block',flexShrink:0}}/>
        {title}
      </div>
      {children}
    </div>
  );
}

function Loader(){
  return(
    <div style={{padding:80,textAlign:'center'}}>
      <div style={{width:28,height:28,border:'2px solid var(--border2)',borderTopColor:'var(--accent)',borderRadius:'50%',animation:'spin .8s linear infinite',margin:'0 auto 12px'}}/>
      <p style={{color:'var(--text3)',fontSize:13}}>Loading…</p>
    </div>
  );
}
function Empty({tabName}){
  return(
    <div style={{padding:80,textAlign:'center',color:'var(--text3)'}}>
      <p style={{fontSize:14}}>No data found in "{tabName}"</p>
    </div>
  );
}
