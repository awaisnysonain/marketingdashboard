import React,{useState,useEffect} from 'react';
import {BarChart,Bar,XAxis,YAxis,Tooltip,ResponsiveContainer,CartesianGrid} from 'recharts';
import {getTab,fmt$,fmtPct,fmtNum} from '../utils/api';
import ChartCard from '../components/ChartCard';

const TT={background:'#1e2438',border:'1px solid rgba(255,255,255,.12)',borderRadius:8,fontSize:12,color:'#edf0f7'};

export default function ForecastPage(){
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);

  useEffect(()=>{
    getTab('Revenue Forcast').then(setData).catch(e=>setError(String(e))).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(error) return <Err msg={error}/>;
  if(!data||!data.rows?.length) return <Err msg="No forecast data available. Check the 'Revenue Forcast' sheet tab."/>;

  const rows=data.rows||[];
  const today=new Date();
  const currentMonth=today.toLocaleString('en-US',{month:'short'});
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const headers=data.headers||[];
  const monthHeader=headers[0]||'Month';
  const storeRevH=headers[1]||'Store Revenue';
  const ordersH=headers[2]||'Orders';
  const activationH=headers[3]||'Activation Rate';
  const estActH=headers[4]||'Est. Activations';
  const estAirH=headers[5]||'Est. Air Orders';
  const tagRevH=headers[6]||'Tag Rev (net est)';
  const subRevH=headers[7]||'Sub Rev (net est)';
  const totalAirH=headers[8]||'Total Air Rev (net est)';

  // Only keep rows where Month is a real month name or FULL YEAR
  const monthlyRows=rows.filter(r=>{
    const m=String(r[monthHeader]||'');
    return months.includes(m)||m==='FULL YEAR';
  });

  const chartData=monthlyRows.filter(r=>String(r[monthHeader])!=='FULL YEAR').map(r=>({
    month:String(r[monthHeader]),
    storeRevenue:parseFloat(r[storeRevH])||0,
    tagRev:parseFloat(r[tagRevH])||0,
    subRev:parseFloat(r[subRevH])||0,
    totalAirRev:parseFloat(r[totalAirH])||0,
  }));

  const fullYear=monthlyRows.find(r=>String(r[monthHeader])==='FULL YEAR');

  function rowStyle(r){
    const m=String(r[monthHeader]);
    if(m===currentMonth) return {background:'rgba(245,158,66,.1)',border:'1px solid rgba(245,158,66,.25)'};
    if(months.indexOf(m)<months.indexOf(currentMonth)&&m!=='FULL YEAR') return {background:'rgba(34,197,94,.07)'};
    if(m==='FULL YEAR') return {background:'rgba(79,142,247,.1)',fontWeight:600};
    return {};
  }

  return(
    <div>
      <h2 style={{fontFamily:'var(--font-head)',fontSize:18,fontWeight:700,marginBottom:20}}>Revenue Forecast 2026</h2>

      {fullYear&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:14,marginBottom:24}}>
          {[
            {label:'Full Year Est. Revenue',val:fmt$(fullYear[totalAirH]),color:'teal'},
            {label:'Est. Tag Revenue',val:fmt$(fullYear[tagRevH]),color:'blue'},
            {label:'Est. Sub Revenue',val:fmt$(fullYear[subRevH]),color:'purple'},
            {label:'Est. Air Orders',val:fmtNum(fullYear[estAirH]),color:'warn'},
          ].map(k=>(
            <div key={k.label} style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'16px 18px',position:'relative',overflow:'hidden'}}>
              <div style={{position:'absolute',top:0,left:0,right:0,height:2,background:`var(--${k.color==='teal'?'teal':k.color==='purple'?'accent2':k.color==='blue'?'accent':'warn'})`,borderRadius:'2px 2px 0 0'}}/>
              <div style={{fontSize:11,fontWeight:500,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.6px',marginBottom:8}}>{k.label}</div>
              <div style={{fontFamily:'var(--font-head)',fontSize:26,fontWeight:700}}>{k.val}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginBottom:18}}>
        <ChartCard title="Monthly Revenue Estimate" subtitle="Tag + Sub air revenue">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <CartesianGrid stroke="rgba(255,255,255,.04)" strokeDasharray="3 3"/>
              <XAxis dataKey="month" tick={{fill:'#4e5873',fontSize:11}} tickLine={false} axisLine={false}/>
              <YAxis tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false} tickFormatter={v=>fmt$(v)}/>
              <Tooltip contentStyle={TT} formatter={v=>[fmt$(v)]}/>
              <Bar dataKey="tagRev" stackId="a" fill="#4f8ef7" name="Tag Rev" radius={[0,0,0,0]}/>
              <Bar dataKey="subRev" stackId="a" fill="#7b5cf5" name="Sub Rev" radius={[2,2,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Store Revenue by Month" subtitle="Total Shopify store revenue">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <CartesianGrid stroke="rgba(255,255,255,.04)" strokeDasharray="3 3"/>
              <XAxis dataKey="month" tick={{fill:'#4e5873',fontSize:11}} tickLine={false} axisLine={false}/>
              <YAxis tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false} tickFormatter={v=>fmt$(v)}/>
              <Tooltip contentStyle={TT} formatter={v=>[fmt$(v),'Store Revenue']}/>
              <Bar dataKey="storeRevenue" fill="rgba(34,211,176,.35)" name="Store Revenue" radius={[2,2,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>


      {/* Monthly table */}
      <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'20px 22px'}}>
        <div style={{fontFamily:'var(--font-head)',fontSize:15,fontWeight:600,marginBottom:6}}>Monthly Forecast Table</div>
        <div style={{display:'flex',gap:16,fontSize:11,color:'var(--text3)',marginBottom:14}}>
          <span style={{display:'flex',alignItems:'center',gap:5}}><span style={{width:10,height:10,borderRadius:2,background:'rgba(34,197,94,.2)',display:'inline-block'}}/> Actual</span>
          <span style={{display:'flex',alignItems:'center',gap:5}}><span style={{width:10,height:10,borderRadius:2,background:'rgba(245,158,66,.2)',display:'inline-block'}}/> Current month (projected)</span>
        </div>
        <div style={{overflowX:'auto',borderRadius:8,border:'1px solid var(--border)'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
            <thead>
              <tr style={{background:'var(--bg4)'}}>
                {headers.filter(h=>!h.startsWith('_')).map(h=>(
                  <th key={h} style={{padding:'10px 12px',textAlign:'left',fontWeight:500,color:'var(--text2)',whiteSpace:'nowrap',borderBottom:'1px solid var(--border2)',fontSize:12}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthlyRows.map((r,i)=>(
                <tr key={i} style={{...rowStyle(r),borderBottom:'1px solid rgba(255,255,255,.04)',transition:'background .1s'}}
                  onMouseEnter={e=>e.currentTarget.style.filter='brightness(1.15)'}
                  onMouseLeave={e=>e.currentTarget.style.filter=''}>
                  {headers.filter(h=>!h.startsWith('_')).map(h=>(
                    <td key={h} style={{padding:'9px 12px',whiteSpace:'nowrap',fontFamily:h!==monthHeader?'var(--font-mono)':'var(--font-body)',color:String(r[monthHeader])==='FULL YEAR'?'var(--accent)':'var(--text)'}}>
                      {h===monthHeader?String(r[h]):
                       h===activationH?fmtPct(r[h]):
                       h===ordersH||h===estActH||h===estAirH?fmtNum(r[h]):
                       fmt$(r[h])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Loader(){return <div style={{padding:40,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Err({msg}){return <div style={{padding:24,background:'rgba(240,82,82,.1)',border:'1px solid var(--danger)',borderRadius:10,color:'var(--danger)',fontSize:13}}><strong>Error:</strong> {msg}</div>;}
