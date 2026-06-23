import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getIap, fmt$, fmtNum } from '../utils/api';
import KpiCard from '../components/KpiCard';
import ChartPanel from '../components/ChartPanel';
import PageIntro from '../components/PageIntro';
import { fmtAxisCurrency, TOOLTIP_STYLE, NOBL_ACCENT, FLO_ACCENT } from '../utils/chartHelpers';

const BRAND_META = {
  NOBL: { title: 'NOBL Travel app', accent: NOBL_ACCENT, eyebrow: 'In-app purchases' },
  FLO: { title: 'Pilates FLO app', accent: FLO_ACCENT, eyebrow: 'In-app purchases' },
};
const RANGES = [{ k: '7d', label: '7 days', days: 7 }, { k: '30d', label: '30 days', days: 30 }, { k: '90d', label: '90 days', days: 90 }];

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function fmtDateLabel(s) {
  if (!s) return '';
  const [, mo, dy] = String(s).slice(0, 10).split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo) - 1]} ${parseInt(dy)}`;
}

export default function IapPage({ brand = 'NOBL' }) {
  const cfg = BRAND_META[brand] || BRAND_META.NOBL;
  const [rangeKey, setRangeKey] = useState('30d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const range = RANGES.find((r) => r.k === rangeKey) || RANGES[1];

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const end = isoDaysAgo(1);
      const start = isoDaysAgo(range.days);
      setData(await getIap(brand, start, end));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [brand, range.days]);

  useEffect(() => { load(); }, [load]);

  const apple = data?.byPlatform?.apple || { units: 0, revenue_usd: 0 };
  const google = data?.byPlatform?.google || { units: 0, revenue_usd: 0 };
  const subs = data?.subs || { active: 0, trials: 0, new: 0, cancelled: 0, series: [] };
  const series = useMemo(() => (data?.series || []).map((r) => ({ ...r, revenue: r.apple_revenue + r.google_revenue })), [data]);
  const pending = data?.pending;

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow={cfg.eyebrow}
        title={cfg.title}
        desc="In-app purchase revenue and units across the App Store and Google Play."
        accent={cfg.accent}
        actions={
          <div className="seg">
            {RANGES.map((r) => (
              <button key={r.k} className={`seg__btn${rangeKey === r.k ? ' seg__btn--active' : ''}`} onClick={() => setRangeKey(r.k)}>{r.label}</button>
            ))}
          </div>
        }
      />

      {loading ? (
        <div className="page-kpi-grid">{[...Array(4)].map((_, i) => <div key={i} style={{ height: 88, background: 'var(--bg3)', borderRadius: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />)}</div>
      ) : error ? (
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 14 }}>Failed to load: {error}</div>
          <button onClick={load} className="btn btn--primary">Retry</button>
        </div>
      ) : (
        <>
          <div className="page-kpi-section">
            <div className="page-kpi-grid">
              <KpiCard label="IAP revenue" sub={`USD · last ${range.label}`} value={fmt$(data?.totals?.revenue_usd || 0)} fullValue={fmt$(data?.totals?.revenue_usd || 0)} color={cfg.accent} accent />
              <KpiCard label="App Store" sub="USD · App Store Connect" value={fmt$(apple.revenue_usd || 0)} fullValue={fmt$(apple.revenue_usd || 0)} />
              <KpiCard label="Google Play" sub="USD · earnings (~1mo lag)" value={fmt$(google.revenue_usd || 0)} fullValue={fmt$(google.revenue_usd || 0)} />
              <KpiCard label="IAP units" sub={`last ${range.label}`} value={fmtNum(data?.totals?.units || 0)} fullValue={fmtNum(data?.totals?.units || 0)} />
            </div>
          </div>

          {pending ? (
            <div className="card" style={{ textAlign: 'center', padding: '40px 28px', maxWidth: 560, margin: '8px auto' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>No IAP data synced yet</div>
              <p style={{ fontSize: 13, color: 'var(--text3)', lineHeight: 1.6, margin: 0 }}>
                The Apple &amp; Google credentials are connected and validated. Apply the IAP schema
                (<code>server/db/iap_schema.sql</code>) and run the sync to populate this page:
              </p>
              <pre style={{ textAlign: 'left', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', marginTop: 14, fontSize: 12, overflow: 'auto' }}>
{`node server/db/applySchema.js
node server/etl/syncIap.js 2026-06-01 ${isoDaysAgo(1)} --commit`}
              </pre>
            </div>
          ) : (
            <>
              {(subs.active > 0 || subs.new > 0) && (
                <div className="section">
                  <div className="section__title">Subscriptions · App Store + Google Play{subs.series.length ? ` · as of ${fmtDateLabel(subs.series[subs.series.length - 1].date)}` : ''}</div>
                  <div className="page-kpi-grid">
                    <KpiCard label="Active subscribers" sub="point-in-time" value={fmtNum(subs.active)} fullValue={fmtNum(subs.active)} color={cfg.accent} accent />
                    <KpiCard label="Free trials" sub="active now" value={fmtNum(subs.trials)} fullValue={fmtNum(subs.trials)} />
                    <KpiCard label="New" sub={`last ${range.label}`} value={fmtNum(subs.new)} fullValue={fmtNum(subs.new)} />
                    <KpiCard label="Cancelled" sub={`last ${range.label}`} value={fmtNum(subs.cancelled)} fullValue={fmtNum(subs.cancelled)} />
                  </div>
                  {subs.series.length > 1 && (
                    <ChartPanel title="Active subscribers over time" subtitle="App Store + Google Play — daily snapshot">
                      <ResponsiveContainer width="100%" height={200}>
                        <AreaChart data={subs.series} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                          <defs>
                            <linearGradient id="iapSubs" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={cfg.accent} stopOpacity={0.25} />
                              <stop offset="95%" stopColor={cfg.accent} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                          <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                          <YAxis tick={{ fontSize: 11 }} width={48} stroke="var(--border2)" allowDecimals={false} />
                          <Tooltip formatter={(v) => [fmtNum(v), 'Active']} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                          <Area type="monotone" dataKey="active" name="Active" stroke={cfg.accent} fill="url(#iapSubs)" strokeWidth={2} dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </ChartPanel>
                  )}
                </div>
              )}

              <div className="section">
                <div className="section__title">IAP revenue over time</div>
                <ChartPanel title="Daily IAP revenue" subtitle="Net developer proceeds, USD — App Store + Google Play (Play earnings lag ~1 month)">
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={series} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                      <defs>
                        <linearGradient id="iapApple" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={cfg.accent} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={cfg.accent} stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="iapGoogle" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#9aa4b2" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#9aa4b2" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={fmtDateLabel} tick={{ fontSize: 11 }} stroke="var(--border2)" />
                      <YAxis tickFormatter={fmtAxisCurrency} tick={{ fontSize: 11 }} width={72} stroke="var(--border2)" />
                      <Tooltip formatter={(v, n) => [fmt$(v), n]} labelFormatter={fmtDateLabel} contentStyle={TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="apple_revenue" name="App Store" stackId="rev" stroke={cfg.accent} fill="url(#iapApple)" strokeWidth={2} dot={false} />
                      <Area type="monotone" dataKey="google_revenue" name="Google Play" stackId="rev" stroke="#9aa4b2" fill="url(#iapGoogle)" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartPanel>
              </div>

              <div className="section">
                <div className="section__title">Daily detail</div>
                <div className="card" style={{ overflow: 'hidden' }}>
                  <table className="scorecard">
                    <thead><tr><th>Date</th><th>App Store units</th><th>App Store $</th><th>Google Play units</th><th>Google Play $</th><th>Total $</th></tr></thead>
                    <tbody>
                      {[...series].reverse().map((r) => (
                        <tr key={r.date}>
                          <td>{fmtDateLabel(r.date)}</td>
                          <td>{fmtNum(r.apple_units || 0)}</td>
                          <td>{fmt$(r.apple_revenue || 0)}</td>
                          <td>{fmtNum(r.google_units || 0)}</td>
                          <td>{fmt$(r.google_revenue || 0)}</td>
                          <td>{fmt$((r.apple_revenue || 0) + (r.google_revenue || 0))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
