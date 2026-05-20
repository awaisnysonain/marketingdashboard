import React,{useState,useEffect} from 'react';
import {BarChart,Bar,XAxis,YAxis,Tooltip,ResponsiveContainer,CartesianGrid,Legend,LineChart,Line} from 'recharts';
import {getTab,fmtPct,fmtNum,fmt$} from '../utils/api';
import ChartCard from '../components/ChartCard';
import DataTable from '../components/DataTable';
import PageIntro from '../components/PageIntro';
import { L } from '../copy/plainLanguage';

const TT={background:'#1e2438',border:'1px solid rgba(255,255,255,.12)',borderRadius:8,fontSize:12,color:'#edf0f7'};

export default function SubscriptionPage(){
  const [ttp,setTtp]=useState(null);
  const [cohort,setCohort]=useState(null);
  const [weekly,setWeekly]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);

  useEffect(()=>{
    Promise.all([getTab('Trial to Paid'),getTab('Cohort Analysis'),getTab('Weekly Trends')])
      .then(([t,c,w])=>{setTtp(t);setCohort(c);setWeekly(w);})
      .catch(e=>setError(String(e)))
      .finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(error) return <Err msg={error}/>;

  const ttpChart=(ttp?.rows||[]).filter(r=>String(r['Variant'])!=='TOTAL').map(r=>({
    tier:String(r['Variant']),
    total:parseFloat(r['Total'])||0,
    mature:parseFloat(r['Mature'])||0,
    converted:parseFloat(r['Converted'])||0,
    onTrial:parseFloat(r['On Trial'])||0,
    cancelled:parseFloat(r['Cancelled'])||0,
    convPct:((parseFloat(r['Conv%'])||0)*100).toFixed(1),
  }));

  const cohortChart=(cohort?.rows||[]).map(r=>({
    week:String(r['Cohort Week']).slice(5),
    total:parseFloat(r['Total Subs'])||0,
    mature:parseFloat(r['Mature'])||0,
    converted:parseFloat(r['Converted'])||0,
    ttpRate:((parseFloat(r['TTP Rate'])||0)*100).toFixed(1),
    onTrial:parseFloat(r['Still on Trial'])||0,
  }));

  const weeklyChart=(weekly?.rows||[]).map(r=>({
    week:String(r['Week (Mon)']).slice(5),
    orders:parseFloat(r['Orders'])||0,
    newSubs:parseFloat(r['New Subs'])||0,
    rebillRev:parseFloat(r['Rebill Rev'])||0,
    combinedNetRev:parseFloat(r['Combined Net Rev'])||0,
    ttpPct:((parseFloat(r['Sub TTP%'])||0)*100).toFixed(1),
  }));

  return(
    <div>
      <div style={{ marginBottom: 20 }}><PageIntro title="Subscriptions" desc="Trial-to-paid conversion, weekly trends, and cohort performance." /></div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18,marginBottom:18}}>
        <ChartCard title="Trial to paid by tier" subtitle={`Total · ${L.matureSubs} · ${L.converted}`}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={ttpChart}>
              <CartesianGrid stroke="rgba(255,255,255,.04)" strokeDasharray="3 3"/>
              <XAxis dataKey="tier" tick={{fill:'#4e5873',fontSize:11}} tickLine={false} axisLine={false}/>
              <YAxis tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false}/>
              <Tooltip contentStyle={TT}/>
              <Legend wrapperStyle={{fontSize:11,color:'#8892ab'}}/>
              <Bar dataKey="total" fill="#4f8ef7" name="Total" radius={[2,2,0,0]}/>
              <Bar dataKey="mature" fill="#7b5cf5" name="Mature" radius={[2,2,0,0]}/>
              <Bar dataKey="converted" fill="#22d3b0" name={L.converted} radius={[2,2,0,0]}/>
              <Bar dataKey="cancelled" fill="#f05252" name="Cancelled" radius={[2,2,0,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Trial-to-paid rate by tier" subtitle="Share of finished trials that started paying">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={ttpChart} layout="vertical">
              <CartesianGrid stroke="rgba(255,255,255,.04)" strokeDasharray="3 3"/>
              <XAxis type="number" tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false} tickFormatter={v=>`${v}%`}/>
              <YAxis dataKey="tier" type="category" tick={{fill:'#8892ab',fontSize:12}} tickLine={false} axisLine={false} width={50}/>
              <Tooltip contentStyle={TT} formatter={v=>[`${v}%`,L.ttpRate]}/>
              <Bar dataKey="convPct" fill="#22d3b0" name={L.ttpRate} radius={[0,3,3,0]}/>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'20px 22px',marginBottom:18}}>
        <div style={{fontFamily:'var(--font-head)',fontSize:15,fontWeight:600,marginBottom:14}}>Trial to Paid Table</div>
        {ttp && <DataTable tab="Trial to Paid" headers={ttp.headers} rows={ttp.rows} maxHeight="320px" searchable={false}/>}
      </div>

      <ChartCard title="Weekly trends" subtitle={`Orders · ${L.newSubs} · ${L.combinedNetRevenue}`} style={{marginBottom:18}}>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={weeklyChart}>
            <CartesianGrid stroke="rgba(255,255,255,.04)" strokeDasharray="3 3"/>
            <XAxis dataKey="week" tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false}/>
            <YAxis yAxisId="l" tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false}/>
            <YAxis yAxisId="r" orientation="right" tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false} tickFormatter={v=>fmt$(v)}/>
            <Tooltip contentStyle={TT} formatter={(v,n)=>n.includes('Rev')?[fmt$(v),n]:[v,n]}/>
            <Legend wrapperStyle={{fontSize:11,color:'#8892ab'}}/>
            <Line yAxisId="l" type="monotone" dataKey="orders" stroke="#4f8ef7" strokeWidth={2} dot={false} name="Orders"/>
            <Line yAxisId="l" type="monotone" dataKey="newSubs" stroke="#22c55e" strokeWidth={2} dot={false} name="New Subs"/>
            <Line yAxisId="r" type="monotone" dataKey="combinedNetRev" stroke="#7b5cf5" strokeWidth={2} dot={false} name={L.combinedNetRevenue}/>
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Cohort trial-to-paid rate" subtitle="Trial-to-paid rate by signup week">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={cohortChart}>
            <CartesianGrid stroke="rgba(255,255,255,.04)" strokeDasharray="3 3"/>
            <XAxis dataKey="week" tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false}/>
            <YAxis tick={{fill:'#4e5873',fontSize:10}} tickLine={false} axisLine={false} tickFormatter={v=>`${v}%`}/>
            <Tooltip contentStyle={TT} formatter={v=>[`${v}%`,L.ttpRate]}/>
            <Bar dataKey="ttpRate" fill="#f59e42" name={L.ttpRate} radius={[2,2,0,0]}/>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'20px 22px',marginBottom:18}}>
        <div style={{fontFamily:'var(--font-head)',fontSize:15,fontWeight:600,marginBottom:14}}>Cohort Analysis Table</div>
        {cohort && <DataTable tab="Cohort Analysis" headers={cohort.headers} rows={cohort.rows} maxHeight="340px"/>}
      </div>

      <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'20px 22px'}}>
        <div style={{fontFamily:'var(--font-head)',fontSize:15,fontWeight:600,marginBottom:14}}>Weekly Trends Table</div>
        {weekly && <DataTable tab="Weekly Trends" headers={weekly.headers} rows={weekly.rows} maxHeight="340px"/>}
      </div>
    </div>
  );
}

function Loader(){return <div style={{padding:40,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Err({msg}){return <div style={{padding:24,background:'rgba(240,82,82,.1)',border:'1px solid var(--danger)',borderRadius:10,color:'var(--danger)',fontSize:13}}><strong>Error:</strong> {msg}</div>;}
