import React, { useState } from 'react';
import { Icons, sheetIcon } from './Icons';

/* ── Navigation sections (tab ids must match App.js TAB_TO_PATH) ─── */

const OVERVIEW_TABS = [
  { id: 'Overview',  icon: Icons.LayoutDashboard, label: 'Overview',           title: 'All brands — high-level KPIs and trends' },
  { id: 'Live Data', icon: Icons.Zap,             label: "Today's snapshot",   title: 'Real-time sales snapshot for today' },
  { id: 'KPI Pulse', icon: Icons.Activity,        label: 'KPI Pulse',          title: 'Daily, weekly, and quarterly leadership KPIs' },
  { id: 'Forecast vs Actuals', icon: Icons.Crosshair, label: 'Forecast vs Actuals', title: 'Actuals vs forecast with red/green variance — monthly & daily' },
];

const NOBL_TRAVEL_TABS = [
  { id: 'NOBL Topline',             icon: Icons.BarChart3, label: 'NOBL Topline',       title: 'Daily revenue, spend, and MER for NOBL Travel' },
  { id: 'NOBL Channel Level Daily', icon: Icons.Layers,    label: 'NOBL Channel Daily', title: 'Channel-by-channel daily breakdown — NOBL Travel' },
  { id: 'Store:NOBL',               icon: Icons.Store,     label: 'NOBL Travel',        title: 'Full store view — channels, products, subs, email' },
];

const PILATES_FLO_TABS = [
  { id: 'FLO Topline',              icon: Icons.BarChart3, label: 'FLO Topline',        title: 'Daily revenue, spend, and MER for Pilates FLO' },
  { id: 'FLO Channel Level Daily',  icon: Icons.Layers,    label: 'FLO Channel Daily',  title: 'Channel-by-channel daily breakdown — Pilates FLO' },
  { id: 'Store:FLO',                icon: Icons.Store,     label: 'Pilates FLO',        title: 'Full store view — channels, products, subs, email' },
];

const MARKETING_TABS = [
  { id: 'Channels',      icon: Icons.BarChart2,  label: 'Channels',       title: 'Paid media overview — Meta, Google, TikTok, and more' },
  { id: 'Meta Ads',      icon: Icons.Crosshair,  label: 'Facebook ads',   title: 'Facebook & Instagram campaign performance' },
  { id: 'Subscriptions', icon: Icons.CreditCard, label: 'Subscriptions',  title: 'Subscription revenue, MRR, and cohort trends' },
];

const NOBL_AIR_TABS = [
  { id: 'NOBL Air Performance', icon: Icons.Activity,   label: 'NOBL Air Performance', title: 'Air product attach rate, revenue, and conversion' },
  { id: 'Forecast Engine',      icon: Icons.TrendingUp, label: 'Sales forecast',       title: 'Plan vs actual and full-year sales projection' },
];

const APPLICATION_TABS = [
  { id: 'App:NOBL', icon: Icons.Smartphone, label: 'NOBL Travel app', title: 'NOBL Travel app — in-app purchases and subscriptions' },
  { id: 'App:FLO',  icon: Icons.Smartphone, label: 'Pilates FLO app', title: 'Pilates FLO app — in-app purchases and subscriptions' },
];

/* ── Confirm delete dialog ─────────────────────────────────────────── */
function ConfirmDelete({ label, onConfirm, onCancel }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(20,16,10,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ padding: '22px 24px', width: 320, boxShadow: 'var(--shadow)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Remove dashboard</div>
        <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 20 }}>
          Remove <strong>"{label}"</strong> from the sidebar? The saved config will be deleted.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} className="btn btn--sm">Cancel</button>
          <button onClick={onConfirm} className="btn btn--sm" style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}>Remove</button>
        </div>
      </div>
    </div>
  );
}

/* ── Three-dots menu ───────────────────────────────────────────────── */
function DashboardMenu({ onRename, onDuplicate, onShare, onDelete, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
      <div onClick={e => e.stopPropagation()} className="card" style={{
        position: 'absolute', right: 6, top: '100%', marginTop: 2, zIndex: 1000,
        minWidth: 160, padding: '4px 0', boxShadow: 'var(--shadow)',
      }}>
        {[
          { label: 'Rename',    icon: '✎', action: onRename },
          { label: 'Duplicate', icon: '⎘', action: onDuplicate },
          { label: 'Share…',    icon: '↗', action: onShare },
          { label: 'Delete',    icon: '✕', action: onDelete, danger: true },
        ].map((item, i, arr) => (
          <React.Fragment key={item.label}>
            {i === arr.length - 1 && <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />}
            <button
              onClick={() => { onClose(); item.action?.(); }}
              style={{
                width: '100%', textAlign: 'left', padding: '7px 12px', fontSize: 12,
                background: 'none', border: 'none', cursor: 'pointer',
                color: item.danger ? 'var(--danger)' : 'var(--text2)',
                display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-body)',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              <span style={{ width: 14, opacity: 0.7 }}>{item.icon}</span>
              {item.label}
            </button>
          </React.Fragment>
        ))}
      </div>
    </>
  );
}

/* ── Rename / Share modals ─────────────────────────────────────────── */
function RenameModal({ initial, onSave, onCancel }) {
  const [val, setVal] = useState(initial || '');
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(20,16,10,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ padding: '22px 24px', width: 360 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Rename dashboard</div>
        <input
          autoFocus value={val} onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSave(val.trim()); }}
          style={{ width: '100%', padding: '9px 11px', fontSize: 13, background: 'var(--bg3)',
                   border: '1px solid var(--border2)', borderRadius: 'var(--radius)', color: 'var(--text)',
                   marginBottom: 18, fontFamily: 'var(--font-body)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} className="btn btn--sm">Cancel</button>
          <button onClick={() => onSave(val.trim())} disabled={!val.trim()} className="btn btn--sm btn--primary">Save</button>
        </div>
      </div>
    </div>
  );
}

function ShareModal({ label, onCancel }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(20,16,10,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ padding: '22px 24px', width: 420 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Share "{label}"</div>
        <div style={{ fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.6, marginBottom: 16 }}>
          Sharing with other team members (Google Docs–style permissions + access requests)
          is coming in the next update. For now, dashboards are private to your account.
        </div>
        <input placeholder="email@nysonian.com" disabled style={{ width: '100%', padding: '9px 11px', fontSize: 13,
            background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 'var(--radius)',
            color: 'var(--text3)', marginBottom: 16, fontFamily: 'var(--font-body)' }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="btn btn--sm">Close</button>
        </div>
      </div>
    </div>
  );
}

/* ── Nav item ──────────────────────────────────────────────────────── */
function NavItem({ id, label, icon: IconComp, title: hint, active, collapsed, onClick, onDelete, onRename, onDuplicate, isDynamic }) {
  const [hov, setHov] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [sharing, setSharing] = useState(false);
  const isAct = active === id;

  return (
    <>
      {confirmId && (
        <ConfirmDelete label={label}
          onConfirm={() => { setConfirmId(null); onDelete?.(id); }}
          onCancel={() => setConfirmId(null)} />
      )}
      {renaming && (
        <RenameModal initial={label}
          onSave={(newLabel) => { setRenaming(false); if (newLabel && newLabel !== label) onRename?.(id, newLabel); }}
          onCancel={() => setRenaming(false)} />
      )}
      {sharing && <ShareModal label={label} onCancel={() => setSharing(false)} />}

      <div style={{ position: 'relative' }} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
        <button
          onClick={() => onClick(id)}
          title={collapsed ? label : (hint || label)}
          className={`nav-item${isAct ? ' nav-item--active' : ''}`}
        >
          {IconComp && <span className="nav-item__icon"><IconComp size={15} /></span>}
          {!collapsed && <span className="nav-item__label">{label}</span>}
        </button>

        {isDynamic && !collapsed && (hov || menuOpen) && (
          <button className="nav-item__menu" title="More options"
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}>⋯</button>
        )}
        {menuOpen && (
          <DashboardMenu
            onClose={() => setMenuOpen(false)}
            onRename={() => setRenaming(true)}
            onDuplicate={() => onDuplicate?.(id)}
            onShare={() => setSharing(true)}
            onDelete={() => setConfirmId(id)}
          />
        )}
      </div>
    </>
  );
}

function NavSection({ label, tabs, collapsed, active, onChange }) {
  return (
    <div className="sidebar__group">
      {!collapsed && <div className="sidebar__group-label">{label}</div>}
      {tabs.map(tab => (
        <NavItem key={tab.id} {...tab} active={active} collapsed={collapsed} onClick={onChange} />
      ))}
    </div>
  );
}

/* ── Main sidebar ──────────────────────────────────────────────────── */
export default function Sidebar({ active, onChange, dynamicTabs, onAddDashboard, onDeleteDynamic, onRenameDynamic, onDuplicateDynamic, collapsed, onCollapse, appUser }) {
  const dynDashboards = (dynamicTabs || []).filter(t => t.type === 'dashboard');
  const dynSheets     = (dynamicTabs || []).filter(t => t.type === 'sheet');

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      {/* Workspace header */}
      <div className="sidebar__brand">
        <div className="sidebar__logo">N</div>
        {!collapsed && (
          <div style={{ minWidth: 0 }}>
            <div className="sidebar__brand-name">Nysonian</div>
            <div className="sidebar__brand-sub">Marketing Hub</div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="sidebar__nav hide-scrollbar">
        <NavSection label="Overview & Live" tabs={OVERVIEW_TABS} collapsed={collapsed} active={active} onChange={onChange} />
        <NavSection label="NOBL Travel"     tabs={NOBL_TRAVEL_TABS} collapsed={collapsed} active={active} onChange={onChange} />
        <NavSection label="Pilates FLO"     tabs={PILATES_FLO_TABS} collapsed={collapsed} active={active} onChange={onChange} />
        <NavSection label="Marketing"       tabs={MARKETING_TABS} collapsed={collapsed} active={active} onChange={onChange} />
        <NavSection label="NOBL Air"        tabs={NOBL_AIR_TABS} collapsed={collapsed} active={active} onChange={onChange} />
        <NavSection label="In-app purchases" tabs={APPLICATION_TABS} collapsed={collapsed} active={active} onChange={onChange} />

        {/* Custom dashboards & sheets */}
        <div className="sidebar__group">
          {!collapsed && (
            <div className="sidebar__group-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Custom</span>
              <button onClick={onAddDashboard} title="Build a new custom dashboard with AI"
                style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px', fontSize: 10.5,
                  background: 'none', border: '1px solid var(--border2)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text3)', cursor: 'pointer', letterSpacing: 0, textTransform: 'none', fontWeight: 600 }}>
                <Icons.Plus size={10} /> New
              </button>
            </div>
          )}
          {dynDashboards.length === 0 && !collapsed && (
            <button onClick={onAddDashboard} className="nav-item" style={{ border: '1px dashed var(--border2)', color: 'var(--text3)' }}>
              <span className="nav-item__icon"><Icons.Plus size={14} /></span>
              <span className="nav-item__label">Build a dashboard</span>
            </button>
          )}
          {dynDashboards.map(tab => (
            <NavItem key={tab.id} id={tab.id} label={tab.label || tab.id} icon={Icons.LayoutGrid}
              title="Custom dashboard — built with AI Builder" active={active} collapsed={collapsed}
              onClick={onChange} onDelete={onDeleteDynamic} onRename={onRenameDynamic} onDuplicate={onDuplicateDynamic} isDynamic />
          ))}
          {dynSheets.map(tab => (
            <NavItem key={tab.id} id={tab.id} label={tab.label || tab.id} icon={sheetIcon(tab.label || tab.id)}
              title="Custom spreadsheet — built with AI Builder" active={active} collapsed={collapsed}
              onClick={onChange} onDelete={onDeleteDynamic} onRename={onRenameDynamic} onDuplicate={onDuplicateDynamic} isDynamic />
          ))}
        </div>
      </div>

      {/* Footer: user + collapse */}
      <div className="sidebar__footer">
        {appUser && (
          <div className="sidebar__user">
            <div className="sidebar__avatar">{(appUser.name || 'U').charAt(0).toUpperCase()}</div>
            {!collapsed && (
              <div style={{ minWidth: 0 }}>
                <div className="sidebar__user-name">{appUser.name || 'User'}</div>
                <div className="sidebar__user-role" style={{ color: appUser.role === 'admin' ? 'var(--accent)' : 'var(--text4)' }}>{appUser.role}</div>
              </div>
            )}
          </div>
        )}
        <button className="sidebar__collapse" onClick={onCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed
            ? <Icons.ChevronRight size={14} />
            : <><Icons.ChevronLeft size={14} /><span>Collapse</span></>}
        </button>
      </div>
    </aside>
  );
}
