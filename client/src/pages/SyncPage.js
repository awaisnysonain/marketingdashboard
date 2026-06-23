import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getSyncDetail, runBackfill, triggerSync } from '../utils/api';
import { Icons } from '../components/Icons';
import PageIntro from '../components/PageIntro';

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
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function timeAgo(ts) {
  if (!ts) return null;
  const diffMin = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}
function dateFreshness(latestDate) {
  if (!latestDate) return 'unknown';
  const diffDays = Math.floor((Date.now() - new Date(latestDate + 'T00:00:00').getTime()) / 86400000);
  if (diffDays <= 1) return 'fresh';
  if (diffDays <= 3) return 'warn';
  return 'stale';
}

const FRESHNESS_COLOR = { fresh: 'var(--success)', warn: 'var(--warn)', stale: 'var(--danger)', unknown: 'var(--text3)' };
const FRESHNESS_LABEL = { fresh: 'Fresh', warn: 'Few days old', stale: 'Stale', unknown: 'No date' };

// Status → token color (color-mix keeps the tint theme-safe).
const STATUS_COLOR = { success: 'var(--success)', error: 'var(--danger)', running: 'var(--warn)', triggered: 'var(--accent)' };
function statusStyle(s) {
  const c = STATUS_COLOR[String(s || '').toLowerCase()] || 'var(--text3)';
  return { color: c, bg: `color-mix(in srgb, ${c} 13%, transparent)`, border: `color-mix(in srgb, ${c} 30%, transparent)` };
}
function brandColor(brand) {
  return String(brand || '').toUpperCase().includes('FLO') ? 'var(--flo)' : 'var(--nobl)';
}

// Freshness cards — only the data sources that are actually live in the pipeline.
const FRESHNESS_CARDS = [
  { key: 'nobl_summary',   label: 'NOBL Summary',        group: 'Store revenue' },
  { key: 'flo_summary',    label: 'FLO Summary',         group: 'Store revenue' },
  { key: 'nobl_channels',  label: 'NOBL Channels',       group: 'Store revenue' },
  { key: 'flo_channels',   label: 'FLO Channels',        group: 'Store revenue' },
  { key: 'meta_ads',       label: 'Meta Ads',            group: 'Advertising' },
  { key: 'tw_ads',         label: 'Triple Whale Ads',    group: 'Advertising' },
  { key: 'nobl_subs',      label: 'Subscriptions',       group: 'Subscriptions & App' },
  { key: 'nobl_air',       label: 'NOBL Air',            group: 'Subscriptions & App' },
  { key: 'iap_revenue',    label: 'IAP Revenue',         group: 'Subscriptions & App' },
  { key: 'iap_subs',       label: 'IAP Subscriptions',   group: 'Subscriptions & App' },
  { key: 'klaviyo_emails', label: 'Klaviyo Email/SMS',   group: 'Email & Plan' },
  { key: 'forecast_plan',  label: 'Forecast Plan',       group: 'Email & Plan', kind: 'import' },
  { key: 'performance',    label: 'Performance Plan',    group: 'Email & Plan', kind: 'import' },
];
const FRESHNESS_GROUPS = ['Store revenue', 'Advertising', 'Subscriptions & App', 'Email & Plan'];

// Backfill tasks — the canonical daily ETL tasks (match ALL_DAILY_TASKS / syncEngine).
const BACKFILL_TASKS = [
  { key: 'tw_refresh',          label: 'TW summary · geo · channels', group: 'Store revenue' },
  { key: 'tw_order_revenue',    label: 'Order-revenue split',          group: 'Store revenue' },
  { key: 'shopify_orders',      label: 'Shopify orders + line items',  group: 'Store revenue' },
  { key: 'product_daily',       label: 'Product-line daily',           group: 'Store revenue' },
  { key: 'meta_ads',            label: 'Meta ad spend',                group: 'Advertising' },
  { key: 'tw_ads',              label: 'TW campaign/ad performance',   group: 'Advertising' },
  { key: 'tw_air_attribution',  label: 'NOBL Air attribution',         group: 'Advertising' },
  { key: 'appstle_contracts',   label: 'Subscription contracts',       group: 'Subscriptions & App' },
  { key: 'nobl_air_aggregate',  label: 'NOBL Air aggregate',           group: 'Subscriptions & App' },
  { key: 'iap',                 label: 'In-app purchases (Apple+Play)',group: 'Subscriptions & App' },
  { key: 'klaviyo',             label: 'Klaviyo email/SMS',            group: 'Email & Plan' },
  { key: 'forecast_sheet',      label: 'Forecast plan import',         group: 'Email & Plan' },
  { key: 'performance_dashboard', label: 'Performance import',         group: 'Email & Plan' },
];
const BACKFILL_GROUPS = ['Store revenue', 'Advertising', 'Subscriptions & App', 'Email & Plan'];
const ALL_TASK_KEYS = BACKFILL_TASKS.map(t => t.key);

const INPUT_STYLE = {
  width: '100%', boxSizing: 'border-box', padding: '8px 11px', fontSize: 12,
  background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 8,
  color: 'var(--text)', fontFamily: 'var(--font-body)', outline: 'none',
};

// ── Sub-components ─────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const st = statusStyle(status);
  const isRunning = String(status || '').toLowerCase() === 'running';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 20,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px',
      color: st.color, background: st.bg, border: `1px solid ${st.border}`,
      animation: isRunning ? 'pulse 1.2s ease-in-out infinite' : 'none',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: st.color }} />
      {status || '—'}
    </span>
  );
}

function FreshnessCard({ label, rowCount, latestDate, kind, extra }) {
  const fresh = dateFreshness(latestDate);
  const color = FRESHNESS_COLOR[fresh];
  return (
    <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8, borderLeft: `3px solid ${color}` }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-head)', color: 'var(--text)' }}>
          {rowCount > 0 ? Number(rowCount).toLocaleString() : '—'}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>rows</span>
        {extra && <span style={{ fontSize: 11, color: 'var(--success)', marginLeft: 4 }}>{extra}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>
          {kind === 'import' ? 'Imported' : 'Latest'}: <span style={{ color: latestDate ? 'var(--text2)' : 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{latestDate || '—'}</span>
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, color, background: `color-mix(in srgb, ${color} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`, borderRadius: 20, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: '.5px' }}>
          {FRESHNESS_LABEL[fresh]}
        </span>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function SyncPage({ showToast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const [bfFrom, setBfFrom] = useState(startOfMonthISO());
  const [bfTo, setBfTo] = useState(toISO(new Date()));
  const [bfTasks, setBfTasks] = useState(() => Object.fromEntries(BACKFILL_TASKS.map(t => [t.key, t.key === 'tw_refresh'])));
  const [bfRunning, setBfRunning] = useState(false);
  const [bfResult, setBfResult] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await getSyncDetail()); }
    catch (e) { setError(e.message || 'Failed to load sync data'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 15000);
    return () => clearInterval(pollRef.current);
  }, [load]);

  async function handleSyncNow() {
    setSyncing(true);
    try {
      // Full refresh (yesterday→today, all daily tasks) — not the 3-task default.
      await triggerSync({ tasks: ALL_TASK_KEYS, mode: 'manual' });
      showToast && showToast('Full sync triggered — refreshing shortly', 'success');
      setTimeout(load, 2500);
    } catch { showToast && showToast('Sync trigger failed', 'error'); }
    finally { setSyncing(false); }
  }

  async function handleBackfill(e) {
    e.preventDefault();
    const selected = BACKFILL_TASKS.filter(t => bfTasks[t.key]).map(t => t.key);
    if (!selected.length) { showToast && showToast('Select at least one task', 'error'); return; }
    if (bfFrom > bfTo) { showToast && showToast('From date is after To date', 'error'); return; }
    setBfRunning(true); setBfResult(null);
    try {
      const res = await runBackfill({ tasks: selected, startDate: bfFrom, endDate: bfTo, mode: 'backfill' });
      setBfResult({ ok: true, msg: res.message || `Backfill started for ${selected.length} task(s), ${bfFrom} → ${bfTo}` });
      showToast && showToast('Backfill triggered', 'success');
      setTimeout(load, 2500);
    } catch (err) {
      setBfResult({ ok: false, msg: err.message || 'Backfill failed' });
      showToast && showToast('Backfill failed', 'error');
    } finally { setBfRunning(false); }
  }

  const recent = data?.recent || [];
  const freshness = data?.data_freshness || {};
  const lastSync = recent[0];

  // Quick run health summary across the recent runs.
  const health = useMemo(() => {
    const errs = recent.filter(r => String(r.status).toLowerCase() === 'error').length;
    const running = recent.filter(r => String(r.status).toLowerCase() === 'running').length;
    return { errs, running, total: recent.length };
  }, [recent]);

  const setAll = (val) => setBfTasks(Object.fromEntries(BACKFILL_TASKS.map(t => [t.key, val])));

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Pipeline"
        title="Data sync"
        desc="When each source last refreshed, recent run history, and manual backfills."
        actions={<>
          {lastSync?.finished_at && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text3)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 20, padding: '3px 10px' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: health.errs ? 'var(--danger)' : 'var(--success)' }} />
              Last sync {timeAgo(lastSync.finished_at)}{health.errs ? ` · ${health.errs} error(s)` : ''}
            </span>
          )}
          <button onClick={handleSyncNow} disabled={syncing} className="btn btn--primary btn--sm">
            <Icons.RefreshCw size={13} style={{ animation: syncing ? 'spin .7s linear infinite' : 'none' }} />
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
          <button onClick={load} className="btn btn--sm"><Icons.RefreshCw size={12} /> Refresh</button>
        </>}
      />

      {error && (
        <div className="card" style={{ padding: '12px 16px', background: 'color-mix(in srgb, var(--danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)', color: 'var(--danger)', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Failed to load sync data: {error}</span>
          <button onClick={load} className="btn btn--sm">Retry</button>
        </div>
      )}

      {/* ── Data Freshness ── */}
      <div className="section">
        <div className="section__title">Data freshness · latest row date &amp; count per source</div>
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
            {[...Array(8)].map((_, i) => <div key={i} style={{ height: 104, background: 'var(--bg3)', borderRadius: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />)}
          </div>
        ) : FRESHNESS_GROUPS.map(group => (
          <div key={group} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text4)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>{group}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
              {FRESHNESS_CARDS.filter(c => c.group === group).map(card => {
                const info = freshness[card.key] || {};
                const extra = card.key === 'nobl_subs' && info.active != null ? `${Number(info.active).toLocaleString()} active` : null;
                return <FreshnessCard key={card.key} label={card.label} rowCount={info.row_count} latestDate={info.latest_date} kind={card.kind} extra={extra} />;
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── Run History ── */}
      <div className="section">
        <div className="section__title">Recent sync runs{health.total ? ` · last ${health.total}` : ''}{health.running ? ` · ${health.running} running` : ''}</div>
        <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
          {loading ? (
            <div style={{ padding: 20 }}>{[...Array(5)].map((_, i) => <div key={i} style={{ height: 34, background: 'var(--bg3)', borderRadius: 6, marginBottom: 8, animation: 'pulse 1.5s ease-in-out infinite' }} />)}</div>
          ) : recent.length === 0 ? (
            <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>No sync runs recorded yet.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--bg3)', borderBottom: '1px solid var(--border)' }}>
                    {['Started', 'Brand', 'Task', 'Status', 'Rows', 'Duration', 'Error'].map(col => (
                      <th key={col} style={{ padding: '9px 13px', textAlign: col === 'Rows' ? 'right' : 'left', fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', whiteSpace: 'nowrap', letterSpacing: '.3px', textTransform: 'uppercase' }}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recent.map((run, i) => (
                    <tr key={run.id || i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 13px', color: 'var(--text2)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{fmtTime(run.started_at)}</td>
                      <td style={{ padding: '8px 13px' }}>
                        {run.brand
                          ? <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, color: brandColor(run.brand), background: `color-mix(in srgb, ${brandColor(run.brand)} 12%, transparent)` }}>{run.brand}</span>
                          : <span style={{ color: 'var(--text3)' }}>—</span>}
                      </td>
                      <td style={{ padding: '8px 13px', color: 'var(--text2)', maxWidth: 200 }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.task || '—'}</span>
                      </td>
                      <td style={{ padding: '8px 13px' }}><StatusBadge status={run.status} /></td>
                      <td style={{ padding: '8px 13px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>{run.rows_written != null ? Number(run.rows_written).toLocaleString() : '—'}</td>
                      <td style={{ padding: '8px 13px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>{fmtDuration(run.duration_ms)}</td>
                      <td style={{ padding: '8px 13px', color: 'var(--danger)', maxWidth: 240 }}>
                        {run.error_message
                          ? <span title={run.error_message} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'help' }}>{run.error_message}</span>
                          : <span style={{ color: 'var(--text3)' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── Manual Backfill ── */}
      <div className="section">
        <div className="section__title">Manual backfill · re-run tasks for a date range</div>
        <div className="card" style={{ padding: '20px 22px' }}>
          <form onSubmit={handleBackfill}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14, marginBottom: 18 }}>
              <div>
                <label className="kpi__label" style={{ display: 'block', marginBottom: 6 }}>From date</label>
                <input type="date" value={bfFrom} max={bfTo} onChange={e => setBfFrom(e.target.value)} style={INPUT_STYLE} />
              </div>
              <div>
                <label className="kpi__label" style={{ display: 'block', marginBottom: 6 }}>To date</label>
                <input type="date" value={bfTo} min={bfFrom} max={toISO(new Date())} onChange={e => setBfTo(e.target.value)} style={INPUT_STYLE} />
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <label className="kpi__label">Tasks to run</label>
                <div className="seg">
                  <button type="button" className="seg__btn" onClick={() => setAll(true)}>All</button>
                  <button type="button" className="seg__btn" onClick={() => setAll(false)}>None</button>
                </div>
              </div>
              {BACKFILL_GROUPS.map(group => (
                <div key={group} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text4)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>{group}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {BACKFILL_TASKS.filter(t => t.group === group).map(t => {
                      const on = !!bfTasks[t.key];
                      return (
                        <label key={t.key} style={{
                          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none',
                          padding: '7px 12px', borderRadius: 8,
                          background: on ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'var(--bg3)',
                          border: `1px solid ${on ? 'color-mix(in srgb, var(--accent) 35%, transparent)' : 'var(--border)'}`,
                          transition: 'all .15s',
                        }}>
                          <input type="checkbox" checked={on} onChange={e => setBfTasks(prev => ({ ...prev, [t.key]: e.target.checked }))} style={{ accentColor: 'var(--accent)', width: 14, height: 14 }} />
                          <span style={{ fontSize: 12, fontWeight: 600, color: on ? 'var(--accent)' : 'var(--text2)' }}>{t.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {bfResult && (
              <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 8, fontSize: 12, color: bfResult.ok ? 'var(--success)' : 'var(--danger)', background: `color-mix(in srgb, ${bfResult.ok ? 'var(--success)' : 'var(--danger)'} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${bfResult.ok ? 'var(--success)' : 'var(--danger)'} 25%, transparent)` }}>
                {bfResult.msg}
              </div>
            )}

            <button type="submit" disabled={bfRunning} className="btn btn--primary">
              {bfRunning
                ? <><span style={{ width: 13, height: 13, border: '2px solid color-mix(in srgb, #fff 40%, transparent)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin .7s linear infinite' }} /> Running backfill…</>
                : <><Icons.RefreshCw size={13} /> Run backfill</>}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
