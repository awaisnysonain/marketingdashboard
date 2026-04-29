import React, { useState } from 'react';
import { Icons, sheetIcon } from './Icons';

export const CORE_TABS = [
  { id: 'Overview',      icon: Icons.LayoutDashboard, label: 'Overview'       },
  { id: 'NOBL Air',      icon: Icons.Plane,           label: 'NOBL Travel'    },
  { id: 'Pilates FLO',   icon: Icons.Activity,        label: 'Pilates FLO'    },
  { id: 'Channels',      icon: Icons.BarChart2,       label: 'Channels'       },
  { id: 'Subscriptions', icon: Icons.CreditCard,      label: 'Subscriptions'  },
  { id: 'Live Data',     icon: Icons.Zap,             label: 'Live Data'      },
];

// Dedicated store pages — full per-store data (channels, regions, products, subs, email)
export const STORE_TABS = [
  { id: 'Store:NOBL', icon: Icons.Store, label: 'NOBL Travel'  },
  { id: 'Store:FLO',  icon: Icons.Store, label: 'Pilates FLO'  },
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

/* ── Nav item ──────────────────────────────────────────────────────── */
function NavItem({ id, label, icon: IconComp, active, collapsed, onClick, onDelete, isDynamic }) {
  const [hov, setHov] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const isAct = active === id;

  function requestDelete(e) {
    e.stopPropagation();
    setConfirmId(id);
  }

  return (
    <>
      {confirmId && (
        <ConfirmDelete
          label={label}
          onConfirm={() => { setConfirmId(null); onDelete?.(id); }}
          onCancel={() => setConfirmId(null)}
        />
      )}
      <div
        style={{ position: 'relative' }}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
      >
        <button
          onClick={() => onClick(id)}
          title={collapsed ? label : undefined}
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

        {/* Delete button (dynamic tabs only) */}
        {isDynamic && !collapsed && hov && (
          <button
            onClick={requestDelete}
            title="Remove"
            style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              background: 'var(--bg4)', border: '1px solid var(--border2)',
              borderRadius: 4, width: 18, height: 18,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--text3)',
              transition: 'color .12s',
            }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--danger)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}
          >
            <Icons.X size={9} />
          </button>
        )}
      </div>
    </>
  );
}

/* ── Section label ─────────────────────────────────────────────────── */
function SectionLabel({ label, collapsed, action }) {
  if (collapsed) return <div style={{ height: 1, background: 'var(--border)', margin: '10px 0' }} />;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 10px 4px',
    }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text4)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {label}
      </span>
      {action}
    </div>
  );
}

/* ── Main sidebar ──────────────────────────────────────────────────── */
export default function Sidebar({ active, onChange, dynamicTabs, onAddDashboard, onDeleteDynamic, collapsed, onCollapse }) {
  const dynDashboards = (dynamicTabs || []).filter(t => t.type === 'dashboard');
  const dynSheets     = (dynamicTabs || []).filter(t => t.type === 'sheet');
  const storeActive   = STORE_TABS.some(t => t.id === active);

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
        padding: collapsed ? '0' : '0 14px',
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

        {/* Core pages */}
        {!collapsed && <SectionLabel label="Analytics" collapsed={false} />}
        {collapsed && <div style={{ height: 8 }} />}
        <div>
          {CORE_TABS.map(tab => (
            <NavItem key={tab.id} {...tab} active={active} collapsed={collapsed} onClick={onChange} />
          ))}
        </div>

        {/* Stores */}
        <SectionLabel label="Stores" collapsed={collapsed} />
        <div>
          {STORE_TABS.map(tab => (
            <NavItem key={tab.id} {...tab} active={active} collapsed={collapsed} onClick={onChange} />
          ))}
        </div>

        {/* Dashboards */}
        <SectionLabel
          label="Dashboards"
          collapsed={collapsed}
          action={!collapsed && (
            <button
              onClick={onAddDashboard}
              title="New dashboard"
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
              active={active} collapsed={collapsed}
              onClick={onChange} onDelete={onDeleteDynamic} isDynamic
            />
          ))}
        </div>

        {/* Sheets */}
        {dynSheets.length > 0 && (
          <>
            <SectionLabel label="Sheets" collapsed={collapsed} />
            <div>
              {dynSheets.map(tab => (
                <NavItem
                  key={tab.id} id={tab.id}
                  label={tab.label || tab.id}
                  icon={sheetIcon(tab.label || tab.id)}
                  active={active} collapsed={collapsed}
                  onClick={onChange} onDelete={onDeleteDynamic} isDynamic
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
