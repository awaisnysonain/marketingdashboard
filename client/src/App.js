import React,{useState,useEffect,useCallback,useRef,Component} from 'react';
import {getStatus,refreshSheets,getDriveSheets,getSpreadsheet,selectSpreadsheet} from './utils/api';
import TopBar from './components/TopBar';
import TabBar from './components/TabBar';
import {Icons} from './components/Icons';
import AiAssistant from './components/AiAssistant';

import SummaryPage from './pages/SummaryPage';
import DailyInputPage from './pages/DailyInputPage';
import DailyTrendPage from './pages/DailyTrendPage';
import TTPPage from './pages/TTPPage';
import WeeklyTrendsPage from './pages/WeeklyTrendsPage';
import CohortPage from './pages/CohortPage';
import DayOfWeekPage from './pages/DayOfWeekPage';
import ByProductPage from './pages/ByProductPage';
import ProductColorPage from './pages/ProductColorPage';
import VariantPage from './pages/VariantPage';
import ByChannelPage from './pages/ByChannelPage';
import ChannelFunnelPage from './pages/ChannelFunnelPage';
import TierChannelPage from './pages/TierChannelPage';
import FbCampaignsPage from './pages/FbCampaignsPage';
import FbAdsetsPage from './pages/FbAdsetsPage';
import ForecastPage from './pages/ForecastPage';
import GenericSheetPage from './pages/GenericSheetPage';

// Custom components for known tab names
const CUSTOM_PAGES = {
  'Summary':                    (pp) => <SummaryPage {...pp}/>,
  'Daily Input':                (pp) => <DailyInputPage {...pp}/>,
  'Daily Trend':                (pp) => <DailyTrendPage {...pp}/>,
  'Day of Week':                (pp) => <DayOfWeekPage {...pp}/>,
  'Trial to Paid':              (pp) => <TTPPage {...pp}/>,
  'Weekly Trends':              (pp) => <WeeklyTrendsPage {...pp}/>,
  'Cohort Analysis':            (pp) => <CohortPage {...pp}/>,
  'By Product':                 (pp) => <ByProductPage {...pp}/>,
  'Product x Color':            (pp) => <ProductColorPage {...pp}/>,
  'Variant Activation':         (pp) => <VariantPage {...pp}/>,
  'By Channel':                 (pp) => <ByChannelPage {...pp}/>,
  'Channel Funnel':             (pp) => <ChannelFunnelPage {...pp}/>,
  'Tier x Channel':             (pp) => <TierChannelPage {...pp}/>,
  'FB Campaigns':               (pp) => <FbCampaignsPage {...pp}/>,
  'FB Adsets':                  (pp) => <FbAdsetsPage {...pp}/>,
  'Revenue Forcast':            (pp) => <ForecastPage {...pp}/>,
};

function getInitialTheme(){
  try{return localStorage.getItem('nobl-theme')||'dark';}catch{return 'dark';}
}

export default function App(){
  const [auth,setAuth]=useState(null);
  const [activeTab,setActiveTab]=useState(null);
  const [tabs,setTabs]=useState([]);
  const [spreadsheetTitle,setSpreadsheetTitle]=useState(null);
  const [driveSheets,setDriveSheets]=useState(null);
  const [refreshing,setRefreshing]=useState(false);
  const [switching,setSwitching]=useState(false);
  const [toast,setToast]=useState(null);
  const [theme,setTheme]=useState(getInitialTheme);
  // Slide direction: 1 = slide left (next), -1 = slide right (prev)
  const [slideDir,setSlideDir]=useState(0);
  const [sliding,setSliding]=useState(false);
  const prevTabRef=useRef(null);

  useEffect(()=>{
    document.documentElement.setAttribute('data-theme',theme);
    try{localStorage.setItem('nobl-theme',theme);}catch{}
  },[theme]);

  const showToast=useCallback((msg,type='info')=>{
    setToast({msg,type});
    setTimeout(()=>setToast(null),4000);
  },[]);

  useEffect(()=>{
    // Load auth + spreadsheet info
    Promise.all([getStatus(), getSpreadsheet()]).then(([s,sp])=>{
      setAuth(s);
      if(sp.tabs?.length){
        setTabs(sp.tabs);
        setSpreadsheetTitle(sp.title);
        setActiveTab(prev=>prev&&sp.tabs.includes(prev)?prev:sp.tabs[0]);
      }
      // Load Drive sheets (non-blocking)
      getDriveSheets().then(sheets=>{
        setDriveSheets(Array.isArray(sheets)?sheets:sheets?.error?sheets:[]);
      }).catch(()=>setDriveSheets([]));
    }).catch(()=>setAuth({authenticated:false}));

    const p=new URLSearchParams(window.location.search);
    if(p.get('auth')==='success'){showToast('Connected to Google Sheets!','success');window.history.replaceState({},'','/');}
    else if(p.get('auth')==='error'){showToast('Google auth failed','error');window.history.replaceState({},'','/');}
  },[showToast]);

  async function handleRefresh(){
    setRefreshing(true);
    try{
      await refreshSheets();
      const [s,sp]=await Promise.all([getStatus(),getSpreadsheet()]);
      setAuth(s);
      if(sp.tabs?.length){ setTabs(sp.tabs); setSpreadsheetTitle(sp.title); }
      showToast('Data refreshed','success');
    }
    catch{showToast('Refresh failed','error');}
    finally{setRefreshing(false);}
  }

  async function handleSelectSpreadsheet(id, name){
    setSwitching(true);
    setSpreadsheetTitle(name);
    try{
      const result=await selectSpreadsheet(id);
      if(result.tabs?.length){
        setTabs(result.tabs);
        setSpreadsheetTitle(result.title||name);
        setActiveTab(result.tabs[0]);
      }
      const s=await getStatus();
      setAuth({...s,spreadsheetId:id});
      showToast(`Switched to "${result.title||name}"`, 'success');
    }
    catch{showToast('Failed to switch spreadsheet','error');}
    finally{setSwitching(false);}
  }

  function handleTabChange(tab){
    if(tab===activeTab) return;
    const oldIdx=tabs.indexOf(activeTab);
    const newIdx=tabs.indexOf(tab);
    setSlideDir(newIdx>oldIdx?1:-1);
    setSliding(true);
    prevTabRef.current=activeTab;
    setTimeout(()=>{
      setActiveTab(tab);
      setSliding(false);
      setSlideDir(0);
    },180);
  }

  if(!auth) return <Spinner/>;
  if(!auth.authenticated) return <LoginScreen/>;

  const pp={showToast};
  const renderPage=()=>{
    if(!activeTab) return <EmptyState/>;
    const custom=CUSTOM_PAGES[activeTab];
    if(custom) return custom(pp);
    return <GenericSheetPage key={activeTab} tabName={activeTab} {...pp}/>;
  };

  return(
    <div style={{display:'flex',flexDirection:'column',height:'100vh',overflow:'hidden',background:'var(--bg)'}}>
      <TopBar
        auth={auth}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        theme={theme}
        onToggleTheme={()=>setTheme(t=>t==='dark'?'light':'dark')}
        spreadsheetTitle={spreadsheetTitle}
        driveSheets={driveSheets}
        onSelectSpreadsheet={handleSelectSpreadsheet}
        switching={switching}
      />

      {tabs.length>0&&(
        <TabBar tabs={tabs} active={activeTab||tabs[0]} onChange={handleTabChange}/>
      )}

      <main style={{
        flex:1,overflowY:'auto',overflowX:'hidden',
        background:'var(--bg)',
      }}>
        <div style={{
          maxWidth:1440,margin:'0 auto',
          padding:'28px 32px',
          transform:sliding?`translateX(${slideDir*18}px)`:'translateX(0)',
          opacity:sliding?0:1,
          transition:sliding?'none':'transform .18s ease, opacity .18s ease',
        }}>
          {switching?(
            <div style={{padding:'80px 0',textAlign:'center',color:'var(--text3)'}}>
              <div style={{width:28,height:28,border:'2px solid var(--border2)',borderTopColor:'var(--accent)',borderRadius:'50%',animation:'spin .8s linear infinite',margin:'0 auto 14px'}}/>
              <p style={{fontSize:13}}>Loading spreadsheet…</p>
            </div>
          ):(
            <ErrorBoundary key={activeTab}>
              {renderPage()}
            </ErrorBoundary>
          )}
        </div>
      </main>

      {toast&&<Toast {...toast}/>}
      {auth?.authenticated&&<AiAssistant activeTab={activeTab}/>}
      <style>{`.hide-scrollbar::-webkit-scrollbar{display:none}`}</style>
    </div>
  );
}

// ── Error boundary — catches render crashes, shows msg instead of blank ──
class ErrorBoundary extends Component {
  constructor(props){super(props);this.state={error:null};}
  static getDerivedStateFromError(e){return{error:e};}
  componentDidCatch(e,info){console.error('[ErrorBoundary]',e,info);}
  render(){
    if(this.state.error){
      return(
        <div style={{padding:'60px 32px',maxWidth:540,margin:'0 auto'}}>
          <div style={{background:'rgba(239,68,68,.08)',border:'1px solid rgba(239,68,68,.3)',borderRadius:12,padding:'24px 28px'}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8,color:'var(--danger)'}}>Something went wrong</div>
            <div style={{fontSize:13,color:'var(--text2)',marginBottom:16,lineHeight:1.7}}>
              This tab crashed during rendering. Try refreshing the data or switching to another tab.
            </div>
            <code style={{fontSize:11,color:'var(--text3)',display:'block',background:'var(--bg3)',borderRadius:6,padding:'10px 12px',wordBreak:'break-all'}}>
              {String(this.state.error?.message||this.state.error)}
            </code>
            <button onClick={()=>this.setState({error:null})} style={{marginTop:16,padding:'7px 18px',background:'var(--accent)',color:'#fff',border:'none',borderRadius:8,fontSize:13,cursor:'pointer',fontWeight:600}}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function EmptyState(){
  return(
    <div style={{padding:'80px 0',textAlign:'center',color:'var(--text3)'}}>
      <Icons.FileSpreadsheet size={40} style={{margin:'0 auto 16px',opacity:.3}}/>
      <p style={{fontSize:14}}>Select a spreadsheet to get started</p>
    </div>
  );
}

function Spinner(){
  return(
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',background:'var(--bg)'}}>
      <div style={{width:28,height:28,border:'2px solid var(--border2)',borderTopColor:'var(--accent)',borderRadius:'50%',animation:'spin .8s linear infinite'}}/>
    </div>
  );
}

function LoginScreen(){
  return(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100vh',gap:24,padding:24,background:'var(--bg)'}}>
      <div style={{display:'flex',alignItems:'center',gap:10}}>
        <div style={{width:42,height:42,background:'linear-gradient(135deg,var(--accent),var(--accent2))',borderRadius:11,display:'flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:18,color:'#fff',fontFamily:'var(--font-head)'}}>N</div>
        <span style={{fontSize:22,fontWeight:800,fontFamily:'var(--font-head)'}}>NOBL Air Analytics</span>
      </div>
      <p style={{color:'var(--text2)',maxWidth:360,textAlign:'center',lineHeight:1.8,fontSize:13}}>
        Connect your Google account to access your spreadsheet dashboards.
      </p>
      <a href="/auth/login"
        style={{display:'inline-flex',alignItems:'center',gap:9,background:'var(--accent)',color:'#fff',borderRadius:9,padding:'10px 24px',fontWeight:600,fontSize:13,textDecoration:'none'}}>
        <Icons.FileSpreadsheet size={15}/>
        Sign in with Google
      </a>
    </div>
  );
}

function Toast({msg,type}){
  const c={success:'var(--success)',error:'var(--danger)',info:'var(--accent)'};
  const col=c[type]||'var(--border2)';
  return(
    <div style={{
      position:'fixed',bottom:20,right:20,
      background:'var(--bg2)',border:`1px solid ${col}`,
      borderRadius:9,padding:'10px 16px',
      display:'flex',alignItems:'center',gap:9,
      zIndex:9999,fontSize:13,fontWeight:500,
      animation:'fadein .2s ease',boxShadow:'var(--shadow)',
    }}>
      <span style={{width:6,height:6,borderRadius:'50%',background:col,flexShrink:0}}/>
      {msg}
    </div>
  );
}
