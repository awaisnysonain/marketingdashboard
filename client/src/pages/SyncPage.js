import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getSyncDetail, runBackfill, triggerSync } from '../utils/api';
import { Icons } from '../components/Icons';

// ── Helpers ────────────────────────────────────────────────────────────────
function toISO(d) { return d.toISOString().slice(0, 10); }
function startOfMonthISO() { const d = new Date(); d.setDate(1); return toISO(d); }

function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(ts) {
  if (!ts) return null;
  const diffMs = Date.now() - new Date(ts).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

function dateFreshness(latestDate) {
  if (!latestDate) return 'unknown';
  const now = new Date();
  const d = new Date(latestDate + 'T00:00:00');
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return 'fresh';
  if (diffDays <= 2) return 'warn';
  return 'stale';
}

const FRESHNESS_COLOR = { fresh: 'var(--success)', warn: 'var(--warn)', stale: 'var(--danger)', unknown: 'var(--text3)' };
const FRESHNESS_LABEL = { fresh: 'Fresh', warn: '1–2 days old', stale: '3+ days old', unknown: 'Unknown' };

const STATUS_COLORS = {
  success: { bg: 'rgba(16,185,129,.12)', text: 'var(--success)', border: 'rgba(16,185,129,.25)' },
  error:   { bg: 'rgba(239,68,68,.12)',  text: 'var(--danger)',  border: 'rgba(239,68,68,.25)' },
  running: { bg: 'rgba(245,158,11,.12)', text: 'var(--warn)',    border: 'rgba(245,158,11,.25)' },
  triggered:{ bg: 'rgba(59,130,246,.12)',text: 'var(--accent)',  border: 'rgba(59,130,246,.25)' },
};

const BACKFILL_TASKS = [
  { key: 'klaviyo',      label: 'Klaviyo Emails',         group: 'Core' },
  { key: 'appstle',      label: 'Appstle Sub Revenue',    group: 'Core' },
  { key: 'tw_refresh',   label: 'TW Summary',             group: 'Core' },
  { key: 'tw_channels',  label: 'TW Channels',            group: 'TW SQL' },
  { key: 'tw_geo',       label: 'TW Geo / Regions',       group: 'TW SQL' },
  { key: 'tw_ads',       label: 'TW Ads (Campaign Level)', group: 'TW SQL' },
  { key: 'tw_orders',    label: 'TW Orders',              group: 'TW SQL' },
  { key: 'tw_sessions',  label: 'TW Sessions / Traffic',  group: 'TW SQL' },
  { key: 'tw_refunds',   label: 'TW Refunds',             group: 'TW SQL' },
  { key: 'tw_email_sms', label: 'TW Email / SMS',         group: 'TW SQL' },
  { key: 'tw_order_revenue', label: 'TW Order Revenue (Fix)',  group: 'TW SQL' },
  { key: 'tw_customers', label: 'TW Customers (LTV)',        group: 'TW SQL' },
  { key: 'tw_segments',  label: 'TW RFM Segments',        group: 'TW SQL' },
  { key: 'tw_benchmarks',label: 'TW Benchmarks',          group: 'TW SQL' },
];

// ── Sub-components ─────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const s = String(status || '').toLowerCase();
  const cfg = STATUS_COLORS[s] || { bg: 'var(--bg3)', text: 'var(--text3)', border: 'var(--border)' };
  const isRunning = s === 'running';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700,
      background: cfg.bg, color: cfg.text, border: `1px solid ${cfg.border}`,
      textTransform: 'uppercase', letterSpacing: '.4px',
      animation: isRunning ? 'pulse 1.2s ease-in-out infinite' : 'none',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.text, flexShrink: 0 }} />
      {status || '—'}
    </span>
  );
}

function FreshnessCard({ label, rowCount, latestDate, extra }) {
  const fresh = dateFreshness(latestDate);
  const color = FRESHNESS_COLOR[fresh];
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
      padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8,
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', letterSpacing: '.1px' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-head)', color: 'var(--text)' }}>
          {rowCount != null && rowCount > 0 ? Number(rowCount).toLocaleString() : '—'}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>rows</span>
        {extra && <span style={{ fontSize: 11, color: 'var(--success)', marginLeft: 4 }}>{extra}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>
          Latest: <span style={{ color: latestDate ? 'var(--text2)' : 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{latestDate || '—'}</span>
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, color,
          background: `${color}18`, border: `1px solid ${color}30`,
          borderRadius: 20, padding: '1px 7px',
          textTransform: 'uppercase', letterSpacing: '.5px',
        }}>
          {FRESHNESS_LABEL[fresh]}
        </span>
      </div>
    </div>
  );
}

function FreshnessSkeleton() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
      {[...Array(6)].map((_, i) => (
        <div key={i} style={{ height: 110, background: 'var(--bg3)', borderRadius: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />
      ))}
    </div>
  );
}

function SectionHeader({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      {subtitle && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>{subtitle}</div>}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function SyncPage({ showToast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);

  // Backfill form state
  const [bfFrom, setBfFrom] = useState(startOfMonthISO());
  const [bfTo, setBfTo] = useState(toISO(new Date()));
  const [bfTasks, setBfTasks] = useState(() =>
    Object.fromEntries(BACKFILL_TASKS.map(t => [t.key, t.key === 'klaviyo']))
  );
  const [bfRunning, setBfRunning] = useState(false);
  const [bfResult, setBfResult] = useState(null);

  const pollRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await getSyncDetail();
      setData(d);
    } catch (e) {
      setError(e.message || 'Failed to load sync data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Poll every 15 seconds for live updates
    pollRef.current = setInterval(load, 15000);
    return () => clearInterval(pollRef.current);
  }, [load]);

  async function handleSyncNow() {
    setSyncing(true);
    try {
      await triggerSync();
      showToast && showToast('Sync triggered — refreshing in a moment', 'success');
      setTimeout(load, 2000);
    } catch {
      showToast && showToast('Sync trigger failed', 'error');
    } finally {
      setSyncing(false);
    }
  }

  async function handleBackfill(e) {
    e.preventDefault();
    const selectedTasks = BACKFILL_TASKS.filter(t => bfTasks[t.key]).map(t => t.key);
    if (selectedTasks.length === 0) {
      showToast && showToast('Select at least one task', 'error');
      return;
    }
    setBfRunning(true);
    setBfResult(null);
    try {
      const res = await runBackfill({ tasks: selectedTasks, startDate: bfFrom, endDate: bfTo });
      setBfResult({ ok: true, msg: res.message || 'Backfill triggered successfully' });
      showToast && showToast('Backfill triggered', 'success');
      setTimeout(load, 2000);
    } catch (err) {
      setBfResult({ ok: false, msg: err.message || 'Backfill failed' });
      showToast && showToast('Backfill failed', 'error');
    } finally {
      setBfRunning(false);
    }
  }

  const recent = data?.recent || [];
  const freshness = data?.data_freshness || {};
  const lastSync = recent[0];

  const FRESHNESS_CARDS = [
    // Core
    { key: 'nobl_summary',    label: 'NOBL Summary',          group: 'Core' },
    { key: 'flo_summary',     label: 'FLO Summary',            group: 'Core' },
    { key: 'nobl_channels',   label: 'NOBL Channels',          group: 'Core' },
    { key: 'flo_channels',    label: 'FLO Channels',           group: 'Core' },
    { key: 'nobl_subs',       label: 'NOBL Subscriptions',     group: 'Core' },
    { key: 'klaviyo_emails',  label: 'Klaviyo Emails',         group: 'Core' },
    // TW SQL
    { key: 'tw_ads',          label: 'TW Ads (Campaigns)',     group: 'TW SQL' },
    { key: 'tw_orders',       label: 'TW Orders',              group: 'TW SQL' },
    { key: 'tw_sessions',     label: 'TW Sessions',            group: 'TW SQL' },
    { key: 'tw_customers',    label: 'TW Customers',           group: 'TW SQL' },
    { key: 'tw_segments',     label: 'TW RFM Segments',        group: 'TW SQL' },
    { key: 'tw_refunds',      label: 'TW Refunds',             group: 'TW SQL' },
    { key: 'tw_email_sms',    label: 'TW Email / SMS',         group: 'TW SQL' },
    { key: 'tw_benchmarks',   label: 'TW Benchmarks',          group: 'TW SQL' },
  ];

  const inputStyle = {
    padding: '8px 11px', fontSize: 12, background: 'var(--bg3)',
    border: '1px solid var(--border2)', borderRadius: 7, color: 'var(--text)',
    fontFamily: 'var(--font-body)', outline: 'none', width: '100%', boxSizing: 'border-box',
  };

  return (
    <div>
      {/* ── Page Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, fontFamily: 'var(--font-head)' }}>Data Sync</h1>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: '4px 0 0' }}>
            Monitor data freshness, sync history, and run manual backfills
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {lastSync?.finished_at && (
            <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
              Last sync: {timeAgo(lastSync.finished_at)}
            </span>
          )}
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', background: 'var(--accent)', color: '#fff',
              border: 'none', borderRadius: 8, cursor: syncing ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 700, opacity: syncing ? .7 : 1,
              fontFamily: 'var(--font-body)', transition: 'filter .15s',
            }}
            onMouseEnter={e => { if (!syncing) e.currentTarget.style.filter = 'brightness(1.1)'; }}
            onMouseLeave={e => e.currentTarget.style.filter = ''}
          >
            <Icons.RefreshCw size={13} style={{ animation: syncing ? 'spin .7s linear infinite' : 'none' }} />
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
          <button
            onClick={load}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '8px 12px', background: 'none', color: 'var(--text2)',
              border: '1px solid var(--border2)', borderRadius: 8, cursor: 'pointer',
              fontSize: 12, fontFamily: 'var(--font-body)',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text2)'; }}
          >
            <Icons.RefreshCw size={12} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          marginBottom: 20, padding: '12px 16px',
          background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.25)',
          borderRadius: 10, fontSize: 13, color: 'var(--danger)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>Failed to load sync data: {error}</span>
          <button onClick={load} style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Retry</button>
        </div>
      )}

      {/* ── Section 1: Data Freshness ── */}
      <div style={{ marginBottom: 28 }}>
        <SectionHeader title="Data Freshness" subtitle="Showing latest row date and row count for each data source" />
        {loading ? (
          <FreshnessSkeleton />
        ) : (
          <>
            {['Core', 'TW SQL'].map(group => {
              const cards = FRESHNESS_CARDS.filter(c => c.group === group);
              return (
                <div key={group} style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text4)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>
                    {group}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
                    {cards.map(card => {
                      const info = freshness[card.key] || {};
                      const extra = card.key === 'nobl_subs' && info.active != null
                        ? `${Number(info.active).toLocaleString()} active` : null;
                      return (
                        <FreshnessCard
                          key={card.key}
                          label={card.label}
                          rowCount={info.row_count}
                          latestDate={info.latest_date}
                          extra={extra}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* ── Section 2: Sync Run History ── */}
      <div style={{ marginBottom: 28 }}>
        <SectionHeader title="Sync Run History" subtitle="Last 20 sync runs across all tasks" />
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 24 }}>
              {[...Array(5)].map((_, i) => (
                <div key={i} style={{ height: 36, background: 'var(--bg3)', borderRadius: 6, marginBottom: 8, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
              No sync runs recorded yet.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--bg3)', borderBottom: '1px solid var(--border)' }}>
                    {['Started At', 'Brand', 'Task', 'Status', 'Rows Written', 'Duration', 'Error'].map(col => (
                      <th key={col} style={{
                        padding: '9px 13px', textAlign: 'left', fontSize: 11,
                        fontWeight: 600, color: 'var(--text3)', whiteSpace: 'nowrap',
                        letterSpacing: '.3px', textTransform: 'uppercase',
                      }}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recent.map((run, i) => (
                    <tr
                      key={run.id || i}
                      style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,.02)', borderBottom: '1px solid var(--border)' }}
                    >
                      <td style={{ padding: '8px 13px', color: 'var(--text2)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                        {fmtTime(run.started_at)}
                      </td>
                      <td style={{ padding: '8px 13px', fontWeight: 600 }}>
                        {run.brand ? (
                          <span style={{
                            padding: '2px 8px', borderRadius: 4, fontSize: 11,
                            background: run.brand?.toLowerCase().includes('flo') ? 'rgba(20,184,166,.12)' : 'rgba(99,102,241,.12)',
                            color: run.brand?.toLowerCase().includes('flo') ? 'var(--teal)' : 'var(--accent2)',
                          }}>
                            {run.brand}
                          </span>
                        ) : <span style={{ color: 'var(--text3)' }}>—</span>}
                      </td>
                      <td style={{ padding: '8px 13px', color: 'var(--text2)', maxWidth: 180 }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {run.task || '—'}
                        </span>
                      </td>
                      <td style={{ padding: '8px 13px' }}>
                        <StatusBadge status={run.status} />
                      </td>
                      <td style={{ padding: '8px 13px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>
                        {run.rows_written != null ? Number(run.rows_written).toLocaleString() : '—'}
                      </td>
                      <td style={{ padding: '8px 13px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                        {fmtDuration(run.duration_ms)}
                      </td>
                      <td style={{ padding: '8px 13px', color: 'var(--danger)', maxWidth: 200 }}>
                        {run.error ? (
                          <span title={run.error} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'help' }}>
                            {run.error}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text3)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Section 3: Manual Backfill ── */}
      <div style={{ marginBottom: 20 }}>
        <SectionHeader title="Manual Backfill" subtitle="Re-run specific tasks for a historical date range" />
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: '22px 24px' }}>
          <form onSubmit={handleBackfill}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16, marginBottom: 20 }}>
              {/* Date From */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>
                  From Date
                </label>
                <input
                  type="date" value={bfFrom} onChange={e => setBfFrom(e.target.value)}
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border2)'}
                />
              </div>

              {/* Date To */}
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>
                  To Date
                </label>
                <input
                  type="date" value={bfTo} onChange={e => setBfTo(e.target.value)}
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border2)'}
                />
              </div>
            </div>

            {/* Task checkboxes */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
                  Tasks to Run
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setBfTasks(Object.fromEntries(BACKFILL_TASKS.map(t => [t.key, true])))}
                    style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: '2px 6px' }}>
                    All
                  </button>
                  <button type="button" onClick={() => setBfTasks(Object.fromEntries(BACKFILL_TASKS.map(t => [t.key, false])))}
                    style={{ fontSize: 11, color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: '2px 6px' }}>
                    None
                  </button>
                </div>
              </div>
              {['Core', 'TW SQL'].map(group => (
                <div key={group} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text4)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
                    {group}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {BACKFILL_TASKS.filter(t => t.group === group).map(t => (
                      <label
                        key={t.key}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                          padding: '7px 13px', borderRadius: 8,
                          background: bfTasks[t.key] ? 'rgba(59,130,246,.1)' : 'var(--bg3)',
                          border: `1px solid ${bfTasks[t.key] ? 'rgba(59,130,246,.35)' : 'var(--border)'}`,
                          transition: 'all .15s', userSelect: 'none',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={!!bfTasks[t.key]}
                          onChange={e => setBfTasks(prev => ({ ...prev, [t.key]: e.target.checked }))}
                          style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
                        />
                        <span style={{ fontSize: 12, fontWeight: 600, color: bfTasks[t.key] ? 'var(--accent)' : 'var(--text2)' }}>
                          {t.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Result message */}
            {bfResult && (
              <div style={{
                marginBottom: 14, padding: '10px 14px', borderRadius: 8, fontSize: 12,
                background: bfResult.ok ? 'rgba(16,185,129,.08)' : 'rgba(239,68,68,.08)',
                border: `1px solid ${bfResult.ok ? 'rgba(16,185,129,.25)' : 'rgba(239,68,68,.25)'}`,
                color: bfResult.ok ? 'var(--success)' : 'var(--danger)',
              }}>
                {bfResult.msg}
              </div>
            )}

            <button
              type="submit"
              disabled={bfRunning}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '9px 22px', background: 'var(--accent2)', color: '#fff',
                border: 'none', borderRadius: 8, cursor: bfRunning ? 'not-allowed' : 'pointer',
                fontSize: 13, fontWeight: 700, opacity: bfRunning ? .7 : 1,
                fontFamily: 'var(--font-body)', transition: 'filter .15s',
              }}
              onMouseEnter={e => { if (!bfRunning) e.currentTarget.style.filter = 'brightness(1.1)'; }}
              onMouseLeave={e => e.currentTarget.style.filter = ''}
            >
              {bfRunning ? (
                <>
                  <span style={{ width: 13, height: 13, border: '2px solid rgba(255,255,255,.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
                  Running Backfill…
                </>
              ) : (
                <>
                  <Icons.RefreshCw size={13} />
                  Run Backfill
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
