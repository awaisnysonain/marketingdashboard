import React, { useState } from 'react';
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
  'App:NOBL':                 'NOBL mobile app — revenue and subscriptions',
  'App:FLO':                  'Pilates FLO app — revenue and product performance',
};

function HeaderBtn({ icon: Ic, label, onClick, danger, title: ttl, disabled, active, small }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      title={ttl || label}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: label ? 5 : 0,
        padding: small ? '4px 8px' : label ? '5px 10px' : '5px 7px',
        background: active
          ? 'var(--accent-dim)'
          : hov ? 'var(--bg3)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : hov ? 'var(--border2)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        color: active ? 'var(--accent)' : danger && hov ? 'var(--danger)' : hov ? 'var(--text)' : 'var(--text2)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-body)',
        transition: 'border-color .12s, background .12s, color .12s',
        whiteSpace: 'nowrap',
        lineHeight: 1,
      }}
    >
      <Ic size={12} />
      {label && <span>{label}</span>}
    </button>
  );
}

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
    <header style={{
      height: 'var(--topbar-h)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 var(--page-px)',
      background: 'var(--bg2)',
      borderBottom: '1px solid var(--border)',
      position: 'sticky', top: 0, zIndex: 300,
      gap: 12, flexShrink: 0,
    }}>
      {/* Page title */}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--text)',
          lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {title}
        </div>
        {subtitle && (
          <div style={{
            fontSize: 11, color: 'var(--text3)', lineHeight: 1.3,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1,
          }}>
            {subtitle}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>

        {/* AI Builder */}
        <HeaderBtn
          icon={Icons.Wand}
          label="AI Builder"
          onClick={onOpenAiBuilder}
          title="Build dashboards with AI"
          active={activeTab === 'AI Builder'}
        />

        <div style={{ width: 1, height: 16, background: 'var(--border2)', margin: '0 1px' }} />

        {/* Sync dot — passive status indicator (visible to all) */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 6px' }}
          title={syncDot?.title || 'Sync status — runs daily at 11 AM Pakistan time'}
        >
          {syncDot && (
            <span style={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: syncDot.color,
            }} />
          )}
          <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
            {refreshing ? 'Syncing…' : 'Auto-sync 11 AM PKT'}
          </span>
        </div>

        {/* Manual Sync button — admin only */}
        {appUser?.role === 'admin' && (
          <HeaderBtn
            icon={Icons.RefreshCw}
            label={refreshing ? 'Syncing' : 'Sync now'}
            onClick={onRefresh}
            disabled={refreshing}
            title="Manually trigger sync (admin only — rate-limited to 6/hour)"
            small
          />
        )}

        {/* Sync status detail */}
        <HeaderBtn icon={Icons.Database} onClick={onOpenSync} title="Sync status" active={activeTab === 'Sync Status'} />

        <div style={{ width: 1, height: 16, background: 'var(--border2)', margin: '0 1px' }} />

        {/* User */}
        {appUser && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 8px 4px 4px',
            background: 'var(--bg3)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              background: 'var(--accent)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700,
            }}>
              {(appUser.name || 'U').charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.2 }}>
                {appUser.name}
              </div>
              <div style={{ fontSize: 9, color: appUser.role === 'admin' ? 'var(--accent)' : 'var(--text3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', lineHeight: 1.2 }}>
                {appUser.role}
              </div>
            </div>
          </div>
        )}

      </div>
    </header>
  );
}
