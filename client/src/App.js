import React, { useState, useEffect, useCallback, useRef, Component } from 'react';
import {
  BrowserRouter, Routes, Route, Navigate,
  useLocation, useNavigate, useParams, Outlet, useOutletContext,
} from 'react-router-dom';
import { appStatus, verifyErpToken, getSyncStatus } from './utils/api';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import AiAssistant from './components/AiAssistant';
import AccessDeniedPage from './pages/AccessDeniedPage';

import OverviewPage      from './pages/OverviewPage';
import ChannelsPage      from './pages/ChannelsPage';
import SubsPage          from './pages/SubsPage';
import AiBuilderPage     from './pages/AiBuilderPage';
import SyncPage          from './pages/SyncPage';
import GenericDashPage   from './pages/GenericDashPage';
import LivePage          from './pages/LivePage';
import StoreNoblPage     from './pages/StoreNoblPage';
import StoreFLOPage      from './pages/StoreFLOPage';
import NoblAirPerformancePage from './pages/NoblAirPerformancePage';
import MetaAdsPage       from './pages/MetaAdsPage';

function normalizeTheme(t) {
  return 'light';
}
function getInitialTheme() {
  // The dashboard defaults to the white/light theme everywhere.
  try {
    const p = new URLSearchParams(window.location.search);
    const fromUrl = p.get('theme');
    if (fromUrl) return normalizeTheme(fromUrl);
  } catch {}
  try { return normalizeTheme(localStorage.getItem('nobl-theme') || 'light'); } catch { return 'light'; }
}
function applyTheme(theme) {
  const t = normalizeTheme(theme);
  try { document.documentElement.setAttribute('data-theme', t); } catch {}
  try { localStorage.setItem('nobl-theme', t); } catch {}
  return t;
}
function getSidebarState() {
  try { return localStorage.getItem('nobl-sidebar-collapsed') === 'true'; } catch { return false; }
}

/* Map between sidebar tab ids and URL paths */
const TAB_TO_PATH = {
  'Overview':             '/overview',
  'Channels':             '/channels',
  'Meta Ads':             '/meta-ads',
  'Subscriptions':        '/subscriptions',
  'Live Data':            '/live',
  'NOBL Air Performance': '/nobl-air-performance',
  'Store:NOBL':           '/store/nobl',
  'Store:FLO':            '/store/flo',
  '__builder':            '/aibuilder',
  '__sync':               '/sync',
};

function pathToActiveTab(pathname, dynamicTabs) {
  if (pathname === '/' || pathname === '/overview') return 'Overview';
  if (pathname.startsWith('/channels')) return 'Channels';
  if (pathname.startsWith('/meta-ads')) return 'Meta Ads';
  if (pathname.startsWith('/subscriptions')) return 'Subscriptions';
  if (pathname.startsWith('/live')) return 'Live Data';
  if (pathname.startsWith('/nobl-air-performance')) return 'NOBL Air Performance';
  if (pathname.startsWith('/store/nobl')) return 'Store:NOBL';
  if (pathname.startsWith('/store/flo')) return 'Store:FLO';
  if (pathname.startsWith('/aibuilder')) return '__builder';
  if (pathname.startsWith('/sync')) return '__sync';
  const m = pathname.match(/^\/(dashboard|sheet)\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[2]);
    const hit = (dynamicTabs || []).find(t => t.id === id);
    if (hit) return id;
  }
  return 'Overview';
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoot />
    </BrowserRouter>
  );
}

function AppRoot() {
  const [appUser, setAppUser] = useState(undefined);
  const [denyReason, setDenyReason] = useState(null); // 'no-token' | 'invalid' | 'expired' | 'network'

  // Boot: apply theme from URL hint (if any), then run ERP verify or fall back to session.
  useEffect(() => {
    const initial = getInitialTheme();
    applyTheme(initial);

    const params = new URLSearchParams(window.location.search);
    const token = params.get('_erp_token');
    const themeFromUrl = params.get('theme');

    // Strip these params from the URL once read so they don't linger in history/share.
    function scrubParams() {
      try {
        params.delete('_erp_token');
        params.delete('theme');
        const qs = params.toString();
        const url = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
        window.history.replaceState({}, document.title, url);
      } catch {}
    }

    async function boot() {
      // 1) ERP token in URL → consume it to mint a session
      if (token) {
        try {
          const r = await verifyErpToken(token, themeFromUrl || initial);
          scrubParams();
          if (r?.ok && r.user) {
            applyTheme(r.user.theme || initial);
            setAppUser(r.user);
            return;
          }
          setDenyReason('invalid');
          setAppUser(null);
          return;
        } catch (e) {
          scrubParams();
          // Distinguish "token rejected" from "couldn't reach upstream"
          const msg = String(e?.message || '');
          setDenyReason(/network|failed|fetch/i.test(msg) && !/expired|invalid/i.test(msg) ? 'network' : 'invalid');
          setAppUser(null);
          return;
        }
      }

      // 2) No token → look for an existing ERP session
      try {
        const s = await appStatus();
        if (s?.authenticated && s.user) {
          if (s.user.theme) applyTheme(s.user.theme);
          setAppUser(s.user);
          return;
        }
        setDenyReason(s?.expired ? 'expired' : 'no-token');
        setAppUser(null);
      } catch {
        setDenyReason('network');
        setAppUser(null);
      }
    }

    boot();
  }, []);

  if (appUser === undefined) return <Spinner />;
  if (!appUser) {
    return (
      <Routes>
        <Route path="*" element={<AccessDeniedPage reason={denyReason || 'no-token'} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout appUser={appUser} />}>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/login" element={<Navigate to="/overview" replace />} />
        <Route path="/overview"             element={<PageHost Comp={OverviewPage} />} />
        <Route path="/channels"             element={<PageHost Comp={ChannelsPage} />} />
        <Route path="/meta-ads"             element={<PageHost Comp={MetaAdsPage} />} />
        <Route path="/subscriptions"        element={<PageHost Comp={SubsPage} />} />
        <Route path="/live"                 element={<PageHost Comp={LivePage} />} />
        <Route path="/nobl-air-performance" element={<PageHost Comp={NoblAirPerformancePage} />} />
        <Route path="/store/nobl"           element={<PageHost Comp={StoreNoblPage} />} />
        <Route path="/store/flo"            element={<PageHost Comp={StoreFLOPage} />} />
        <Route path="/aibuilder"            element={<AiBuilderRoute />} />
        <Route path="/sync"                 element={<PageHost Comp={SyncPage} />} />
        <Route path="/dashboard/:id"        element={<DynamicDashRoute kind="dashboard" />} />
        <Route path="/sheet/:id"            element={<DynamicDashRoute kind="sheet" />} />
        <Route path="*"                     element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  );
}

/* ── Layout: sidebar + topbar + outlet ────────────────────────────── */
function Layout({ appUser }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [toast, setToast]                 = useState(null);
  const [refreshing, setRefreshing]       = useState(false);
  const [syncStatus, setSyncStatus]       = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(getSidebarState);
  const [dynamicTabs, setDynamicTabs]     = useState(() => {
    try { return JSON.parse(localStorage.getItem('nobl-dynamic-tabs') || '[]'); } catch { return []; }
  });

  // Theme is driven by the ERP — react to user.theme changes (re-launch with a different theme).
  useEffect(() => {
    if (appUser?.theme) applyTheme(appUser.theme);
  }, [appUser?.theme]);

  useEffect(() => {
    try { localStorage.setItem('nobl-sidebar-collapsed', sidebarCollapsed); } catch {}
  }, [sidebarCollapsed]);

  useEffect(() => {
    try { localStorage.setItem('nobl-dynamic-tabs', JSON.stringify(dynamicTabs)); } catch {}
  }, [dynamicTabs]);

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
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
  }, []);

  async function handleRefresh() {
    if (refreshing) return;
    if (appUser?.role !== 'admin') {
      showToast('Manual sync is admin-only. Daily auto-sync runs at 11 AM Pakistan time.', 'info');
      return;
    }
    setRefreshing(true);
    try {
      const res = await fetch('/api/sync/trigger-daily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        showToast('Manual sync is admin-only.', 'error');
      } else if (res.status === 429) {
        showToast(data.error || 'Rate limit reached — try again later', 'error');
      } else if (data.already_running) {
        showToast('A sync is already running — your click joined that run.', 'info');
      } else {
        showToast('Sync started — data will update in ~5 min.', 'success');
      }
    } catch {
      showToast('Failed to start sync', 'error');
    } finally {
      setTimeout(() => setRefreshing(false), 1500);
    }
  }

  function handleTabChange(tabId) {
    const path = TAB_TO_PATH[tabId];
    if (path) { navigate(path); return; }
    const dyn = dynamicTabs.find(t => t.id === tabId);
    if (dyn) {
      navigate(`/${dyn.type === 'sheet' ? 'sheet' : 'dashboard'}/${encodeURIComponent(dyn.id)}`);
    }
  }

  function handleAddDashboard() {
    navigate('/aibuilder');
  }

  function handleDashboardCreated(dash) {
    setDynamicTabs(prev => {
      const existing = prev.findIndex(t => t.id === dash.id);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = dash;
        return next;
      }
      return [...prev, dash];
    });
    showToast(`Dashboard "${dash.label}" created`, 'success');
    navigate(`/${dash.type === 'sheet' ? 'sheet' : 'dashboard'}/${encodeURIComponent(dash.id)}`);
  }

  function handleDeleteDynamic(id) {
    setDynamicTabs(prev => prev.filter(t => t.id !== id));
    const onThisOne =
      location.pathname === `/dashboard/${id}` ||
      location.pathname === `/sheet/${id}`;
    if (onThisOne) navigate('/overview');
    showToast('Removed', 'info');
  }

  function handleRenameDynamic(id, newLabel) {
    setDynamicTabs(prev => prev.map(t => t.id === id ? { ...t, label: newLabel } : t));
    showToast('Renamed', 'success');
  }

  function handleDuplicateDynamic(id) {
    setDynamicTabs(prev => {
      const orig = prev.find(t => t.id === id);
      if (!orig) return prev;
      const newId = orig.id + '_copy_' + Date.now();
      const copy = { ...orig, id: newId, label: (orig.label || orig.id) + ' (copy)' };
      return [...prev, copy];
    });
    showToast('Duplicated', 'success');
  }

  const activeTab = pathToActiveTab(location.pathname, dynamicTabs);
  const isBuilderRoute = location.pathname.startsWith('/aibuilder');
  const isSyncRoute    = location.pathname.startsWith('/sync');

  const topbarTitle =
    isSyncRoute    ? 'Sync Status' :
    isBuilderRoute ? 'AI Builder'  :
    activeTab;

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', background:'var(--bg)' }}>
      <Sidebar
        active={activeTab}
        onChange={handleTabChange}
        dynamicTabs={dynamicTabs}
        onAddDashboard={handleAddDashboard}
        onDeleteDynamic={handleDeleteDynamic}
        onRenameDynamic={handleRenameDynamic}
        onDuplicateDynamic={handleDuplicateDynamic}
        collapsed={sidebarCollapsed}
        onCollapse={() => setSidebarCollapsed(c => !c)}
      />

      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        <TopBar
          activeTab={topbarTitle}
          appUser={appUser}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          syncStatus={syncStatus}
          onOpenAiBuilder={() => navigate('/aibuilder')}
          onOpenSync={() => navigate('/sync')}
          dynamicTabs={dynamicTabs}
        />

        <main style={{ flex:1, overflowY: isBuilderRoute ? 'hidden' : 'auto', overflowX:'hidden', background:'var(--bg)', display:'flex', flexDirection:'column' }}>
          <div
            key={location.pathname}
            style={{
              width: '100%',
              maxWidth: isBuilderRoute ? 'none' : 1600,
              margin: isBuilderRoute ? 0 : '0 auto',
              boxSizing: 'border-box',
              padding: isBuilderRoute ? 0 : '20px 24px',
              flex: isBuilderRoute ? 1 : undefined,
              minHeight: isBuilderRoute ? 0 : undefined,
              display: isBuilderRoute ? 'flex' : 'block',
              flexDirection: isBuilderRoute ? 'column' : undefined,
              animation:'fadein .2s ease',
            }}
          >
            <ErrorBoundary key={location.pathname}>
              <Outlet context={{ showToast, dynamicTabs, onDashboardCreated: handleDashboardCreated }} />
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {toast && <Toast {...toast} />}
      <AiAssistant activeTab={activeTab} />
    </div>
  );
}

/* ── Route helpers ────────────────────────────────────────────────── */
function PageHost({ Comp }) {
  const { showToast } = useOutletContext();
  return <Comp showToast={showToast} />;
}

function AiBuilderRoute() {
  const { showToast, onDashboardCreated } = useOutletContext();
  return <AiBuilderPage showToast={showToast} onDashboardCreated={onDashboardCreated} />;
}

function DynamicDashRoute({ kind }) {
  const { showToast, dynamicTabs } = useOutletContext();
  const { id } = useParams();
  const decoded = decodeURIComponent(id || '');
  const tab = (dynamicTabs || []).find(t => t.id === decoded);
  if (!tab) {
    return (
      <div style={{ padding:'60px 32px', maxWidth:540, margin:'0 auto' }}>
        <div style={{
          background:'var(--bg3)', border:'1px solid var(--border2)',
          borderRadius:12, padding:'24px 28px',
        }}>
          <div style={{ fontWeight:700, fontSize:15, marginBottom:8, color:'var(--text)' }}>
            {kind === 'sheet' ? 'Sheet' : 'Dashboard'} not found
          </div>
          <div style={{ fontSize:13, color:'var(--text2)', lineHeight:1.7 }}>
            This {kind} isn't in your sidebar. It may have been removed, or this link was created on a different browser
            (custom dashboards are stored locally for now).
          </div>
        </div>
      </div>
    );
  }
  return <GenericDashPage tab={tab} showToast={showToast} />;
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
              border:'none', borderRadius:8, fontSize:12, fontWeight:600, cursor:'pointer' }}>
            Try again
          </button>
        </div>
      </div>
    );
    return this.props.children;
  }
}

/* ── Spinner / Toast ─────────────────────────────────────────────── */
function Spinner() {
  return (
    <div style={{ height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)' }}>
      <div style={{ width:32, height:32, border:'3px solid var(--border)', borderTopColor:'var(--accent)', borderRadius:'50%', animation:'spin .8s linear infinite' }} />
    </div>
  );
}

function Toast({ msg, type }) {
  const colors = {
    info:    { bg:'var(--accent-dim)', border:'var(--accent)',  text:'var(--accent)'  },
    success: { bg:'var(--success-dim)',border:'var(--success)', text:'var(--success)' },
    error:   { bg:'var(--danger-dim)', border:'var(--danger)',  text:'var(--danger)'  },
    warn:    { bg:'var(--warn-dim)',   border:'var(--warn)',    text:'var(--warn)'    },
  }[type] || { bg:'var(--bg3)', border:'var(--border2)', text:'var(--text)' };
  return (
    <div style={{
      position:'fixed', bottom:24, right:24, zIndex:2000,
      background:colors.bg, border:`1px solid ${colors.border}`,
      color:colors.text, padding:'10px 14px', borderRadius:8,
      fontSize:12, fontWeight:500, maxWidth:360,
      boxShadow:'var(--shadow)', animation:'fadein .2s ease',
    }}>
      {msg}
    </div>
  );
}
