import React, { useState } from 'react';
import { Icons, sheetIcon } from './Icons';

/* ── Navigation sections (tab ids must match App.js TAB_TO_PATH) ─── */

const OVERVIEW_TABS = [
  { id: 'Overview',  icon: Icons.LayoutDashboard, label: 'Overview',           title: 'All brands — high-level KPIs and trends' },
  { id: 'Live Data', icon: Icons.Zap,             label: "Today's snapshot",   title: 'Real-time sales snapshot for today' },
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
  { id: 'App:NOBL', icon: Icons.Smartphone, label: 'Nobl app', title: 'NOBL mobile app — revenue and subscriptions' },
  { id: 'App:FLO',  icon: Icons.Smartphone, label: 'Flo app',  title: 'Pilates FLO app — revenue and product performance' },
];

/* ── Confirm delete dialog ─────────────────────────────────────────── */
function ConfirmDelete({ label, onConfirm, onCancel }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onCancel}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg2)', border: '1px solid var(--border2)',
          borderRadius: 'var(--radius-lg)', padding: '22px 24px',
          width: 320, boxShadow: 'var(--shadow)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
          Remove dashboard
        </div>
        <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 20 }}>
          Remove <strong>"{label}"</strong> from the sidebar? The saved config will be deleted.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 500,
              background: 'none', border: '1px solid var(--border2)',
              borderRadius: 'var(--radius)', color: 'var(--text2)', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 600,
              background: 'var(--danger)', border: '1px solid var(--danger)',
              borderRadius: 'var(--radius)', color: '#fff', cursor: 'pointer',
            }}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Three-dots menu ───────────────────────────────────────────────── */
function DashboardMenu({ onRename, onDuplicate, onShare, onDelete, onClose }) {
  return (
    <>
      {/* Click-outside catcher */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 999 }}
      />
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute', right: 6, top: '100%', marginTop: 2, zIndex: 1000,
          background: 'var(--bg2)', border: '1px solid var(--border2)',
          borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)',
          minWidth: 160, padding: '4px 0',
        }}
      >
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
                width: '100%', textAlign: 'left',
                padding: '7px 12px', fontSize: 12,
                background: 'none', border: 'none',
                color: item.danger ? 'var(--danger)' : 'var(--text2)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                fontFamily: 'var(--font-body)',
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
          background: 'var(--bg2)', border: '1px solid var(--border2)',
          borderRadius: 'var(--radius-lg)', padding: '22px 24px', width: 360 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Rename dashboard</div>
        <input
          autoFocus value={val} onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSave(val.trim()); }}
          style={{ width: '100%', padding: '8px 10px', fontSize: 13,
                   background: 'var(--bg3)', border: '1px solid var(--border2)',
                   borderRadius: 'var(--radius)', color: 'var(--text)',
                   marginBottom: 18, fontFamily: 'var(--font-body)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} style={{ padding: '6px 14px', fontSize: 12,
              background: 'none', border: '1px solid var(--border2)',
              borderRadius: 'var(--radius)', color: 'var(--text2)', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => onSave(val.trim())} disabled={!val.trim()} style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 600,
              background: 'var(--accent)', border: '1px solid var(--accent)',
              borderRadius: 'var(--radius)', color: '#fff', cursor: 'pointer',
              opacity: val.trim() ? 1 : 0.5 }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function ShareModal({ label, onCancel }) {
  // Placeholder UI — full sharing will land in a follow-up session.
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
          background: 'var(--bg2)', border: '1px solid var(--border2)',
          borderRadius: 'var(--radius-lg)', padding: '22px 24px', width: 420 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Share "{label}"</div>
        <div style={{ fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.6, marginBottom: 16 }}>
          Sharing with other team members (Google Docs–style permissions + access requests)
          is coming in the next update. For now, dashboards are private to your account.
        </div>
        <input placeholder="email@nysonian.com" disabled style={{ width: '100%',
            padding: '8px 10px', fontSize: 13, background: 'var(--bg3)',
            border: '1px solid var(--border2)', borderRadius: 'var(--radius)',
            color: 'var(--text3)', marginBottom: 16, fontFamily: 'var(--font-body)' }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '6px 14px', fontSize: 12,
              background: 'var(--bg3)', border: '1px solid var(--border2)',
              borderRadius: 'var(--radius)', color: 'var(--text2)', cursor: 'pointer' }}>Close</button>
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
        <ConfirmDelete
          label={label}
          onConfirm={() => { setConfirmId(null); onDelete?.(id); }}
          onCancel={() => setConfirmId(null)}
        />
      )}
      {renaming && (
        <RenameModal
          initial={label}
          onSave={(newLabel) => { setRenaming(false); if (newLabel && newLabel !== label) onRename?.(id, newLabel); }}
          onCancel={() => setRenaming(false)}
        />
      )}
      {sharing && (
        <ShareModal label={label} onCancel={() => setSharing(false)} />
      )}
      <div
        style={{ position: 'relative' }}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
      >
        <button
          onClick={() => onClick(id)}
          title={collapsed ? label : (hint || label)}
          style={{
            width: '100%',
            display: 'flex', alignItems: 'center',
            gap: collapsed ? 0 : 8,
            padding: collapsed ? '8px 0' : '7px 10px',
            justifyContent: collapsed ? 'center' : 'flex-start',
            background: isAct ? 'var(--accent-dim)' : hov ? 'var(--bg3)' : 'transparent',
            border: 'none',
            borderLeft: `2px solid ${isAct ? 'var(--accent)' : 'transparent'}`,
            borderRadius: '0 var(--radius) var(--radius) 0',
            color: isAct ? 'var(--accent)' : hov ? 'var(--text)' : 'var(--text2)',
            fontSize: 12, fontWeight: isAct ? 600 : 400,
            cursor: 'pointer',
            transition: 'all .12s',
            fontFamily: 'var(--font-body)',
            textAlign: 'left',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            paddingLeft: collapsed ? 0 : (isAct ? 8 : 10),
          }}
        >
          {!IconComp ? null : <IconComp size={14} style={{ flexShrink: 0 }} />}
          {!collapsed && (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
              {label}
            </span>
          )}
        </button>

        {/* Three-dots menu (dynamic tabs only) */}
        {isDynamic && !collapsed && (hov || menuOpen) && (
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
            title="More options"
            style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              background: menuOpen ? 'var(--bg4)' : 'var(--bg4)',
              border: '1px solid var(--border2)',
              borderRadius: 4, width: 20, height: 20,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--text2)',
              fontSize: 14, lineHeight: 0.5,
              transition: 'color .12s',
            }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text2)'}
          >
            ⋯
          </button>
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

/* ── Section label ─────────────────────────────────────────────────── */
function SectionLabel({ label, collapsed, action, first }) {
  if (collapsed) return <div style={{ height: 1, background: 'var(--border)', margin: '10px 0' }} />;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: first ? '10px 10px 4px' : '14px 10px 4px',
      borderTop: first ? 'none' : '1px solid var(--border)',
      marginTop: first ? 0 : 2,
    }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text4)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {label}
      </span>
      {action}
    </div>
  );
}

function NavSection({ label, tabs, collapsed, active, onChange, action, first }) {
  return (
    <>
      <SectionLabel label={label} collapsed={collapsed} action={action} first={first} />
      <div>
        {tabs.map(tab => (
          <NavItem key={tab.id} {...tab} active={active} collapsed={collapsed} onClick={onChange} />
        ))}
      </div>
    </>
  );
}

/* ── Main sidebar ──────────────────────────────────────────────────── */
export default function Sidebar({ active, onChange, dynamicTabs, onAddDashboard, onDeleteDynamic, onRenameDynamic, onDuplicateDynamic, collapsed, onCollapse }) {
  const dynDashboards = (dynamicTabs || []).filter(t => t.type === 'dashboard');
  const dynSheets     = (dynamicTabs || []).filter(t => t.type === 'sheet');

  return (
    <aside style={{
      width: collapsed ? 'var(--sidebar-collapsed)' : 'var(--sidebar-w)',
      minWidth: collapsed ? 'var(--sidebar-collapsed)' : 'var(--sidebar-w)',
      background: 'var(--bg2)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      transition: 'width .18s ease, min-width .18s ease',
      overflow: 'hidden',
      flexShrink: 0,
    }}>

      {/* Brand */}
      <div style={{
        height: 'var(--topbar-h)',
        display: 'flex', alignItems: 'center',
        padding: collapsed ? '0' : '0 12px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0, gap: 9,
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: 6, flexShrink: 0,
          background: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700, color: '#fff',
        }}>N</div>
        {!collapsed && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.2 }}>Nysonian</div>
            <div style={{ fontSize: 9.5, fontWeight: 500, color: 'var(--text4)', textTransform: 'uppercase', letterSpacing: '.1em', lineHeight: 1.3 }}>
              Marketing Hub
            </div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: collapsed ? '8px 0' : '4px 0' }}
        className="hide-scrollbar">

        {collapsed && <div style={{ height: 8 }} />}

        <NavSection label="Overview & Live" tabs={OVERVIEW_TABS} collapsed={collapsed} active={active} onChange={onChange} first />
        <NavSection label="NOBL Travel" tabs={NOBL_TRAVEL_TABS} collapsed={collapsed} active={active} onChange={onChange} />
        <NavSection label="Pilates FLO" tabs={PILATES_FLO_TABS} collapsed={collapsed} active={active} onChange={onChange} />
        <NavSection label="Marketing" tabs={MARKETING_TABS} collapsed={collapsed} active={active} onChange={onChange} />
        <NavSection label="NOBL Air" tabs={NOBL_AIR_TABS} collapsed={collapsed} active={active} onChange={onChange} />
        <NavSection label="Mobile apps" tabs={APPLICATION_TABS} collapsed={collapsed} active={active} onChange={onChange} />

        {/* Custom dashboards & sheets */}
        <SectionLabel
          label="Custom"
          collapsed={collapsed}
          action={!collapsed && (
            <button
              onClick={onAddDashboard}
              title="Build a new custom dashboard with AI"
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '2px 7px', fontSize: 11,
                background: 'none', border: '1px solid var(--border2)',
                borderRadius: 4, color: 'var(--text3)', cursor: 'pointer',
                transition: 'all .12s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text3)'; e.currentTarget.style.borderColor = 'var(--border2)'; }}
            >
              <Icons.Plus size={10} /> New
            </button>
          )}
        />

        <div>
          {dynDashboards.length === 0 && !collapsed && (
            <button
              onClick={onAddDashboard}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '7px 10px', width: '100%',
                background: 'none', border: '1px dashed var(--border)',
                borderRadius: 0, color: 'var(--text3)', cursor: 'pointer',
                fontSize: 11, fontFamily: 'var(--font-body)',
                transition: 'all .12s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.borderColor = 'var(--accent-dim)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text3)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
            >
              <Icons.Plus size={11} />
              <span>Build a dashboard</span>
            </button>
          )}
          {dynDashboards.map(tab => (
            <NavItem
              key={tab.id} id={tab.id}
              label={tab.label || tab.id}
              icon={Icons.LayoutGrid}
              title="Custom dashboard — built with AI Builder"
              active={active} collapsed={collapsed}
              onClick={onChange}
              onDelete={onDeleteDynamic}
              onRename={onRenameDynamic}
              onDuplicate={onDuplicateDynamic}
              isDynamic
            />
          ))}
        </div>

        {dynSheets.length > 0 && (
          <>
            {!collapsed && (
              <div style={{ padding: '8px 10px 2px', borderTop: dynDashboards.length > 0 ? 'none' : '1px solid var(--border)', marginTop: dynDashboards.length > 0 ? 0 : 2 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text4)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  Sheets
                </span>
              </div>
            )}
            {collapsed && <div style={{ height: 1, background: 'var(--border)', margin: '10px 0' }} />}
            <div>
              {dynSheets.map(tab => (
                <NavItem
                  key={tab.id} id={tab.id}
                  label={tab.label || tab.id}
                  icon={sheetIcon(tab.label || tab.id)}
                  title="Custom spreadsheet — built with AI Builder"
                  active={active} collapsed={collapsed}
                  onClick={onChange}
                  onDelete={onDeleteDynamic}
                  onRename={onRenameDynamic}
                  onDuplicate={onDuplicateDynamic}
                  isDynamic
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Collapse toggle */}
      <div style={{ borderTop: '1px solid var(--border)', padding: '6px 0', flexShrink: 0 }}>
        <button
          onClick={onCollapse}
          title={collapsed ? 'Expand' : 'Collapse'}
          style={{
            width: '100%', padding: '7px',
            display: 'flex', alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 7, background: 'none', border: 'none',
            color: 'var(--text3)', cursor: 'pointer',
            fontSize: 11, fontFamily: 'var(--font-body)',
            transition: 'color .12s',
          }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
        >
          {collapsed
            ? <Icons.ChevronRight size={13} />
            : <><Icons.ChevronLeft size={13} /><span>Collapse</span></>
          }
        </button>
      </div>
    </aside>
  );
}
