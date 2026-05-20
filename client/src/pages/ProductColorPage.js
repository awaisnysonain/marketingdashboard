import React,{useState,useEffect} from 'react';
import {getTab,fmtNum,fmtPct} from '../utils/api';
import PageIntro from '../components/PageIntro';
import { L } from '../copy/plainLanguage';
import {BarChart,Bar,XAxis,YAxis,CartesianGrid,Tooltip,ResponsiveContainer,Cell,PieChart,Pie,Legend} from 'recharts';

const CARD={background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,padding:'18px 20px'};
const TH={fontFamily:'var(--font-head)'};
const COLORS=['#4f8ef7','#7b5cf5','#2dd4bf','#4ade80','#f59e0b','#f87171','#a78bfa','#fb923c','#34d399','#60a5fa','#e879f9','#fbbf24'];

export default function ProductColorPage(){
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);
  const [selectedProduct,setSelectedProduct]=useState('All');

  useEffect(()=>{
    getTab('Product x Color').then(d=>setRows((d.rows||[]).filter(r=>r['Product']&&r['Color']))).catch(()=>{}).finally(()=>setLoading(false));
  },[]);

  if(loading) return <Loader/>;
  if(!rows.length) return <Empty/>;

  const products=['All',...new Set(rows.map(r=>String(r['Product']||'')).filter(Boolean))];
  const filtered=selectedProduct==='All'?rows:rows.filter(r=>String(r['Product']||'')===selectedProduct);

  // Aggregate by color
  const byColor={};
  filtered.forEach(r=>{
    const c=String(r['Color']||'');
    if(!c) return;
    byColor[c]=(byColor[c]||0)+(+r['Air Orders']||0);
  });
  const colorData=Object.entries(byColor).sort((a,b)=>b[1]-a[1]).map(([name,air],i)=>({name,air,color:COLORS[i%COLORS.length]}));

  // Aggregate by product
  const byProduct={};
  rows.forEach(r=>{
    const p=String(r['Product']||'');
    if(!p) return;
    byProduct[p]=(byProduct[p]||0)+(+r['Air Orders']||0);
  });
  const productData=Object.entries(byProduct).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,air],i)=>({name:name.replace('NOBL Air™ ','').slice(0,20),air,color:COLORS[i%COLORS.length]}));

  const totalAir=filtered.reduce((s,r)=>s+(+r['Air Orders']||0),0);

  return(
    <div style={{display:'flex',flexDirection:'column',gap:28}}>
      <PageIntro title="Product × color" desc="How Air orders split across product bundles and colors." />

      <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
        <span style={{fontSize:12,color:'var(--text3)'}}>Filter by product:</span>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          {products.map(p=>(
            <button key={p} onClick={()=>setSelectedProduct(p)}
              style={{padding:'5px 12px',borderRadius:20,border:'1px solid var(--border2)',background:selectedProduct===p?'var(--accent)':'transparent',color:selectedProduct===p?'#fff':'var(--text2)',fontSize:12,cursor:'pointer',fontWeight:selectedProduct===p?600:400,transition:'all .12s'}}>
              {p==='All'?'All Products':p.replace('NOBL Air™ ','').slice(0,20)}
            </button>
          ))}
        </div>
      </div>

      <div style={{...CARD,display:'flex',alignItems:'center',gap:16}}>
        <div>
          <div style={{fontSize:11,fontWeight:600,color:'var(--text3)',textTransform:'uppercase',letterSpacing:'.7px',marginBottom:6}}>Total Air Orders</div>
          <div style={{...TH,fontSize:28,fontWeight:800,color:'var(--accent)'}}>{fmtNum(totalAir)}</div>
        </div>
        <div style={{width:1,height:40,background:'var(--border2)',margin:'0 8px'}}/>
        <div style={{fontSize:12,color:'var(--text3)'}}>{colorData.length} colors · {filtered.length} combinations</div>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
        <Section title="Air Orders by Color">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={colorData.slice(0,10)} layout="vertical" barSize={16}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis dataKey="name" type="category" tick={{fontSize:11,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={80}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="air" name="Air Orders" radius={[0,4,4,0]}>
                  {colorData.slice(0,10).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Color Share (Pie)">
          <div style={{...CARD,padding:'16px',display:'flex',alignItems:'center',justifyContent:'center'}}>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={colorData.slice(0,8)} dataKey="air" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={({name,percent})=>`${name} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={10}>
                  {colorData.slice(0,8).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Pie>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      {selectedProduct==='All'&&(
        <Section title="Air Orders by Product">
          <div style={{...CARD,padding:'16px'}}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={productData} layout="vertical" barSize={18}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.06)" horizontal={false}/>
                <XAxis type="number" tick={{fontSize:10,fill:'var(--text3)'}} tickLine={false} axisLine={false}/>
                <YAxis dataKey="name" type="category" tick={{fontSize:10,fill:'var(--text2)'}} tickLine={false} axisLine={false} width={130}/>
                <Tooltip contentStyle={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:8,fontSize:12}}/>
                <Bar dataKey="air" name="Air Orders" radius={[0,4,4,0]}>
                  {productData.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      <Section title="Detailed Table">
        <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:14,overflow:'hidden'}}>
          <div style={{overflowX:'auto',maxHeight:400,overflowY:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
              <thead style={{position:'sticky',top:0,zIndex:1}}>
                <tr style={{background:'var(--bg4)',borderBottom:'1px solid var(--border2)'}}>
                  {['Product','Color',L.airOrders].map((h,i)=>(
                    <th key={h} style={{padding:'10px 14px',textAlign:i<2?'left':'right',color:'var(--text2)',fontWeight:500,fontSize:12}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.sort((a,b)=>(+b['Air Orders']||0)-(+a['Air Orders']||0)).map((r,i)=>(
                  <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.04)',background:i%2===1?'rgba(255,255,255,.015)':'transparent'}}>
                    <td style={{padding:'8px 14px',maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r['Product']}</td>
                    <td style={{padding:'8px 14px'}}><span style={{display:'inline-flex',alignItems:'center',gap:6}}><span style={{width:8,height:8,borderRadius:'50%',background:COLORS[colorData.findIndex(c=>c.name===r['Color'])%COLORS.length]||'var(--text3)',flexShrink:0}}/>{r['Color']}</span></td>
                    <td style={{padding:'8px 14px',textAlign:'right',fontFamily:'var(--font-mono)',fontWeight:500}}>{fmtNum(r['Air Orders'])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({title,children}){return <div><div style={{fontSize:13,fontWeight:600,color:'var(--text2)',marginBottom:12,display:'flex',alignItems:'center',gap:8}}><span style={{width:3,height:14,background:'var(--accent)',borderRadius:2,display:'inline-block'}}/>{title}</div>{children}</div>;}
function Loader(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>Loading…</div>;}
function Empty(){return <div style={{padding:60,textAlign:'center',color:'var(--text3)'}}>No data available</div>;}
