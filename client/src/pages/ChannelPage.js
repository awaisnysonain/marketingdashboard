import React,{useState,useEffect} from 'react';
import {BarChart,Bar,XAxis,YAxis,Tooltip,ResponsiveContainer,CartesianGrid,ReferenceLine} from 'recharts';
import {getTab,fmt$,fmtPct,fmtNum} from '../utils/api';
import ChartCard from '../components/ChartCard';
import DataTable from '../components/DataTable';
import PageIntro from '../components/PageIntro';
import { L } from '../copy/plainLanguage';

const TT={background:'#1e2438',border:'1px solid rgba(255,255,255,.12)',borderRadius:8,fontSize:12,color:'#edf0f7'};

export default function ChannelPage(){
  const [funnel,setFunnel]=useState(null);
  const [byChannel,setByChannel]=useState(null);
  const [fbCampaigns,setFbCampaigns]=useState(null);
  const [fbAdsets,setFbAdsets]=useState(null);
  const [showFbC,setShowFbC]=useState(false);
  const [showFbA,setShowFbA]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);

  useEffect(()=>{
    Promise.all([
      getTab('Channel Funnel'),
      getTab('By Channel'),
      getTab('FB Campaigns'),
      getTab('FB Adsets'),
    ])
      .then(([f,b,fc,fa])=>{setFunnel(f);setByChannel(b);setFbCampaigns(fc);setFbAdsets(fa);})
      .catch(e=>setError(String(e)))
      .finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(error) return <Err msg={error}/>;

  // After backend header fix, funnel rows have real columns: Channel, Orders, Attach Rate, etc.
  // Filter out empty rows, totals, and non-attributed
  const funnelRows=(funnel?.rows||[]).filter(r=>{
    const ch=String(r['Channel']||'').trim();
    return ch&&ch!=='TOTAL'&&ch!=='Non-Attributed'&&ch!=='Channel';
  });
  const totalRow=(funnel?.rows||[]).find(r=>String(r['Channel']||'').trim()==='TOTAL')||{};
  const overallAttach=parseFloat(totalRow['Attach Rate'])||0;

  const channelCards=funnelRows.slice(0,8);
  const chartData=funnelRows.map(r=>({
    channel:String(r['Channel']).replace(' Ads','').replace('Klaviyo ','').replace('Postscript ',''),
    attachRate:((parseFloat(r['Attach Rate'])||0)*100).toFixed(2),
    ttpRate:((parseFloat(r['Sub TTP Rate'])||0)*100).toFixed(2),
    orders:Math.round(parseFloat(r['Orders'])||0),
    newSubs:Math.round(parseFloat(r['New Subs'])||0),
  }));

  return(
    <div>
      <div style={{ marginBottom: 20 }}><PageIntro title="Channel attribution" desc="Which channels drive orders, Air add-ons, and subscription sales." /></div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:14,marginBottom:24}}>
        {channelCards.map(r=>{
          const attach=parseFloat(r['Attach Rate'])||0;
          const aboveAvg=attach>overallAttach*1.05;
          const belowAvg=attach<overallAttach*0.95;
          const borderColor=aboveAvg?'var(--success)':belowAvg?'var(--danger)':'var(--border)';
          return(
            <div key={r['Channel']} style={{background:'var(--bg3)',border:`1px solid ${borderColor}`,borderRadius:'var(--radius-lg)',padding:'16px 18px'}}>
              <div style={{fontSize:11,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.6px',marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                {String(r['Channel'])}
                {aboveAvg&&<span style={{fontSize:10,color:'var(--success)',background:'rgba(34,197,94,.12)',padding:'2px 6px',borderRadius:4}}>▲ Above avg</span>}
                {belowAvg&&<span style={{fontSize:10,color:'var(--danger)',background:'rgba(240,82,82,.12)',padding:'2px 6px',borderRadius:4}}>▼ Below avg</span>}
              </div>
              <div style={{fontFamily:'var(--font-head)',fontSize:22,fontWeight:700,marginBottom:6}}>{fmtPct(attach)}</div>
              <div style={{fontSize:11,color:'var(--text3)',fontFamily:'var(--font-mono)'}}>Air add-on rate</div>
              <div style={{borderTop:'1px solid var(--border)',marginTop:10,paddingTop:10,display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                <div><div style={{fontSize:10,color:'var(--text3)'}}>Orders</div><div style={{fontSize:13,fontFamily:'var(--font-mono)',fontWeight:500}}>{fmtNum(r['Orders'])}</div></div>
                <div><div style={{fontSize:10,color:'var(--text3)'}}>New Subs</div><div style={{fontSize:13,fontFamily:'var(--font-mono)',fontWeight:500}}>{fmtNum(r['New Subs'])}</div></div>
                <div><div style={{fontSize:10,color:'var(--text3)'}}>{L.ttpRate}</div><div style={{fontSize:13,fontFamily:'var(--font-mono)',fontWeight:500}}>{fmtPct(r['Sub TTP Rate'])}</div></div>
                <div><div style={{fontSize:10,color:'var(--text3)'}}>{L.subRevenue}</div><div style={{fontSize:13,fontFamily:'var(--font-mono)',fontWeight:500}}>{fmt$(r['Sub Revenue'])}</div></div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginBottom:18}}>
        <ChartCard title={`${L.attachRate} by channel`} subtitle={`Overall avg: ${(overallAttach*100).toFixed(2)}%`}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid stroke="rgba(255,255,255,.04)" strokeDasharray="3 3"/>
              <XAxis type="number" tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false} tickFormatter={v=>`${v}%`}/>
              <YAxis dataKey="channel" type="category" tick={{fill:'#8892ab',fontSize:11}} tickLine={false} axisLine={false} width={90}/>
              <Tooltip contentStyle={TT} formatter={v=>[`${v}%`,L.attachRate]}/>
              <ReferenceLine x={(overallAttach*100).toFixed(2)} stroke="#f59e42" strokeDasharray="4 3" label={{value:'avg',fill:'#f59e42',fontSize:10}}/>
              <Bar dataKey="attachRate" radius={[0,3,3,0]}
                fill="#4f8ef7"
                name={L.attachRate}/>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Orders & New Subs by Channel">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} layout="vertical">
              <CartesianGrid stroke="rgba(255,255,255,.04)" strokeDasharray="3 3"/>
              <XAxis type="number" tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false}/>
              <YAxis dataKey="channel" type="category" tick={{fill:'#8892ab',fontSize:11}} tickLine={false} axisLine={false} width={90}/>
              <Tooltip contentStyle={TT}/>
              <Bar dataKey="orders" fill="rgba(79,142,247,.4)" name="Orders" radius={[0,3,3,0]}/>
              <Bar dataKey="newSubs" fill="#22d3b0" name="New Subs" radius={[0,3,3,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'20px 22px',marginBottom:18}}>
        <div style={{fontFamily:'var(--font-head)',fontSize:15,fontWeight:600,marginBottom:14}}>Channel Funnel Table</div>
        {funnel && <DataTable tab="Channel Funnel" headers={funnel.headers} rows={funnel.rows} searchable={false}/>}
      </div>

      {/* FB Campaigns collapsible */}
      <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'16px 22px',marginBottom:12}}>
        <button onClick={()=>setShowFbC(!showFbC)} style={{background:'none',border:'none',color:'var(--text)',display:'flex',alignItems:'center',gap:8,fontFamily:'var(--font-head)',fontSize:15,fontWeight:600,cursor:'pointer',width:'100%',textAlign:'left'}}>
          <span style={{fontSize:12,transform:showFbC?'rotate(90deg)':'none',transition:'transform .15s',display:'inline-block'}}>▶</span>
          FB Campaigns
          <span style={{fontSize:12,color:'var(--text3)',fontWeight:400,marginLeft:4}}>({(fbCampaigns?.rows||[]).length} campaigns)</span>
        </button>
        {showFbC && fbCampaigns && <div style={{marginTop:14}}><DataTable tab="FB Campaigns" headers={fbCampaigns.headers} rows={fbCampaigns.rows}/></div>}
      </div>

      <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'16px 22px'}}>
        <button onClick={()=>setShowFbA(!showFbA)} style={{background:'none',border:'none',color:'var(--text)',display:'flex',alignItems:'center',gap:8,fontFamily:'var(--font-head)',fontSize:15,fontWeight:600,cursor:'pointer',width:'100%',textAlign:'left'}}>
          <span style={{fontSize:12,transform:showFbA?'rotate(90deg)':'none',transition:'transform .15s',display:'inline-block'}}>▶</span>
          FB Adsets
          <span style={{fontSize:12,color:'var(--text3)',fontWeight:400,marginLeft:4}}>({(fbAdsets?.rows||[]).length} adsets)</span>
        </button>
        {showFbA && fbAdsets && <div style={{marginTop:14}}><DataTable tab="FB Adsets" headers={fbAdsets.headers} rows={fbAdsets.rows}/></div>}
      </div>
    </div>
  );
}

function Loader(){return <div style={{padding:40,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Err({msg}){return <div style={{padding:24,background:'rgba(240,82,82,.1)',border:'1px solid var(--danger)',borderRadius:10,color:'var(--danger)',fontSize:13}}><strong>Error:</strong> {msg}</div>;}
