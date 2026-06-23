import React, { useState, useEffect, useCallback, useRef, Component } from 'react';
import {
  BrowserRouter, Routes, Route, Navigate,
  useLocation, useNavigate, useParams, Outlet, useOutletContext,
} from 'react-router-dom';
import { appStatus, verifyErpToken, getSyncStatus } from './utils/api';
import TopBar from './components/TopBar';
import GlobalFilterBar from './components/GlobalFilterBar';
import Sidebar from './components/Sidebar';
import { DashboardFilterProvider } from './context/DashboardFilterContext';
import AiAssistant from './components/AiAssistant';
import { ToastProvider, useToast } from './components/ToastProvider';
import AccessDeniedPage from './pages/AccessDeniedPage';

import OverviewPage      from './pages/OverviewPage';
import ChannelsPage      from './pages/ChannelsPage';
import SubsPage          from './pages/SubsPage';
import AiBuilderPage     from './pages/AiBuilderPage';
import SyncPage          from './pages/SyncPage';
import GenericDashPage   from './pages/GenericDashPage';
import LivePage          from './pages/LivePage';
import KpiPulsePage      from './pages/KpiPulsePage';
import StoreNoblPage     from './pages/StoreNoblPage';
import StoreFLOPage      from './pages/StoreFLOPage';
import AppComingSoonPage from './pages/AppComingSoonPage';
import NoblAirPerformancePage from './pages/NoblAirPerformancePage';
import MetaAdsPage       from './pages/MetaAdsPage';
import ForecastEnginePage from './pages/ForecastEnginePage';
import ForecastVsActualsPage from './pages/ForecastVsActualsPage';
import FloToplinePage       from './pages/FloToplinePage';
import NoblToplinePage      from './pages/NoblToplinePage';
import NoblChannelDailyPage from './pages/NoblChannelDailyPage';
import FloChannelDailyPage  from './pages/FloChannelDailyPage';

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
  'KPI Pulse':            '/kpi-pulse',
  'NOBL Topline':         '/nobl-topline',
  'NOBL Channel Level Daily': '/nobl-channel-daily',
  'FLO Topline':          '/flo-topline',
  'FLO Channel Level Daily':  '/flo-channel-daily',
  'Forecast Engine':      '/forecast-engine',
  'Forecast vs Actuals':  '/forecast-vs-actuals',
  'NOBL Air Performance': '/nobl-air-performance',
  'Store:NOBL':           '/store/nobl',
  'Store:FLO':            '/store/flo',
  'App:NOBL':             '/app/nobl',
  'App:FLO':              '/app/flo',
  '__builder':            '/aibuilder',
  '__sync':               '/sync',
};

const TAB_DISPLAY_NAMES = {
  'Live Data':                "Today's snapshot",
  'KPI Pulse':                'KPI Pulse',
  'Meta Ads':                 'Facebook ads',
  'Forecast Engine':          'Sales forecast',
  'NOBL Channel Level Daily': 'NOBL Channel Daily',
  'FLO Channel Level Daily':  'FLO Channel Daily',
  'Store:NOBL':               'NOBL Travel',
  'Store:FLO':                'Pilates FLO',
  'App:NOBL':                 'NOBL Travel app',
  'App:FLO':                  'Pilates FLO app',
};

function pathToActiveTab(pathname, dynamicTabs) {
  if (pathname === '/' || pathname === '/overview') return 'Overview';
  if (pathname.startsWith('/channels')) return 'Channels';
  if (pathname.startsWith('/meta-ads')) return 'Meta Ads';
  if (pathname.startsWith('/subscriptions')) return 'Subscriptions';
  if (pathname.startsWith('/live')) return 'Live Data';
  if (pathname.startsWith('/kpi-pulse')) return 'KPI Pulse';
  if (pathname.startsWith('/nobl-topline')) return 'NOBL Topline';
  if (pathname.startsWith('/nobl-channel-daily')) return 'NOBL Channel Level Daily';
  if (pathname.startsWith('/flo-topline')) return 'FLO Topline';
  if (pathname.startsWith('/flo-channel-daily')) return 'FLO Channel Level Daily';
  if (pathname.startsWith('/forecast-vs-actuals')) return 'Forecast vs Actuals';
  if (pathname.startsWith('/forecast-engine')) return 'Forecast Engine';
  if (pathname.startsWith('/nobl-air-performance')) return 'NOBL Air Performance';
  if (pathname.startsWith('/store/nobl')) return 'Store:NOBL';
  if (pathname.startsWith('/store/flo')) return 'Store:FLO';
  if (pathname.startsWith('/app/nobl')) return 'App:NOBL';
  if (pathname.startsWith('/app/flo')) return 'App:FLO';
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
    <ToastProvider>
    <Routes>
      <Route element={<Layout appUser={appUser} />}>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/login" element={<Navigate to="/overview" replace />} />
        <Route path="/overview"             element={<PageHost Comp={OverviewPage} />} />
        <Route path="/channels"             element={<PageHost Comp={ChannelsPage} />} />
        <Route path="/meta-ads"             element={<PageHost Comp={MetaAdsPage} />} />
        <Route path="/subscriptions"        element={<PageHost Comp={SubsPage} />} />
        <Route path="/live"                 element={<PageHost Comp={LivePage} />} />
        <Route path="/kpi-pulse"            element={<PageHost Comp={KpiPulsePage} />} />
        <Route path="/nobl-topline"           element={<PageHost Comp={NoblToplinePage} />} />
        <Route path="/nobl-channel-daily"     element={<PageHost Comp={NoblChannelDailyPage} />} />
        <Route path="/flo-topline"            element={<PageHost Comp={FloToplinePage} />} />
        <Route path="/flo-channel-daily"      element={<PageHost Comp={FloChannelDailyPage} />} />
        <Route path="/forecast-engine"      element={<PageHost Comp={ForecastEnginePage} />} />
        <Route path="/forecast-vs-actuals"  element={<PageHost Comp={ForecastVsActualsPage} />} />
        <Route path="/nobl-air-performance" element={<PageHost Comp={NoblAirPerformancePage} />} />
        <Route path="/store/nobl"           element={<PageHost Comp={StoreNoblPage} />} />
        <Route path="/store/flo"            element={<PageHost Comp={StoreFLOPage} />} />
        <Route path="/app/nobl"             element={<PageHost Comp={NoblAppPage} />} />
        <Route path="/app/flo"              element={<PageHost Comp={FloAppPage} />} />
        <Route path="/aibuilder"            element={<AiBuilderRoute />} />
        <Route path="/sync"                 element={<PageHost Comp={SyncPage} />} />
        <Route path="/dashboard/:id"        element={<DynamicDashRoute kind="dashboard" />} />
        <Route path="/sheet/:id"            element={<DynamicDashRoute kind="sheet" />} />
        <Route path="*"                     element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
    </ToastProvider>
  );
}

/* ── Layout: sidebar + topbar + outlet ────────────────────────────── */
function Layout({ appUser }) {
  const location = useLocation();
  const navigate = useNavigate();
  const toastApi = useToast();
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
    toastApi?.show(msg, type);
  }, [toastApi]);

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
    TAB_DISPLAY_NAMES[activeTab] || activeTab;

  return (
    <DashboardFilterProvider pageKey={location.pathname}>
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', background:'var(--bg)' }}>
      <Sidebar
        active={activeTab}
        appUser={appUser}
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

        <main className={`app-main${isBuilderRoute ? ' app-main--fill' : ''}`}>
          <div
            key={location.pathname}
            className={isBuilderRoute ? 'page-content page-content--fill' : 'page-content'}
          >
            <GlobalFilterBar pathname={location.pathname} />
            <ErrorBoundary key={location.pathname}>
              <Outlet context={{ showToast, dynamicTabs, onDashboardCreated: handleDashboardCreated }} />
            </ErrorBoundary>
          </div>
        </main>
      </div>

      <AiAssistant activeTab={activeTab} />
    </div>
    </DashboardFilterProvider>
  );
}

/* ── Route helpers ────────────────────────────────────────────────── */
function PageHost({ Comp }) {
  const { showToast } = useOutletContext();
  return <Comp showToast={showToast} />;
}

function NoblAppPage() {
  return <AppComingSoonPage brand="nobl" />;
}

function FloAppPage() {
  return <AppComingSoonPage brand="flo" />;
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
