import React from 'react';
export default function ChartCard({title,subtitle,children,style={}}){
  return(
    <div style={{background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'20px 22px',marginBottom:18,...style}}>
      {title && <div style={{fontFamily:'var(--font-head)',fontSize:15,fontWeight:600,marginBottom:subtitle?4:14}}>{title}</div>}
      {subtitle && <div style={{fontSize:12,color:'var(--text3)',marginBottom:14}}>{subtitle}</div>}
      {children}
    </div>
  );
}
