import React,{useState} from 'react';
import {Icons,sheetIcon} from './Icons';

// Predefined sheet groups for labelling (sheet name → group)
const SHEET_GROUPS={
  'Summary':'Overview',
  'Daily Input':'Performance','Daily Trend':'Performance','Day of Week':'Performance',
  'Trial to Paid':'Subscriptions','Weekly Trends':'Subscriptions','Cohort Analysis':'Subscriptions','Trial to Paid Daily break down':'Subscriptions',
  'By Product':'Products','Product x Color':'Products','Variant Activation':'Products',
  'By Channel':'Channels','Channel Funnel':'Channels','Tier x Channel':'Channels',
  'FB Campaigns':'Facebook','FB Adsets':'Facebook',
  'Revenue Forcast':'Forecast',
};

const GROUP_ORDER=['Overview','Performance','Subscriptions','Products','Channels','Facebook','Forecast'];

function shortName(name){
  return name
    .replace('Trial to Paid Daily break down','TTP Daily')
    .replace('Trial to Paid','Trial/Paid')
    .replace('Variant Activation','Var. Activation')
    .replace('Channel Funnel','Ch. Funnel')
    .replace('Cohort Analysis','Cohort')
    .replace('Weekly Trends','Weekly')
    .replace('Daily Input','Daily Input')
    .replace('Daily Trend','Daily Trend')
    .replace('Day of Week','Day/Week')
    .replace('By Product','By Product')
    .replace('Product x Color','Prod × Color')
    .replace('By Channel','By Channel')
    .replace('Tier x Channel','Tier × Ch.')
    .replace('FB Campaigns','FB Campaigns')
    .replace('FB Adsets','FB Adsets')
    .replace('Revenue Forcast','Rev. Forecast');
}

export default function Sidebar({allSheets,active,onChange,open,collapsed,onToggleCollapse}){
  const [expandedGroups,setExpandedGroups]=useState(new Set(GROUP_ORDER));

  if(!open) return null;

  // Build grouped structure from allSheets
  const groups={};
  GROUP_ORDER.forEach(g=>{groups[g]=[];});
  groups['Other']=[];

  allSheets.forEach(sheet=>{
    const g=SHEET_GROUPS[sheet]||'Other';
    if(!groups[g]) groups[g]=[];
    groups[g].push(sheet);
  });

  const toggleGroup=(g)=>{
    setExpandedGroups(prev=>{
      const next=new Set(prev);
      next.has(g)?next.delete(g):next.add(g);
      return next;
    });
  };

  const w=collapsed?'var(--sidebar-collapsed)':'var(--sidebar-w)';

  return(
    <aside style={{
      width:w,flexShrink:0,
      background:'var(--bg2)',
      borderRight:'1px solid var(--border)',
      overflowY:'auto',overflowX:'hidden',
      display:'flex',flexDirection:'column',
      transition:'width .2s cubic-bezier(.4,0,.2,1)',
    }}>

      {/* Collapse toggle */}
      {!collapsed&&(
        <div style={{padding:'10px 10px 6px',display:'flex',justifyContent:'flex-end'}}>
          <button onClick={onToggleCollapse}
            title="Collapse sidebar"
            style={{background:'none',border:'1px solid var(--border)',color:'var(--text3)',borderRadius:'var(--radius)',padding:'4px 6px',cursor:'pointer',display:'flex',alignItems:'center',transition:'all .15s'}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--border2)';e.currentTarget.style.color='var(--text2)';}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.color='var(--text3)';}}>
            <Icons.ChevronLeft size={13}/>
          </button>
        </div>
      )}
      {collapsed&&(
        <div style={{padding:'10px 0 6px',display:'flex',justifyContent:'center'}}>
          <button onClick={onToggleCollapse}
            title="Expand sidebar"
            style={{background:'none',border:'1px solid var(--border)',color:'var(--text3)',borderRadius:'var(--radius)',padding:'4px 6px',cursor:'pointer',display:'flex',alignItems:'center',transition:'all .15s'}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--border2)';e.currentTarget.style.color='var(--text2)';}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.color='var(--text3)';}}>
            <Icons.ChevronRight size={13}/>
          </button>
        </div>
      )}

      {/* Sheet icon tiles */}
      <div style={{padding:collapsed?'4px 0':'4px 0',flex:1}}>
        {GROUP_ORDER.concat(groups['Other']?.length?['Other']:[]).map(group=>{
          const items=groups[group]||[];
          if(!items.length) return null;
          const expanded=expandedGroups.has(group);

          return(
            <div key={group} style={{marginBottom:2}}>
              {/* Group label */}
              {!collapsed&&(
                <button onClick={()=>toggleGroup(group)}
                  style={{
                    display:'flex',alignItems:'center',justifyContent:'space-between',
                    width:'100%',padding:'8px 14px 4px',
                    background:'none',border:'none',cursor:'pointer',
                    color:'var(--text3)',fontSize:10,fontWeight:700,
                    textTransform:'uppercase',letterSpacing:'1px',
                    transition:'color .15s',
                  }}
                  onMouseEnter={e=>e.currentTarget.style.color='var(--text2)'}
                  onMouseLeave={e=>e.currentTarget.style.color='var(--text3)'}>
                  <span>{group}</span>
                  <Icons.ChevronRight size={10} style={{transform:expanded?'rotate(90deg)':'none',transition:'transform .15s'}}/>
                </button>
              )}
              {collapsed&&<div style={{height:6}}/>}

              {/* Sheet tiles */}
              {(expanded||collapsed)&&(
                <div style={{
                  display:collapsed?'flex':'grid',
                  flexDirection:collapsed?'column':undefined,
                  gridTemplateColumns:collapsed?undefined:'repeat(2,1fr)',
                  gap:collapsed?2:4,
                  padding:collapsed?'0 6px':'0 8px',
                }}>
                  {items.map(sheet=>{
                    const IcComp=sheetIcon(sheet);
                    const isActive=active===sheet;
                    return(
                      <button key={sheet} onClick={()=>onChange(sheet)}
                        title={sheet}
                        style={{
                          display:'flex',
                          flexDirection:collapsed?'row':'column',
                          alignItems:'center',
                          justifyContent:collapsed?'center':'flex-start',
                          gap:collapsed?0:4,
                          padding:collapsed?'8px':'10px 8px 8px',
                          background:isActive?'var(--accent-dim)':'transparent',
                          border:`1px solid ${isActive?'var(--accent)':'transparent'}`,
                          borderRadius:'var(--radius)',
                          color:isActive?'var(--accent)':'var(--text2)',
                          cursor:'pointer',
                          transition:'all .12s',
                          textAlign:'center',
                          minHeight:collapsed?38:undefined,
                          position:'relative',
                        }}
                        onMouseEnter={e=>{
                          if(!isActive){
                            e.currentTarget.style.background='var(--bg4)';
                            e.currentTarget.style.color='var(--text)';
                          }
                        }}
                        onMouseLeave={e=>{
                          if(!isActive){
                            e.currentTarget.style.background='transparent';
                            e.currentTarget.style.color='var(--text2)';
                          }
                        }}>
                        {/* Active indicator */}
                        {isActive&&collapsed&&(
                          <span style={{position:'absolute',left:0,top:'50%',transform:'translateY(-50%)',width:2,height:18,background:'var(--accent)',borderRadius:'0 2px 2px 0'}}/>
                        )}
                        <IcComp size={collapsed?16:18} style={{opacity:isActive?1:.75,flexShrink:0}}/>
                        {!collapsed&&(
                          <span style={{
                            fontSize:10,fontWeight:isActive?600:400,lineHeight:1.3,
                            overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',
                            width:'100%',textAlign:'center',
                          }}>
                            {shortName(sheet)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom spacer */}
      <div style={{height:12}}/>
    </aside>
  );
}
