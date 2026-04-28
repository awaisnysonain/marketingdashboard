import React, { useState, useEffect, useCallback, useRef, Component } from 'react';
import { appStatus, appLogout, triggerSync, getSyncStatus } from './utils/api';
import TopBar from './components/TopBar';
import Sidebar, { CORE_TABS } from './components/Sidebar';
import { Icons } from './components/Icons';
import AiAssistant from './components/AiAssistant';
import LoginPage from './pages/LoginPage';

import OverviewPage      from './pages/OverviewPage';
import NoblPage          from './pages/NoblPage';
import FloPage           from './pages/FloPage';
import ChannelsPage      from './pages/ChannelsPage';
import SubsPage          from './pages/SubsPage';
import AiBuilderPage     from './pages/AiBuilderPage';
import SyncPage          from './pages/SyncPage';
import GenericDashPage   from './pages/GenericDashPage';
import LivePage          from './pages/LivePage';

function getInitialTheme() {
  try { return localStorage.getItem('nobl-theme') || 'dark'; } catch { return 'dark'; }
}
function getSidebarState() {
  try { return localStorage.getItem('nobl-sidebar-collapsed') === 'true'; } catch { return false; }
}

const CORE_PAGE_MAP = {
  'Overview':      OverviewPage,
  'NOBL Air':      NoblPage,
  'Pilates FLO':   FloPage,
  'Channels':      ChannelsPage,
  'Subscriptions': SubsPage,
  'Live Data':     LivePage,
};

export default function App() {
  const [appUser, setAppUser]           = useState(undefined);
  const [activeTab, setActiveTab]       = useState('Overview');
  const [toast, setToast]               = useState(null);
  const [theme, setTheme]               = useState(getInitialTheme);
  const [refreshing, setRefreshing]     = useState(false);
  const [syncStatus, setSyncStatus]     = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(getSidebarState);
  const [dynamicTabs, setDynamicTabs]   = useState(() => {
    try { return JSON.parse(localStorage.getItem('nobl-dynamic-tabs') || '[]'); } catch { return []; }
  });
  const [showAiBuilder, setShowAiBuilder] = useState(false);
  const [showSync, setShowSync]           = useState(false);
  const [pageKey, setPageKey]             = useState(0);
  const prevTab = useRef(activeTab);

  // Persist theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('nobl-theme', theme); } catch {}
  }, [theme]);

  // Persist sidebar state
  useEffect(() => {
    try { localStorage.setItem('nobl-sidebar-collapsed', sidebarCollapsed); } catch {}
  }, [sidebarCollapsed]);

  // Persist dynamic tabs
  useEffect(() => {
    try { localStorage.setItem('nobl-dynamic-tabs', JSON.stringify(dynamicTabs)); } catch {}
  }, [dynamicTabs]);

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // Auth check
  useEffect(() => {
    appStatus().then(s => setAppUser(s.authenticated ? s.user : null)).catch(() => setAppUser(null));
  }, []);

  // Poll sync status every 60s
  useEffect(() => {
    if (!appUser) return;
    function fetchSync() {
      getSyncStatus().then(d => {
        const rec = d?.recent?.[0];
        if (!rec) { setSyncStatus(null); return; }
        const st  = String(rec.status||'').toLowerCase();
        if (st === 'error') { setSyncStatus('error'); return; }
        const age = rec.finished_at ? Date.now() - new Date(rec.finished_at).getTime() : Infinity;
        setSyncStatus(age < 3600000 ? 'ok' : 'warn');
      }).catch(() => setSyncStatus(null));
    }
    fetchSync();
    const id = setInterval(fetchSync, 60000);
    return () => clearInterval(id);
  }, [appUser]);

  async function handleLogout() {
    await appLogout().catch(() => {});
    setAppUser(null);
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await triggerSync({ tasks: ['klaviyo', 'appstle', 'tw_refresh'] });
      showToast('Sync started — data will update in ~2 min', 'success');
    } catch {
      showToast('Failed to start sync', 'error');
    } finally {
      setTimeout(() => setRefreshing(false), 1500);
    }
  }

  function handleTabChange(id) {
    if (id === activeTab) return;
    prevTab.current = activeTab;
    setActiveTab(id);
    setPageKey(k => k + 1);
    setShowAiBuilder(false);
    setShowSync(false);
  }

  function handleAddDashboard() {
    setShowAiBuilder(true);
    setShowSync(false);
  }

  function handleDashboardCreated(dash) {
    // dash = { id, label, subtitle, type:'dashboard', config }
    setDynamicTabs(prev => {
      const existing = prev.findIndex(t => t.id === dash.id);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = dash;
        return next;
      }
      return [...prev, dash];
    });
    setActiveTab(dash.id);
    setShowAiBuilder(false);
    showToast(`Dashboard "${dash.label}" created`, 'success');
  }

  function handleDeleteDynamic(id) {
    setDynamicTabs(prev => prev.filter(t => t.id !== id));
    if (activeTab === id) setActiveTab('Overview');
    showToast('Removed', 'info');
  }

  if (appUser === undefined) return <Spinner />;
  if (!appUser) return <LoginPage onLogin={setAppUser} />;

  // Determine which component to render
  let PageComp = null;
  let pageDynamic = null;

  if (showSync) {
    PageComp = SyncPage;
  } else if (showAiBuilder) {
    PageComp = AiBuilderPage;
  } else if (CORE_PAGE_MAP[activeTab]) {
    PageComp = CORE_PAGE_MAP[activeTab];
  } else {
    pageDynamic = dynamicTabs.find(t => t.id === activeTab);
    if (pageDynamic) PageComp = GenericDashPage;
    else PageComp = OverviewPage;
  }

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', background:'var(--bg)' }}>
      {/* Sidebar */}
      <Sidebar
        active={showSync ? '__sync' : showAiBuilder ? '__builder' : activeTab}
        onChange={handleTabChange}
        dynamicTabs={dynamicTabs}
        onAddDashboard={handleAddDashboard}
        onDeleteDynamic={handleDeleteDynamic}
        collapsed={sidebarCollapsed}
        onCollapse={() => setSidebarCollapsed(c => !c)}
      />

      {/* Main area */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        <TopBar
          activeTab={showSync ? 'Sync Status' : showAiBuilder ? 'AI Builder' : activeTab}
          appUser={appUser}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          syncStatus={syncStatus}
          theme={theme}
          onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          onLogout={handleLogout}
          onOpenAiBuilder={() => { setShowAiBuilder(true); setShowSync(false); }}
          onOpenSync={() => { setShowSync(true); setShowAiBuilder(false); }}
          dynamicTabs={dynamicTabs}
        />

        <main style={{ flex:1, overflowY: showAiBuilder ? 'hidden' : 'auto', overflowX:'hidden', background:'var(--bg)', display:'flex', flexDirection:'column' }}>
          <div
            key={`${activeTab}-${showSync}-${showAiBuilder}-${pageKey}`}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: showAiBuilder ? 0 : '20px 24px',
              flex: showAiBuilder ? 1 : undefined,
              minHeight: showAiBuilder ? 0 : undefined,
              display: showAiBuilder ? 'flex' : 'block',
              flexDirection: showAiBuilder ? 'column' : undefined,
              animation:'fadein .2s ease',
            }}
          >
            <ErrorBoundary key={`${activeTab}-${pageKey}`}>
              {PageComp === AiBuilderPage
                ? <AiBuilderPage showToast={showToast} onDashboardCreated={handleDashboardCreated} />
                : PageComp === SyncPage
                  ? <SyncPage showToast={showToast} />
                  : PageComp === GenericDashPage
                    ? <GenericDashPage tab={pageDynamic} showToast={showToast} />
                    : <PageComp showToast={showToast} />
              }
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {toast && <Toast {...toast} />}
      <AiAssistant activeTab={activeTab} />
    </div>
  );
}

/* ── Error Boundary ─────────────────────────────────────────────── */
class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { error:null }; }
  static getDerivedStateFromError(e) { return { error:e }; }
  componentDidCatch(e, i) { console.error('[ErrorBoundary]', e, i); }
  render() {
    if (this.state.error) return (
      <div style={{ padding:'60px 32px', maxWidth:540, margin:'0 auto' }}>
        <div style={{
          background:'var(--danger-dim)', border:'1px solid rgba(239,68,68,.3)',
          borderRadius:12, padding:'24px 28px',
        }}>
          <div style={{ fontWeight:700, fontSize:15, marginBottom:8, color:'var(--danger)' }}>Something went wrong</div>
          <div style={{ fontSize:13, color:'var(--text2)', marginBottom:16, lineHeight:1.7 }}>
            This page crashed. Try switching tabs or refreshing.
          </div>
          <code style={{ fontSize:11, color:'var(--text3)', display:'block', background:'var(--bg3)',
            borderRadius:6, padding:'10px 12px', wordBreak:'break-all' }}>
            {String(this.state.error?.message || this.state.error)}
          </code>
          <button onClick={() => this.setState({ error:null })}
            style={{ marginTop:16, padding:'7px 18px', background:'var(--accent)', color:'#fff',
              border:'none', borderRadius:8, fontSize:13, cursor:'pointer', fontWeight:600 }}>
            Try again
          </button>
        </div>
      </div>
    );
    return this.props.children;
  }
}

function Spinner() {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'var(--bg)', flexDirection:'column', gap:16 }}>
      <div style={{
        width:32, height:32,
        background:'var(--accent)',
        borderRadius:9, display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:14, fontWeight:800, color:'#fff',
      }}>N</div>
      <div style={{ width:24, height:24, border:'2px solid var(--border2)', borderTopColor:'var(--accent)', borderRadius:'50%', animation:'spin .8s linear infinite' }}/>
    </div>
  );
}

function Toast({ msg, type }) {
  const col = { success:'var(--success)', error:'var(--danger)', info:'var(--accent)', warn:'var(--warn)' }[type] || 'var(--border2)';
  return (
    <div style={{
      position:'fixed', bottom:20, right:20,
      background:'var(--bg2)', border:`1px solid ${col}`,
      borderRadius:10, padding:'10px 16px',
      display:'flex', alignItems:'center', gap:9,
      zIndex:9999, fontSize:13, fontWeight:500,
      animation:'fadein .2s ease',
      boxShadow:'var(--shadow-sm)',
      maxWidth:360,
    }}>
      <span style={{ width:6, height:6, borderRadius:'50%', background:col, flexShrink:0 }}/>
      {msg}
    </div>
  );
}
