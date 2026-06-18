import React from 'react';
import { Icons } from './Icons';

const PAGE_INFO = {
  'Overview':                 'All brands — high-level KPIs and trends',
  'Live Data':                'Real-time sales snapshot for today',
  'Channels':                 'Paid media overview — Meta, Google, TikTok, and more',
  'Meta Ads':                 'Facebook & Instagram campaign performance',
  'Subscriptions':            'Subscription revenue, MRR, and cohort trends',
  'NOBL Topline':             'Daily revenue, spend, and MER for NOBL Travel',
  'NOBL Channel Level Daily': 'Channel-by-channel daily breakdown — NOBL Travel',
  'FLO Topline':              'Daily revenue, spend, and MER for Pilates FLO',
  'FLO Channel Level Daily':  'Channel-by-channel daily breakdown — Pilates FLO',
  'NOBL Air Performance':     'Air product attach rate, revenue, and conversion',
  'Forecast Engine':          'Plan vs actual and full-year sales projection',
  'Store:NOBL':               'Full store view — channels, products, subs, email',
  'Store:FLO':                'Full store view — channels, products, subs, email',
  'App:NOBL':                 'NOBL Travel app — in-app purchases and subscriptions',
  'App:FLO':                  'Pilates FLO app — in-app purchases and subscriptions',
};

export default function TopBar({
  activeTab, appUser,
  onRefresh, refreshing, syncStatus,
  onOpenAiBuilder, onOpenSync,
  dynamicTabs,
}) {
  const dynTab  = (dynamicTabs || []).find(t => t.id === activeTab);
  const title   = dynTab ? (dynTab.label || dynTab.id) : (activeTab || 'Dashboard');
  const subtitle = dynTab
    ? (dynTab.subtitle || 'Custom dashboard')
    : (PAGE_INFO[activeTab] || '');

  const syncDot = {
    ok:    { color: 'var(--success)', title: 'Synced < 1h ago' },
    warn:  { color: 'var(--warn)',    title: 'Last sync > 1h ago' },
    error: { color: 'var(--danger)',  title: 'Sync failed' },
  }[syncStatus];

  return (
    <header className="topbar">
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="topbar__title">{title}</div>
        {subtitle && <div className="topbar__sub">{subtitle}</div>}
      </div>

      <div className="topbar__actions">
        <button className={`btn btn--sm${activeTab === 'AI Builder' ? ' btn--primary' : ''}`}
          onClick={onOpenAiBuilder} title="Build dashboards with AI">
          <Icons.Wand size={13} /> AI Builder
        </button>

        <div className="topbar__sep" />

        <span className="topbar__sync" title={syncDot?.title || 'Sync status — runs daily at 11 AM Pakistan time'}>
          {syncDot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: syncDot.color, flexShrink: 0 }} />}
          {refreshing ? 'Syncing…' : 'Auto-sync 11 AM PKT'}
        </span>

        {appUser?.role === 'admin' && (
          <button className="btn btn--sm" onClick={onRefresh} disabled={refreshing}
            title="Manually trigger sync (admin only — rate-limited to 6/hour)">
            <Icons.RefreshCw size={13} /> {refreshing ? 'Syncing' : 'Sync now'}
          </button>
        )}

        <button className={`btn btn--sm${activeTab === 'Sync Status' ? ' btn--primary' : ''}`}
          onClick={onOpenSync} title="Sync status" style={{ paddingLeft: 9, paddingRight: 9 }}>
          <Icons.Database size={13} />
        </button>
      </div>
    </header>
  );
}
