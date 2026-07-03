import React, { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts';
import ChartPanel from '../components/ChartPanel';
import FilterMultiSelect from '../components/FilterMultiSelect';
import PageIntro from '../components/PageIntro';
import { fmtNum, getKpiPulse, saveKpiPulseOverride } from '../utils/api';
import { NOBL_ACCENT, FLO_ACCENT, TOOLTIP_STYLE } from '../utils/chartHelpers';
import { multiFilterLabel, normalizeMultiFilter } from '../constants/dashboardFilters';

const STATUS_META = {
  blue:   { label: 'Ahead',      color: '#3b7ea1', bg: 'rgba(59,126,161,.12)', border: 'rgba(59,126,161,.28)' },
  green:  { label: 'On track',   color: 'var(--success)', bg: 'var(--success-dim)', border: 'rgba(31,122,82,.28)' },
  yellow: { label: 'Watch',      color: 'var(--warn)', bg: 'var(--warn-dim)', border: 'rgba(176,125,24,.30)' },
  red:    { label: 'Needs help', color: 'var(--danger)', bg: 'var(--danger-dim)', border: 'rgba(178,59,47,.30)' },
  gray:   { label: 'No target',  color: 'var(--text3)', bg: 'var(--bg3)', border: 'var(--border)' },
};

const KPI_PULSE_LOCAL_CACHE_PREFIX = 'kpiPulse:v5:';
const kpiPulseLocalCacheKey = (month) => `${KPI_PULSE_LOCAL_CACHE_PREFIX}${month || 'latest'}`;
function hasUsableKpiPulseData(data) {
  if (!data?.cadences) return false;
  return Object.values(data.cadences).some(c => Array.isArray(c?.periods) && c.periods.length > 0);
}
function readKpiPulseLocalCache(month) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(kpiPulseLocalCacheKey(month));
    const data = raw ? JSON.parse(raw) : null;
    return hasUsableKpiPulseData(data) ? data : null;
  } catch (_) { return null; }
}
function writeKpiPulseLocalCache(month, data) {
  if (typeof window === 'undefined' || !hasUsableKpiPulseData(data)) return;
  try {
    window.localStorage.setItem(kpiPulseLocalCacheKey(month), JSON.stringify(data));
    if (data.selectedMonth) window.localStorage.setItem(kpiPulseLocalCacheKey(data.selectedMonth), JSON.stringify(data));
  } catch (_) { /* localStorage may be unavailable/full; ignore */ }
}

/* ── Database-backed metrics ──────────────────────────────────────────
   Maps a KPI catalog metric name → the key returned by /api/analytics/kpi-pulse.
   Metrics NOT in this map have no database source and are shown BLANK.        */
const DB_KEY = {
  // Core (NOBL summary + geo + Air)
  'NOBL Blended MER': 'mer',
  'Gross Sales − Discounts': 'sales',
  'Gross Sales − Discounts (Flo)': 'sales',
  'Gross Sales − Discounts (FLO)': 'sales',
  'AOV': 'aov',
  'Amazon Rev % of Gross Sales': 'amazon_pct',
  'Amazon Rev as % of Gross Sales': 'amazon_pct',
  'Amazon Rev as % of Gross Sales − Discounts': 'amazon_pct',
  'US MER': 'us_mer',
  'US — MER': 'us_mer',
  'USA — MER': 'us_mer',
  'Canada MER': 'ca_mer',
  'Canada — MER': 'ca_mer',
  'Australia — MER': 'au_mer',
  'EU — MER': 'eu_mer',
  'UK — MER': 'uk_mer',
  'USA Sales as % of Total Sales': 'us_sales_pct',
  'Canada Sales as % of Total Sales': 'ca_sales_pct',
  'Australia Sales as % of Total Sales': 'au_sales_pct',
  'EU Sales as % of Total Sales': 'eu_sales_pct',
  'Uk Sales as % of Total Sales': 'uk_sales_pct',
  'UK Sales as % of Total Sales': 'uk_sales_pct',
  'NOBL Air Rev % of Sales': 'air_rev_pct',
  'NOBL Air Rev as % of Total Sales': 'air_rev_pct',
  'Attach Rate': 'attach',
  'Activation Rate': 'activation',
  'Activation Rate (Attach × TTP)': 'activation',
  'Activation Rate (Attach Rate × TTP)': 'activation',
  'Trial-to-Paid': 'ttp',
  'Trial-to-Paid (TTP)': 'ttp',
  // Ops (ops_metrics_daily, via ERP)
  'Avg Shipping Cost / Order': 'avg_shipping_cost',
  'Avg Shipping Cost per Order': 'avg_shipping_cost',
  'Orders Partially Unfulfilled': 'orders_unfulfilled',
  'Total orders partially unfulfilled': 'orders_unfulfilled',
  'Orders partially unfulfilled': 'orders_unfulfilled',
  'US Orders partially unfulfilled': 'us_orders_unfulfilled',
  'UK orders partially unfulfilled': 'uk_orders_unfulfilled',
  'US unfulfilled orders': 'us_orders_unfulfilled',
  'UK unfulfilled orders': 'uk_orders_unfulfilled',
  'CANADA Partially Unfulfilled Orders #': 'ca_orders_unfulfilled',
  'AUSTRALIA Partially Unfulfilled Orders #': 'au_orders_unfulfilled',
  'Orders Unfulfilled >24hrs': 'orders_unfulfilled_24h',
  'US Orders Unfulfilled >24hrs': 'us_orders_unfulfilled_24h',
  'UK Orders Unfulfilled >24hrs': 'uk_orders_unfulfilled_24h',
  'Unfulfilled Orders': 'orders_unfulfilled',
  'unfulfilled orders': 'orders_unfulfilled',
  'Time to Fulfillment': 'avg_fulfillment_days',
  'US Time to Fulfillment': 'avg_fulfillment_days',
  'UK Time to Fulfillment': 'uk_ttf_days',
  'Avg shipping time length (from shipped to customer door)': 'avg_ship_to_door_days',
  'CA Time to Fulfillment': 'ca_ttf_days',
  'AUS Time to Fulfillment': 'au_ttf_days',
  // Live APIs from the legacy scripts
  'PageSpeed (PDP AIO avg)': 'pagespeed_pdp_aio',
  'PageSpeed PDP AIO Avg': 'pagespeed_pdp_aio',
  'DAU / MAU (stickiness)': 'dau_mau_stickiness',
  'DAU / MAU Stickiness': 'dau_mau_stickiness',
  'Nobl MAU / Active Subscribers': 'dau_mau_stickiness',
  'MAU / Active Subs (opened in 30d)': 'dau_mau_stickiness',
  'Sessions per MAU': 'sessions_per_mau',
  'Sessions per DAU': 'sessions_per_dau',
  // CS (cs_tickets_daily, via Mongo)
  'CS Tickets % of Orders': 'cs_tickets_pct',
  'CS Tickets as % of Orders': 'cs_tickets_pct', // FLO weekly label variant
  'CS Tickets as % of orders': 'cs_tickets_pct',
  'Total CS Tickets as % of total orders': 'cs_tickets_pct',
  'Total CS Tickets # amount': 'cs_tickets_count',
  'US CS Tickets as % of US orders': 'us_cs_tickets_pct',
  'US CS Tickets as % of Total orders': 'us_cs_tickets_pct',
  'US CS Tickets # amount': 'us_cs_tickets_count',
  'UK CS Tickets as % of UK orders': 'uk_cs_tickets_pct',
  'UK CS Tickets as % of US orders': 'uk_cs_tickets_pct',
  'UK CS Tickets # amount': 'uk_cs_tickets_count',
  'AUS CS Tickets as % of AUS orders': 'au_cs_tickets_pct',
  'AUS CS Tickets as % of Total orders': 'au_cs_tickets_pct',
  'AUS CS Tickets # amount': 'au_cs_tickets_count',
  'Canada CS Tickets as % of Canada orders': 'ca_cs_tickets_pct',
  'Canada CS Tickets as % of Total orders': 'ca_cs_tickets_pct',
  'Canada CS Tickets # amount': 'ca_cs_tickets_count',
  '# of tickets closed effective': 'cs_closed_count',
  'Ratio= # of tickets closed effective / total orders for that day': 'cs_closed_pct',
  'Total CB Rate': 'cb_rate',
  'CB Rate': 'cb_rate',
  'US CB Rate': 'us_cb_rate',
  'UK CB Rate': 'uk_cb_rate',
  'Uk CB Rate': 'uk_cb_rate',
  'AUS CB Rate': 'au_cb_rate',
  'Canada CB Rate': 'ca_cb_rate',
  // Paid Media derivations
  'Meta CVR %': 'meta_cvr',
  'Whitelisting Spend % of Meta Spend': 'whitelisting_spend_pct',
  'Whitelisting Spend as % of Weekly Meta Spend': 'whitelisting_spend_pct',
  '% Total Meta Spend on Whitelist': 'whitelisting_spend_pct',
  '% of Spend on Test Ad Sets': 'test_spend_pct',
  'TOF vs BOF Spend Split': 'tof_bof_spend_split',
  'Retention Rev %': 'retention_rev_pct',
  'Retention Rev as % of Gross Sales − Discounts': 'retention_rev_pct',
  'SMS % of Sales': 'sms_sales_pct',
  'SMS % of Gross Sales − Discounts': 'sms_sales_pct',
  'Email % of Gross Sales − Discounts': 'email_sales_pct',
  'Unsubscribe Rate': 'unsubscribe_rate',
  'Blended nCPA': 'new_customer_cac',
  'Bundle % of NOBL Revenue': 'bundle_rev_pct',
  'Bundle % of Total NOBL Revenue': 'bundle_rev_pct',
  'Site Conversion Rate': 'site_cvr',
  'Discounts as % of Gross Sales − Discounts': 'discounts_pct',
  'Returning vs New Customer Split (as visitors)': 'returning_new_customer_split',
  'Email — Flow vs Campaign Split': 'email_flow_campaign_split',
  'Total Refund Rate': 'refund_rate',
  'US Refund Rate': 'us_refund_rate',
  'UK Refund Rate': 'uk_refund_rate',
  'AUS Refund Rate': 'au_refund_rate',
  'Canada Refund Rate': 'ca_refund_rate',
  // Air subs (NOBL only)
  'Net Subscriber Adds': 'net_sub_adds',
  'Net Subscriber Adds (Air + Air+) — new paid subs minus cancellations same week': 'net_sub_adds',
  'International Activation Rate': 'intl_activation',
  'AUS Activation Rate %': 'au_activation',
  'CA Activation Rate %': 'ca_activation',
  'UK Activation Rate%': 'uk_activation',
  // FLO IAP
  'App Rev as % of Gross Sales − Discounts': 'app_rev_pct',
  'App Attach %': 'app_attach_pct',
  'Trial-to-Paid %': 'app_ttp',
  'Trial-to-Paid % (annual)': 'app_ttp',
  'App Net New Subs / Week — new paid subs minus cancellations same week': 'app_net_sub_adds',
  'Monthly Churn Rate': 'monthly_churn',
  'Monthly Churn Rate — cancelled this month / active subs at month start': 'monthly_churn',
  'App Lifetime Value (months)': 'app_lifetime_months',
  'Flo sub vs hardware % split': 'flo_sub_hardware_split',
  'Hardware Mix Sales (Portable vs Home/Studio %)': 'hardware_mix_sales',
  'Returning Customer Revenue %': 'returning_cust_rev_pct',
  'Returning Customer Revenue as % of Gross Sales − Discounts': 'returning_cust_rev_pct',
  // Strategist Share of Spend (NOBL ad_name code: 002TC/002FA/002LK/002CA)
  'Share of Spend TOF — Taylor': 'sos_taylor',
  'Share of Spend TOF — Franz':  'sos_franz',
  'Share of Spend TOF — Luke':   'sos_luke',
  'Share of Spend — Chris TOF':  'sos_chris',
  'Share of Spend TOF — Chris':  'sos_chris',
  'Ads launched in test-video-all combine for a 0.95 ROAS — Taylor': 'test_video_roas_taylor',
  'Ads launched in test-video-all combine for a 0.95 ROAS — Franz': 'test_video_roas_franz',
  'Ads launched in test-video-all combine for a 0.95 ROAS — Luke': 'test_video_roas_luke',
  'Ads launched in test-video-all combine for a 0.95 ROAS — Chris': 'test_video_roas_chris',
  // FLO Chris Share of Spend + product-bucket CAC (Chris is the FLO strategist)
  'Share of Spend — Chris':      'sos_chris',
  'Portable Reformer CAC':       'portable_cac',
  'nCPA — Portable Reformer':    'portable_cac',
  'Portable Ad CAC — Chris':     'portable_cac',
  'Home + Studio Blended CAC':   'home_studio_cac',
  'Home + Studio Reformer Blended CAC': 'home_studio_cac',
  'Sutido Ad CAC — Chris':       'studio_cac',
  'Studio Ad CAC — Chris':       'studio_cac',
  'nCPA — Studio Reformer':      'studio_cac',
  'Home Ad CAC — Chris':         'home_cac',
  'nCPA — Home Reformer':        'home_cac',
};

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const PCT_KEYS = new Set([
  'amazon_pct', 'air_rev_pct', 'attach', 'activation', 'ttp',
  'cs_tickets_pct', 'us_cs_tickets_pct', 'uk_cs_tickets_pct', 'au_cs_tickets_pct', 'ca_cs_tickets_pct',
  'cb_rate', 'us_cb_rate', 'uk_cb_rate', 'au_cb_rate', 'ca_cb_rate', 'meta_cvr', 'monthly_churn', 'returning_cust_rev_pct',
  'sos_taylor', 'sos_franz', 'sos_luke', 'sos_chris',
  'whitelisting_spend_pct', 'test_spend_pct', 'tof_spend_pct', 'retention_rev_pct', 'app_attach_pct', 'app_ttp',
  'bundle_rev_pct', 'us_sales_pct', 'ca_sales_pct', 'au_sales_pct', 'eu_sales_pct', 'uk_sales_pct',
  'refund_rate', 'us_refund_rate', 'uk_refund_rate', 'au_refund_rate', 'ca_refund_rate', 'cs_closed_pct', 'app_rev_pct', 'app_activation', 'sms_sales_pct', 'email_sales_pct', 'unsubscribe_rate', 'dau_mau_stickiness',
  'site_cvr', 'discounts_pct', 'intl_activation', 'au_activation', 'ca_activation', 'uk_activation',
]);
const RATIO_KEYS = new Set(['mer', 'us_mer', 'ca_mer', 'au_mer', 'eu_mer', 'uk_mer', 'test_video_roas_taylor', 'test_video_roas_franz', 'test_video_roas_luke', 'test_video_roas_chris']);
const MONEY_KEYS = new Set([
  'sales', 'aov', 'avg_shipping_cost', 'new_customer_cac',
  'portable_cac', 'studio_cac', 'home_cac', 'home_studio_cac',
]);
const INT_KEYS   = new Set(['orders_unfulfilled', 'orders_unfulfilled_24h', 'us_orders_unfulfilled', 'uk_orders_unfulfilled', 'us_orders_unfulfilled_24h', 'uk_orders_unfulfilled_24h', 'ca_orders_unfulfilled', 'au_orders_unfulfilled', 'net_sub_adds', 'cs_tickets_count', 'us_cs_tickets_count', 'uk_cs_tickets_count', 'au_cs_tickets_count', 'ca_cs_tickets_count', 'cs_closed_count', 'app_net_sub_adds', 'pagespeed_pdp_aio']);
const DAY_KEYS = new Set(['avg_fulfillment_days', 'avg_ship_to_door_days', 'ca_ttf_days', 'au_ttf_days', 'uk_ttf_days']);
const DECIMAL_KEYS = new Set(['sessions_per_mau', 'sessions_per_dau']);
const MONTH_KEYS = new Set(['app_lifetime_months']);
const STRING_KEYS = new Set(['tof_bof_spend_split', 'flo_sub_hardware_split', 'hardware_mix_sales', 'email_flow_campaign_split', 'returning_new_customer_split']);

// Keys only available for NOBL. (US MER works for both; Canada MER + Air metrics +
// blended MER + Amazon + AOV are NOBL-only at the data layer. The strategist Share
// of Spend keys are available on BOTH brands — Chris notably is the FLO strategist,
// but the same endpoint key `sos_chris` is returned per brand from its own series.)
const NOBL_ONLY_KEYS = new Set([
  'amazon_pct', 'air_rev_pct', 'attach', 'activation', 'ttp', 'net_sub_adds', 'new_customer_cac', 'bundle_rev_pct',
  'sos_taylor', 'sos_franz', 'sos_luke',
]);
// Keys only available for FLO.
const FLO_ONLY_KEYS = new Set([
  'monthly_churn', 'app_attach_pct', 'app_ttp', 'app_rev_pct', 'app_net_sub_adds', 'app_activation',
  'portable_cac', 'studio_cac', 'home_cac', 'home_studio_cac', 'app_lifetime_months', 'flo_sub_hardware_split', 'hardware_mix_sales',
]);

function dbKeyFor(brand, metric) {
  if (brand === 'FLO' && metric === 'Activation Rate (Attach Rate × TTP)') return 'app_activation';
  const k = DB_KEY[metric];
  if (!k) return null;
  if (brand !== 'NOBL' && NOBL_ONLY_KEYS.has(k)) return null;
  if (brand !== 'FLO'  && FLO_ONLY_KEYS.has(k))  return null;
  return k;
}

function fmtMetricValue(key, v) {
  if (STRING_KEYS.has(key)) return v == null || v === '' ? null : String(v);
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  if (RATIO_KEYS.has(key)) return `${n.toFixed(2)}x`;
  if (PCT_KEYS.has(key))   return `${(n * 100).toFixed(2)}%`;
  if (MONEY_KEYS.has(key)) return `$${(Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (INT_KEYS.has(key))   return Math.round(n).toLocaleString();
  if (DAY_KEYS.has(key))   return `${n.toFixed(2)}d`;
  if (DECIMAL_KEYS.has(key)) return n.toFixed(2);
  if (MONTH_KEYS.has(key)) return `${n.toFixed(2)} months`;
  return String(v);
}

function parseTarget(t) {
  if (t == null) return null;
  const cleaned = String(t).replace(/[≥≤→~xX$,%\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Metrics where LOWER values are better (target prefixed with "<" or otherwise
// understood as a ceiling). When LOWER_IS_BETTER, the displayed variance is
// flipped so a "negative variance" reads as the on-target direction — the same
// status thresholds then work without further changes.
function isLowerIsBetter(target, key) {
  if (target && /^[\s]*<|≤/.test(String(target))) return true;
  // Default by key for metrics whose target string isn't always "< X" but
  // semantically lower is still better.
  return new Set([
    'cs_tickets_pct', 'cs_tickets_count', 'orders_unfulfilled', 'orders_unfulfilled_24h', 'monthly_churn',
    'cb_rate', 'us_cb_rate', 'uk_cb_rate', 'au_cb_rate', 'ca_cb_rate',
    'avg_shipping_cost', 'avg_fulfillment_days', 'avg_ship_to_door_days', 'ca_ttf_days', 'au_ttf_days',
    'new_customer_cac', 'portable_cac', 'studio_cac', 'home_cac', 'home_studio_cac', 'refund_rate',
  ]).has(key);
}

function varianceFor(key, rawLatest, target) {
  const tgt = parseTarget(target);
  if (tgt == null || tgt === 0 || rawLatest == null) return '';
  const scaled = PCT_KEYS.has(key) ? rawLatest * 100 : rawLatest;
  const rawPct = ((scaled - tgt) / Math.abs(tgt)) * 100;
  // Invert sign for lower-is-better so the variance reads "+X% better than target"
  // when actual < target, and "-X% worse than target" when actual > target.
  const pct = isLowerIsBetter(target, key) ? -rawPct : rawPct;
  return `${pct.toFixed(1)}%`;
}

const KPI_BRAND_OPTIONS = [
  { value: 'ALL', label: 'All brands' },
  { value: 'NOBL', label: 'NOBL' },
  { value: 'FLO', label: 'FLO' },
];

const KPI_STATUS_OPTIONS = [
  { value: 'ALL', label: 'All status' },
  { value: 'RED', label: 'Needs help' },
  { value: 'YELLOW', label: 'Watch' },
  { value: 'GREEN', label: 'On track' },
  { value: 'BLUE', label: 'Ahead' },
  { value: 'GRAY', label: 'No target' },
];

const KPI_CADENCE_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'quarterly', label: 'Quarterly' },
];

const KPI_CATEGORY_OPTIONS = [
  { value: 'ALL', label: 'All KPI groups' },
  { value: 'REVENUE', label: 'Revenue / MER / Sales' },
  { value: 'ADS', label: 'Ads / Meta / CAC' },
  { value: 'AIR_APP', label: 'Air / App / Subscriptions' },
  { value: 'RETENTION', label: 'Retention / Email / SMS' },
  { value: 'OPS', label: 'Ops / Shipping / Fulfillment' },
  { value: 'CS', label: 'Customer Support' },
  { value: 'CREATIVE', label: 'Creative / Site / Social' },
];

const KPI_BRAND_ALLOWED = new Set(['NOBL', 'FLO']);
const KPI_STATUS_ALLOWED = new Set(['RED', 'YELLOW', 'GREEN', 'BLUE', 'GRAY']);

const normalizeKpiBrands = (next) => normalizeMultiFilter(next, KPI_BRAND_ALLOWED, ['NOBL', 'FLO']);
const normalizeKpiStatuses = (next) => normalizeMultiFilter(next, KPI_STATUS_ALLOWED, ['RED', 'YELLOW', 'GREEN', 'BLUE', 'GRAY']);

function categoryFor(row) {
  const text = `${row.department || ''} ${row.metric || ''}`.toLowerCase();
  if (/cs|ticket|chargeback/.test(text)) return 'CS';
  if (/ops|ship|fulfill|unfulfilled/.test(text)) return 'OPS';
  if (/air|app|subscriber|trial-to-paid|attach|activation|churn|dau|mau/.test(text)) return 'AIR_APP';
  if (/retention|email|sms|unsubscribe|returning/.test(text)) return 'RETENTION';
  if (/meta|cac|spend|tof|bof|creative|taylor|chris|ad /.test(text)) return 'ADS';
  if (/social|instagram|tiktok|pagespeed|site conversion|partnership|instructor|influencer/.test(text)) return 'CREATIVE';
  return 'REVENUE';
}

function rowOverrideKey(row) { return `row:${row.cadence}:${row.brand}:${row.department || ''}:${row.baseMetric || row.metric}`; }
function cellOverrideKey(row, period) { return `cell:${row.cadence}:${row.brand}:${row.department || ''}:${row.baseMetric || row.metric}:${period.key}`; }

function applyOverrides(row, periods, overrides = {}) {
  const baseMetric = row.baseMetric || row.metric;
  const rowPatch = overrides[rowOverrideKey({ ...row, baseMetric })] || {};
  const next = { ...row, ...rowPatch, baseMetric };
  next.category = rowPatch.category || row.category || categoryFor(next);
  next.values = (row.values || []).map((v, idx) => {
    const period = periods[idx];
    const cellPatch = period ? overrides[cellOverrideKey({ ...next, baseMetric }, period)] : null;
    return cellPatch?.value ?? v;
  });
  next.latest = next.values.find(v => v && v !== '—') || next.latest;
  return next;
}

function SingleFilterSelect({ label, value, onChange, options, minWidth = 150, compact = true }) {
  const [open, setOpen] = useState(false);
  const selected = options.find(opt => opt.value === value) || options[0];

  return (
    <div className="filter-multi-select" style={{ minWidth }}>
      {label && <span className="filter-multi-select__label">{label}</span>}
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className={`filter-multi-select__btn${compact ? ' filter-multi-select__btn--compact' : ''}`}
          onClick={() => setOpen(o => !o)}
          title={selected?.label || value}
        >
          {selected?.label || value}
        </button>
        <span className="filter-multi-select__caret">▼</span>

        {open && (
          <>
            <div className="filter-multi-select__backdrop" onClick={() => setOpen(false)} />
            <div className="filter-multi-select__menu" style={{ padding: 6 }}>
              {options.map(opt => {
                const active = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => { onChange(opt.value); setOpen(false); }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      border: 'none',
                      borderRadius: 7,
                      padding: '8px 9px',
                      background: active ? 'var(--accent-dim)' : 'transparent',
                      color: active ? 'var(--accent)' : 'var(--text2)',
                      fontSize: 12,
                      fontWeight: active ? 850 : 650,
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-body)',
                    }}
                  >
                    <span>{opt.label}</span>
                    {active && <span style={{ fontSize: 11 }}>✓</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const DAILY_KPI_CATALOG = `
NOBL|Paid Media|Brad|NOBL Blended MER|3
NOBL|Paid Media|Brad|Gross Sales − Discounts|n/a
NOBL|Paid Media|Brad|NOBL Air Rev as % of Total Sales|0.05
NOBL|Paid Media|Brad|Amazon Rev as % of Gross Sales|0.015
NOBL|NOBL Bundles Pod|Alex|Bundle % of Total NOBL Revenue|0.55
NOBL|NOBL Bundles Pod|Alex|AOV|553
NOBL|NOBL Bundles Pod|Alex|Bundle CM1 %|60 %
NOBL|NOBL Air Pod|Simon|Activation Rate (Attach × TTP)|0.12
NOBL|NOBL Air Pod|Simon|Attach Rate|0.2
NOBL|NOBL Air Pod|Simon|Trial-to-Paid (TTP)|n/a
NOBL|Creative|Brad|TOF vs BOF Spend Split|n/a
NOBL|Retention|Daniel|Retention Rev as % of Gross Sales − Discounts|0.3
NOBL|Retention|Daniel|SMS % of Gross Sales − Discounts|0.1
NOBL|Retention|Daniel|Email % of Gross Sales − Discounts|0.2
NOBL|Partnerships / Whitelisting|Shaleem|% Total Meta Spend on Whitelist|50%
NOBL|Ops|Shumail|Total orders partially unfulfilled|<4000
NOBL|Ops||US Orders partially unfulfilled|
NOBL|Ops||UK orders partially unfulfilled|
NOBL|Ops||UK Time to Fulfillment|
NOBL|Ops|Shumail|US Time to Fulfillment|2 Days
NOBL|Ops||AUS Time to Fulfillment|
NOBL|Ops||CA Time to Fulfillment|
NOBL|Ops|Shumail|Avg Shipping Cost per Order|20
NOBL|Ops|Shumail|Avg shipping time length (from shipped to customer door)|4 Days
NOBL|Ops|Shumail|CANADA Partially Unfulfilled Orders #|<200
NOBL|Ops|Shumail|AUSTRALIA Partially Unfulfilled Orders #|<50
NOBL|CS|Hassan|Total CS Tickets as % of total orders|n/a
NOBL|CS|Hassan|Total CS Tickets # amount|n/a
NOBL|CS||US CS Tickets as % of US orders|
NOBL|CS||US CS Tickets # amount|
NOBL|CS||UK CS Tickets as % of UK orders|
NOBL|CS||UK CS Tickets # amount|
NOBL|CS||AUS CS Tickets as % of AUS orders|
NOBL|CS||AUS CS Tickets # amount|
NOBL|CS||Canada CS Tickets as % of Canada orders|
NOBL|CS||Canada CS Tickets # amount|
NOBL|CS|Hassan|Total CB Rate|n/a
NOBL|CS||US CB Rate|
NOBL|CS||UK CB Rate|
NOBL|CS||AUS CB Rate|
NOBL|CS||Canada CB Rate|
NOBL|CS||Total Refund Rate|
NOBL|CS||US Refund Rate|
NOBL|CS||AUS Refund Rate|
NOBL|CS||Canada Refund Rate|
NOBL|CS|Hassan|# of tickets closed effective|n/a
NOBL|CS|Hassan|Ratio= # of tickets closed effective / total orders for that day|n/a
NOBL|Web Eng|Sobayyal|PageSpeed (PDP AIO avg)|70
NOBL|App / NOBL Air|Ali Hashim|MAU / Active Subs (opened in 30d)|Set baseline
NOBL|App / NOBL Air|Ali Hashim|Sessions per MAU|Set baseline
FLO|Paid Media|Brad|Portable Reformer CAC|129
FLO|Paid Media|Brad|Home + Studio Reformer Blended CAC|1097
FLO|Paid Media|Brad|Gross Sales − Discounts (Flo)|n/a
FLO|Paid Media|Brad|App Rev as % of Gross Sales − Discounts|0.36
FLO|FLO App|Kolachi|Flo sub vs hardware % split|n/a
FLO|FLO App|Kolachi|Hardware Mix Sales (Portable vs Home/Studio %)|n/a
FLO|FLO App|Kolachi|App Attach %|≥70%
FLO|FLO App|Kolachi|App Lifetime Value (months)|2.6 months
FLO|FLO App|Kolachi|LTV / CAC|2.5
FLO|Creative|Luke|TOF vs BOF Spend Split|n/a
FLO|Partnerships / Whitelisting||% Total Meta Spend on Whitelist|
FLO|Retention|Daniel|Retention Rev as % of Gross Sales − Discounts|0.3
FLO|Retention|Daniel|SMS % of Gross Sales − Discounts|0.1
FLO|Retention|Daniel|Email % of Gross Sales − Discounts|0.2
FLO|Ops|Shumail|Orders partially unfulfilled|100
FLO|Ops|Shumail|US Time to Fulfillment|1.5 days
FLO|Ops||AUS Time to Fulfillment|
FLO|Ops||CA Time to Fulfillment|
FLO|Ops|Shumail|Avg Shipping Cost per Order|13
FLO|Ops|Shumail|Avg shipping time length (from shipped to customer door)|4 days
FLO|Ops|Shumail|CANADA Partially Unfulfilled Orders #|
FLO|Ops|Shumail|AUSTRALIA Partially Unfulfilled Orders #|
FLO|CS|Hassan|Total CS Tickets as % of total orders|0.02
FLO|CS|Hassan|Total CS Tickets # amount|n/a
FLO|CS||US CS Tickets as % of Total orders|
FLO|CS||US CS Tickets # amount|
FLO|CS||AUS CS Tickets as % of Total orders|
FLO|CS||AUS CS Tickets # amount|
FLO|CS||Canada CS Tickets as % of Total orders|
FLO|CS||Canada CS Tickets # amount|
FLO|CS|Hassan|CB Rate|
FLO|CS||US CB Rate|
FLO|CS||AUS CB Rate|
FLO|CS||Canada CB Rate|
FLO|CS||Total Refund Rate|
FLO|CS||US Refund Rate|
FLO|CS||AUS Refund Rate|
FLO|CS||Canada Refund Rate|
FLO|CS|Hassan|# of tickets closed effective|
FLO|CS|Hassan|Ratio= # of tickets closed effective / total orders for that day|n/a
FLO|Web Eng|Sobayyal|PageSpeed (PDP AIO avg)|70
FLO|App|Ali Hashim|DAU / MAU (stickiness)|n/a
FLO|App|Ali Hashim|Sessions per DAU|n/a
`;

const WEEKLY_KPI_CATALOG = `
NOBL|Paid Media|Brad|NOBL Blended MER|3.2x
NOBL|Paid Media|Brad|Gross Sales − Discounts|On plan
NOBL|Paid Media|Simon|NOBL Air Rev as % of Total Sales|0.05
NOBL|Paid Media|Brad|Amazon Rev as % of Gross Sales − Discounts|0.015
NOBL|Paid Media|Brad|Blended nCPA|197
NOBL|Paid Media|Brad|Meta CVR %|0.0059
NOBL|Paid Media|Brad|% of Spend on Test Ad Sets|0.25
NOBL|Paid Media|Anthony|Whitelisting Spend as % of Weekly Meta Spend|0.5
NOBL|Paid Media|Brad|US — MER|3.35
NOBL|Paid Media||UK — MER|
NOBL|Paid Media|Brad|Canada — MER|2.44
NOBL|Paid Media|Brad|Australia — MER|2.31
NOBL|Paid Media|Brad|EU — MER|2.44
NOBL|Paid Media|Brad|USA Sales as % of Total Sales|0.94
NOBL|Paid Media|Brad|Canada Sales as % of Total Sales|0.05
NOBL|Paid Media|Brad|Australia Sales as % of Total Sales|0.02
NOBL|Paid Media|Brad|EU Sales as % of Total Sales|0.0075
NOBL|Paid Media||Uk Sales as % of Total Sales|
NOBL|NOBL Bundles Pod|Alex|Bundle % of Total NOBL Revenue|0.65
NOBL|NOBL Bundles Pod|Alex|AOV|560
NOBL|NOBL Bundles Pod|Alex|Bundle CM1 %|0.6
NOBL|CRO / Site|Alex|Site Conversion Rate|0.012
NOBL|CRO / Site|Alex|Returning vs New Customer Split (as visitors)|35% / 65%
NOBL|CRO / Site|Alex|Discounts as % of Gross Sales − Discounts|0.1
NOBL|NOBL Air Pod|Simon|Activation Rate (Attach × TTP)|12% by Apr 30
NOBL|NOBL Air Pod|Simon|Attach Rate|≥50%
NOBL|NOBL Air Pod|Simon|Trial-to-Paid (TTP)|≥70%
NOBL|NOBL Air Pod|Simon|Net Subscriber Adds (Air + Air+) — new paid subs minus cancellations same week|Set target
NOBL|NOBL Air Pod|Simon|International Activation Rate|Set baseline
NOBL|NOBL Air Pod||AUS Activation Rate %|
NOBL|NOBL Air Pod||CA Activation Rate %|
NOBL|NOBL Air Pod||UK Activation Rate%|
NOBL|Creative|Luke|TOF vs BOF Spend Split|Set target
NOBL|Creative|Luke|Share of Spend TOF — Taylor|0.33
NOBL|Creative|Luke|Share of Spend TOF — Franz|0.33
NOBL|Creative|Luke|Share of Spend TOF — Luke|0.33
NOBL|Creative|Luke|Ads launched in test-video-all combine for a 0.95 ROAS — Taylor|0.95
NOBL|Creative|Luke|Ads launched in test-video-all combine for a 0.95 ROAS — Franz|0.95
NOBL|Creative|Luke|Ads launched in test-video-all combine for a 0.95 ROAS — Luke|0.95
NOBL|Creative|Luke|Ads launched in test-video-all combine for a 0.95 ROAS — Chris|0.95
NOBL|Retention|Daniel|Retention Rev as % of Gross Sales − Discounts|≥30%
NOBL|Retention|Daniel|SMS % of Gross Sales − Discounts|Set baseline
NOBL|Retention|Daniel|Email — Flow vs Campaign Split|≥60% flows
NOBL|Retention|Daniel|Returning Customer Revenue as % of Gross Sales − Discounts|Set baseline
NOBL|Retention|Daniel|Unsubscribe Rate|<0.3%
NOBL|Retention|Daniel|List Growth vs Churn — (new subs − unsubs) / list at start of week|Net positive
NOBL|Partnerships / Whitelisting|Shaleem|New Partners Onboarded / Week|Set target
NOBL|Social Media|Fatima|Engagement Rate (Insta)|<2.5%
NOBL|Social Media|Fatima|Engagement Rate (TikTok)|<3%
NOBL|Social Media|Fatima|Instagram Total Posts (feed + stories + reels)|77
NOBL|Social Media|Fatima|TikTok Total Posts (all formats)|21
NOBL|Social Media|Fatima|Follower Growth — Instagram|Set target
NOBL|Social Media|Fatima|Follower Growth — TikTok|Set target
NOBL|Ops||Orders Unfulfilled >24hrs|0
NOBL|Ops||US Orders Unfulfilled >24hrs|
NOBL|Ops||UK Orders Unfulfilled >24hrs|
NOBL|Ops|Shumail|unfulfilled orders|<4000
NOBL|Ops||US unfulfilled orders|
NOBL|Ops||UK unfulfilled orders|
NOBL|Ops||UK Time to Fulfillment|
NOBL|Ops|Shumail|Time to Fulfillment|<2
NOBL|Ops|Shumail|Avg Shipping Cost per Order|20
NOBL|Sales + CS|Hassan|CS Tickets as % of orders|<2%
NOBL|Sales + CS||Total CS Tickets # amount|
NOBL|Sales + CS||US CS Tickets as % of US orders|
NOBL|Sales + CS||US CS Tickets # amount|
NOBL|Sales + CS||UK CS Tickets as % of US orders|
NOBL|Sales + CS||UK CS Tickets # amount|
NOBL|Sales + CS||AUS CS Tickets as % of AUS orders|
NOBL|Sales + CS||AUS CS Tickets # amount|
NOBL|Sales + CS||Canada CS Tickets as % of Canada orders|
NOBL|Sales + CS||Canada CS Tickets # amount|
NOBL|Sales + CS||Total CB Rate|
NOBL|Sales + CS||US CB Rate|
NOBL|Sales + CS||Uk CB Rate|
NOBL|Sales + CS||AUS CB Rate|
NOBL|Sales + CS||Canada CB Rate|
NOBL|Sales + CS||Total Refund Rate|
NOBL|Sales + CS||US Refund Rate|
NOBL|Sales + CS||UK Refund Rate|
NOBL|Sales + CS||AUS Refund Rate|
NOBL|Sales + CS||Canada Refund Rate|
NOBL|Sales + CS||# of tickets closed effective|
NOBL|Sales + CS|Hassan|B2B Revenue ($)|12000
NOBL|Sales + CS|Hassan|B2C Revenue ($)|85000
NOBL|Sales + CS|Hassan|Wrong Order Rate % ( wrong order tickets as % of total orders)|<0.5%
NOBL|Sales + CS|Hassan|First Response Time|<2 hours
NOBL|Sales + CS|Hassan|Recovery Revenue (saved cancellations)|300000
NOBL|Sales + CS|Hassan|Top 3 Ticket Themes + AI Summary|Declining themes
NOBL|Sales + CS||Csat|
NOBL|Web Eng|Sobayyal|PageSpeed (PDP AIO avg)|70
NOBL|App|Kolachi|Activation Rate (Attach Rate × TTP)|12% by Apr 30
NOBL|App|Ali Hashim|Nobl MAU / Active Subscribers|5
NOBL|App|Ali Hashim|Sessions per MAU|10
FLO|Paid Media|Brad|Portable Reformer CAC|125
FLO|Paid Media|Brad|Home + Studio Reformer Blended CAC|1047
FLO|Paid Media|Brad|Gross Sales − Discounts (Flo)|On plan
FLO|Paid Media|Brad|App Rev as % of Gross Sales − Discounts|0.294
FLO|Paid Media|Brad|nCPA — Portable Reformer|125
FLO|Paid Media|Brad|nCPA — Home Reformer|1148
FLO|Paid Media|Brad|nCPA — Studio Reformer|648
FLO|Paid Media|Brad|Meta CVR %|0.0093
FLO|Paid Media|Brad|% of Spend on Test Ad Sets|0.3
FLO|Paid Media|Anthony|Whitelisting Spend as % of Weekly Meta Spend|0.5
FLO|Paid Media|Brad|US — MER|1.82
FLO|Paid Media|Brad|Canada — MER|1.06
FLO|Paid Media|Brad|Australia — MER|1.65
FLO|Paid Media|Brad|EU — MER|Set target
FLO|Paid Media|Brad|USA Sales as % of Total Sales|0.942
FLO|Paid Media|Brad|Canada Sales as % of Total Sales|0.03
FLO|Paid Media|Brad|Australia Sales as % of Total Sales|0.028
FLO|Paid Media|Brad|EU Sales as % of Total Sales|Set baseline
FLO|FLO App|Kolachi|Flo Hardware Revenue vs Plan|Tracking $34M FY
FLO|FLO App|Kolachi|Hardware Mix Sales (Portable vs Home/Studio %)|Portable ≥65%
FLO|FLO App|Kolachi|App Attach %|≥70%
FLO|FLO App|Kolachi|App Lifetime Value (months)|Set baseline
FLO|FLO App|Kolachi|LTV / CAC|>3.0x
FLO|FLO App|Kolachi|App Net New Subs / Week — new paid subs minus cancellations same week|≥1,000
FLO|FLO App|Kolachi|Trial-to-Paid % (annual)|≥60%
FLO|FLO App|Kolachi|Monthly Churn Rate — cancelled this month / active subs at month start|<8%
FLO|CRO / Site|Alex|Site Conversion Rate|Set baseline
FLO|CRO / Site|Alex|Returning vs New Customer Split (as visitors)|Track
FLO|CRO / Site|Alex|Discounts as % of Gross Sales − Discounts|Set target
FLO|Creative|Brad|TOF vs BOF Spend Split|Set target
FLO|Creative|Luke|Share of Spend — Chris|1
FLO|Creative|Luke|Portable Ad CAC — Chris|94
FLO|Creative|Luke|Sutido Ad CAC — Chris|486
FLO|Creative|Luke|Home Ad CAC — Chris|861
FLO|Retention|Daniel|Retention Rev as % of Gross Sales − Discounts|≥30%
FLO|Retention|Daniel|SMS % of Gross Sales − Discounts|Set baseline
FLO|Retention|Daniel|Email — Flow vs Campaign Split|≥60% flows
FLO|Retention|Daniel|Returning Customer Revenue as % of Gross Sales − Discounts|Set baseline
FLO|Retention|Daniel|Unsubscribe Rate|<0.3%
FLO|Retention|Daniel|List Growth vs Churn — (new subs − unsubs) / list at start of week|Net positive
FLO|Partnerships / Organic + Instructors|Olivia|Flo Instructors Onboarded|3
FLO|Partnerships / Organic + Instructors|Olivia|USA Influencers Onboarded|11
FLO|Partnerships / Organic + Instructors|Olivia|Canada Influencers Onboarded|11
FLO|Partnerships / Organic + Instructors|Olivia|Australia Influencers Onboarded|6
FLO|Partnerships / Organic + Instructors|Olivia|UK Influencers Onboarded|9
FLO|Social Media|Fatima|Engagement Rate (Insta)|<2%
FLO|Social Media|Fatima|Engagement Rate (TikTok)|<4%
FLO|Social Media|Fatima|Instagram Total Posts (feed + stories + reels)|50
FLO|Social Media|Fatima|TikTok Total Posts (all formats)|21
FLO|Social Media|Fatima|Follower Growth — Instagram|Set target
FLO|Social Media|Fatima|Follower Growth — TikTok|Set target
FLO|Ops|Shumail|Orders Unfulfilled >24hrs|0
FLO|Ops|Shumail|Time to Fulfillment|1
FLO|Ops|Shumail|Avg Shipping Cost per Order|14
FLO|Sales + CS|Hassan|CS Tickets as % of Orders|<2%
FLO|Sales + CS|Hassan|B2C Revenue ($)|12000
FLO|Sales + CS|Hassan|Wrong Order Rate %|<0.5%
FLO|Sales + CS|Hassan|First Response Time|<2 hours
FLO|Sales + CS|Hassan|Recovery Revenue (saved cancellations)|
FLO|Sales + CS|Hassan|Top 3 Ticket Themes + AI Summary|
FLO|Sales + CS||Csat|
FLO|Web Eng|Sobayyal|PageSpeed (PDP AIO avg)|70
FLO|App|Ali Hashim|Activation Rate (Attach Rate × TTP)|0.4
FLO|App|Ali Hashim|DAU / MAU (stickiness)|0.15
FLO|App|Ali Hashim|Sessions per DAU|≥1.5
`;

// QTD_Weekly Sheet tab. Kept separate from Weekly so Quarterly can diverge
// without accidentally inheriting non-QTD rows.
const QUARTERLY_KPI_CATALOG = WEEKLY_KPI_CATALOG;

function normalizeCatalogTarget(metric, target) {
  const t = String(target || '').trim();
  if (!t) return '';
  if (/^(n\/a|na)$/i.test(t)) return 'n/a';
  const n = Number(t.replace(/[$,%x,]/g, ''));
  if (!Number.isFinite(n)) return t;
  const pctLike = /%|rate|split|cvr|attach|trial-to-paid|churn|stickiness|activation|retention|sms|email|returning|whitelist|spend|refund|tickets as %|growth/i.test(metric);
  if (pctLike && n > 0 && n < 1) return `${(n * 100).toFixed(n * 100 < 1 ? 2 : 1).replace(/\.0$/, '')}%`;
  if (/\bMER\b/i.test(metric)) return `${n}x`;
  if (/CAC|nCPA|AOV|Shipping Cost|Revenue \(\$\)|B2B Revenue|B2C Revenue|Recovery Revenue/i.test(metric)) return `$${n.toLocaleString()}`;
  return t;
}

function catalogRows(cadence, csv) {
  return csv.trim().split('\n').map((line) => {
    const [brand, department, owner, metric, target] = line.split('|');
    return {
      cadence,
      brand,
      department,
      owner,
      metric,
      target: normalizeCatalogTarget(metric, target),
      variance: '',
      latest: '—',
      values: [],
    };
  });
}

const KPI_ROWS = [
  ...catalogRows('daily', DAILY_KPI_CATALOG),
  ...catalogRows('weekly', WEEKLY_KPI_CATALOG),
  ...catalogRows('quarterly', QUARTERLY_KPI_CATALOG),
];

function parseNum(value) {
  const cleaned = String(value ?? '').replace(/[$,%x,]/g, '').trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function statusFor(row) {
  const v = parseNum(row.variance);
  if (v == null) return 'gray';
  if (v >= 20) return 'blue';
  if (v >= -5) return 'green';
  if (v >= -15) return 'yellow';
  return 'red';
}

function seriesFor(row, periods) {
  return (periods || []).map((p, i) => ({ period: p.label, value: parseNum(row.values?.[i]) ?? 0, raw: row.values?.[i] || '—' })).reverse();
}

function fmtTrendValue(v, row) {
  const sample = String(row.latest || row.values?.[0] || '');
  if (sample.includes('$')) return `$${fmtNum(v)}`;
  if (sample.includes('%')) return `${Number(v).toFixed(v < 10 ? 2 : 1)}%`;
  if (sample.toLowerCase().includes('x') || /MER|ROAS|LTV/i.test(row.metric)) return `${Number(v).toFixed(2)}x`;
  return fmtNum(v);
}

function monthLabel(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return ym || 'Latest';
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}

function StatusPill({ status }) {
  const s = STATUS_META[status] || STATUS_META.gray;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 999,
      fontSize: 11, fontWeight: 850, color: s.color, background: s.bg, border: `1px solid ${s.border}`, whiteSpace: 'nowrap' }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: s.color }} />{s.label}
    </span>
  );
}

const PERIOD_COL_WIDTH = 132;
const KPI_LABEL_COL_WIDTH = 320;

function periodMeta(period, index) {
  return { label: period.label, sub: index === 0 ? 'Latest' : period.sub };
}

function EditableMiniField({ value, onSave, style }) {
  const [draft, setDraft] = useState(value || '');
  useEffect(() => { setDraft(value || ''); }, [value]);
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== (value || '')) onSave(draft); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      style={{
        width: '100%', border: '1px solid var(--border)', borderRadius: 7,
        background: 'var(--bg)', color: 'var(--text)', padding: '6px 8px',
        fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 850, lineHeight: 1.25, ...style,
      }}
    />
  );
}

function KpiRowLabel({ row, onSelect, editMode, onEdit }) {
  const st = STATUS_META[row.status] || STATUS_META.gray;
  const brandColor = row.brand === 'NOBL' ? NOBL_ACCENT : FLO_ACCENT;
  return (
    <div
      onClick={() => onSelect?.(row)}
      style={{ cursor: onSelect ? 'pointer' : 'default', minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minWidth: 0, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: st.color, flexShrink: 0 }} />
          <span style={{ fontSize: 11, fontWeight: 950, color: brandColor, letterSpacing: '.08em' }}>{row.brand}</span>
          <span style={{ fontSize: 11, color: 'var(--text4)', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.department}>
            {row.department}
          </span>
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 850, color: st.color, background: st.bg, border: `1px solid ${st.border}`, borderRadius: 999, padding: '3px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {st.label}
        </span>
      </div>
      <div title={row.metric} style={{ fontSize: 14, fontWeight: 950, lineHeight: 1.3, color: 'var(--text)', marginBottom: 10 }}>
        {editMode ? <EditableMiniField value={row.metric} onSave={(v) => onEdit?.(row, { metric: v })} style={{ fontSize: 13 }} /> : row.metric}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 11 }}>
        <div title={`Target: ${row.target || '—'}`}>
          <div style={{ fontSize: 9.5, color: 'var(--text4)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em' }}>Target</div>
          <div style={{ marginTop: 4, color: 'var(--text2)', fontWeight: 850, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {editMode ? <EditableMiniField value={row.target} onSave={(v) => onEdit?.(row, { target: v })} /> : (row.target || '—')}
          </div>
        </div>
        <div title={`Owner: ${row.owner || '—'}`}>
          <div style={{ fontSize: 9.5, color: 'var(--text4)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em' }}>Owner</div>
          <div style={{ marginTop: 4, color: 'var(--text2)', fontWeight: 850, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {editMode ? <EditableMiniField value={row.owner} onSave={(v) => onEdit?.(row, { owner: v })} /> : (row.owner || '—')}
          </div>
        </div>
        <div title={`Latest: ${row.latest || '—'}`}>
          <div style={{ fontSize: 9.5, color: 'var(--text4)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em' }}>Latest</div>
          <div style={{ marginTop: 4, color: st.color, fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.latest || '—'}</div>
        </div>
      </div>
    </div>
  );
}

function RawKpiTable({ rows, cadence, periods = [], onSelect, editMode, onRowEdit, onCellEdit }) {
  const [matrixSearch, setMatrixSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('ALL');
  const scrollRef = React.useRef(null);
  const searchTerm = matrixSearch.trim().toLowerCase();
  const ownerOptions = useMemo(() => {
    const owners = Array.from(new Set(rows.map(r => r.owner).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    return ['ALL', ...owners];
  }, [rows]);
  const matrixRows = useMemo(() => {
    return rows.filter((row) => {
      if (ownerFilter !== 'ALL' && row.owner !== ownerFilter) return false;
      if (!searchTerm) return true;
      const haystack = [
        row.brand,
        row.department,
        row.metric,
        row.owner,
        row.target,
        row.variance,
        row.latest,
        STATUS_META[row.status]?.label,
        row.status,
        ...(row.values || []),
      ].join(' ').toLowerCase();
      return haystack.includes(searchTerm);
    });
  }, [rows, searchTerm, ownerFilter]);
  const tableWidth = KPI_LABEL_COL_WIDTH + (Math.max(periods.length, 1) * PERIOD_COL_WIDTH);
  const cadenceLabel = cadence === 'daily' ? 'Daily' : cadence === 'weekly' ? 'Weekly' : cadence === 'monthly' ? 'Monthly' : 'Quarterly';
  return (
    <ChartPanel
      title={`KPI matrix — ${cadenceLabel}`}
      subtitle="Metrics down the left; dates across the top (latest column first). Search filters KPI rows."
      style={{ padding: 18, minHeight: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 620px', minWidth: 320, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', minWidth: 260, flex: '1 1 360px', maxWidth: 560 }}>
          <input
            value={matrixSearch}
            onChange={(e) => setMatrixSearch(e.target.value)}
            placeholder="Search KPI rows: owner, metric, department, target, status…"
            style={{
              width: '100%',
              padding: '10px 32px 10px 32px',
              background: 'var(--bg3)',
              border: '1px solid var(--border2)',
              borderRadius: 9,
              color: 'var(--text)',
              fontSize: 12.5,
              outline: 'none',
              fontFamily: 'var(--font-body)',
            }}
            onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
            onBlur={(e) => { e.target.style.borderColor = 'var(--border2)'; }}
            aria-label="Search KPI matrix rows"
          />
          <svg
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', opacity: 0.45, pointerEvents: 'none' }}
            width={13}
            height={13}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          {matrixSearch ? (
            <button
              type="button"
              onClick={() => setMatrixSearch('')}
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                color: 'var(--text3)',
                cursor: 'pointer',
                fontSize: 15,
                padding: 0,
                lineHeight: 1,
              }}
              title="Clear matrix search"
            >
              ×
            </button>
          ) : null}
        </div>
        <SingleFilterSelect
          label="Owner"
          value={ownerFilter}
          onChange={setOwnerFilter}
          options={ownerOptions.map(owner => ({ value: owner, label: owner === 'ALL' ? 'All owners' : owner }))}
          minWidth={190}
          compact
        />
        </div>
        <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => scrollRef.current?.scrollBy({ left: -PERIOD_COL_WIDTH, behavior: 'smooth' })} style={{ border: '1px solid var(--border)', background: 'var(--bg)', borderRadius: 9, padding: '9px 12px', cursor: 'pointer', fontWeight: 900 }}>← Column</button>
          <button type="button" onClick={() => scrollRef.current?.scrollBy({ left: PERIOD_COL_WIDTH, behavior: 'smooth' })} style={{ border: '1px solid var(--border)', background: 'var(--bg)', borderRadius: 9, padding: '9px 12px', cursor: 'pointer', fontWeight: 900 }}>Column →</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 800, whiteSpace: 'nowrap' }}>
          Showing <span style={{ color: 'var(--text)', fontWeight: 950 }}>{matrixRows.length}</span> of {rows.length} KPI rows
        </div>
      </div>
      <div ref={scrollRef} style={{ overflowX: 'auto', overflowY: 'visible', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'inset 0 1px 0 rgba(255,255,255,.45)' }}>
        <table style={{ width: tableWidth, minWidth: tableWidth, tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={{
                position: 'sticky', top: 0, left: 0, zIndex: 9,
                background: 'var(--bg2)', color: 'var(--text3)', textAlign: 'left',
                padding: '12px 14px', borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)',
                fontSize: 11, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em',
                minWidth: KPI_LABEL_COL_WIDTH, width: KPI_LABEL_COL_WIDTH,
                boxShadow: '8px 0 12px -12px rgba(0,0,0,.35)',
              }}>
                KPI
              </th>
              {periods.map((period, periodIndex) => {
                const meta = periodMeta(period, periodIndex);
                return (
                  <th
                    key={period.key}
                    style={{
                      position: 'sticky', top: 0, zIndex: 7,
                      background: periodIndex === 0 ? 'rgba(31,111,84,.08)' : 'var(--bg2)',
                      color: periodIndex === 0 ? 'var(--accent)' : 'var(--text)',
                      textAlign: 'right',
                      padding: '12px 12px',
                      borderBottom: '1px solid var(--border)',
                      borderRight: '1px solid var(--col-sep)',
                      minWidth: PERIOD_COL_WIDTH,
                      width: PERIOD_COL_WIDTH,
                      fontWeight: 900,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <div style={{ fontSize: 12.5 }}>{meta.label}</div>
                    <div style={{ marginTop: 3, fontSize: 10, color: 'var(--text4)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                      {meta.sub}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {matrixRows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(periods.length, 1) + 1}
                  style={{ padding: 18, color: 'var(--text3)', textAlign: 'center', borderBottom: '1px solid var(--row-sep)' }}
                >
                  No KPI rows match “{matrixSearch}”. Try owner, department, metric, brand, target, status, or a period value.
                </td>
              </tr>
            ) : matrixRows.map((row) => {
              const st = STATUS_META[row.status] || STATUS_META.gray;
              return (
                <tr key={`${row.brand}-${row.department}-${row.metric}`}>
                  <td style={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 4,
                    background: 'var(--bg2)',
                    padding: '15px 14px',
                    borderBottom: '1px solid var(--row-sep)',
                    borderRight: '1px solid var(--border)',
                    minWidth: KPI_LABEL_COL_WIDTH,
                    width: KPI_LABEL_COL_WIDTH,
                    verticalAlign: 'top',
                    boxShadow: '8px 0 12px -12px rgba(0,0,0,.35)',
                  }}>
                    <KpiRowLabel row={row} onSelect={onSelect} editMode={editMode} onEdit={onRowEdit} />
                  </td>
                  {periods.map((period, periodIndex) => (
                    <td
                      key={`${period.key}-${row.brand}-${row.metric}`}
                      onClick={() => onSelect?.(row)}
                      style={{
                        padding: '14px 12px',
                        borderBottom: '1px solid var(--row-sep)',
                        borderRight: '1px solid var(--col-sep)',
                        color: periodIndex === 0 ? 'var(--text)' : 'var(--text2)',
                        background: periodIndex === 0 ? 'rgba(31,111,84,.045)' : 'var(--bg2)',
                        fontWeight: periodIndex === 0 ? 900 : 650,
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                        minWidth: PERIOD_COL_WIDTH,
                        width: PERIOD_COL_WIDTH,
                        textAlign: 'right',
                        cursor: 'pointer',
                      }}
                    >
                      {editMode ? (
                        <EditableMiniField
                          value={row.values?.[periodIndex] || ''}
                          onSave={(v) => onCellEdit?.(row, period, v)}
                          style={{ textAlign: 'right', color: periodIndex === 0 ? st.color : 'var(--text)' }}
                        />
                      ) : (
                        <span style={{ color: periodIndex === 0 ? st.color : undefined }}>
                          {row.values?.[periodIndex] || '—'}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ChartPanel>
  );
}

function PriorityList({ rows, selected, onSelect }) {
  if (!rows.length) {
    return <div style={{ padding: 16, color: 'var(--text3)', fontSize: 12 }}>No priority KPIs in this filter.</div>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12 }}>
      {rows.map((row) => {
        const st = STATUS_META[row.status] || STATUS_META.gray;
        const brandColor = row.brand === 'NOBL' ? NOBL_ACCENT : FLO_ACCENT;
        const isSelected = selected?.brand === row.brand && selected?.metric === row.metric;
        return (
          <button
            type="button"
            key={`${row.brand}-${row.department}-${row.metric}`}
            onClick={() => onSelect(row)}
            style={{
              minWidth: 0,
              width: '100%',
              textAlign: 'left',
              border: `1px solid ${isSelected ? brandColor : 'var(--border)'}`,
              background: isSelected ? 'var(--accent-soft)' : 'var(--bg2)',
              borderRadius: 14,
              padding: '12px 13px',
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              gap: 12,
              alignItems: 'center',
              boxShadow: isSelected ? 'var(--shadow-sm)' : 'none',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: st.color, flexShrink: 0 }} />
                <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: '.08em', textTransform: 'uppercase', color: brandColor }}>{row.brand}</span>
                <span style={{ fontSize: 11, color: 'var(--text4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.department}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 900, color: 'var(--text)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.metric}
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Owner: {row.owner || '—'} · Target: {row.target || '—'}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 15, fontWeight: 950, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{row.latest}</div>
              <div style={{ marginTop: 4, fontSize: 11.5, fontWeight: 900, color: st.color }}>{row.variance || STATUS_META[row.status].label}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function HeroTrendCard({ selected, chartRows }) {
  if (!selected) {
    return (
      <div style={{ background: 'rgba(255,255,255,.72)', border: '1px solid var(--border)', borderRadius: 16, padding: 16, boxShadow: 'var(--shadow-sm)', minHeight: 190, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ fontSize: 11, fontWeight: 900, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Selected KPI trend</div>
        <div style={{ marginTop: 8, fontSize: 14, fontWeight: 900, color: 'var(--text)' }}>No KPI matches these filters</div>
        <div style={{ marginTop: 5, fontSize: 12, color: 'var(--text3)', lineHeight: 1.45 }}>Adjust Brand, Status, or View filters to restore trend data.</div>
      </div>
    );
  }
  const brandColor = selected.brand === 'NOBL' ? NOBL_ACCENT : FLO_ACCENT;
  return (
    <div style={{ background: 'rgba(255,255,255,.72)', border: '1px solid var(--border)', borderRadius: 16, padding: 16, boxShadow: 'var(--shadow-sm)', minHeight: 190 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 900, color: brandColor, textTransform: 'uppercase', letterSpacing: '.08em' }}>
            {selected.brand} · {selected.department}
          </div>
          <div style={{ marginTop: 6, fontSize: 15.5, fontWeight: 950, color: 'var(--text)', lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {selected.metric}
          </div>
        </div>
        <StatusPill status={selected.status} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 9, marginBottom: 10 }}>
        {[
          ['Latest', selected.latest, 'var(--text)'],
          ['Target', selected.target || '—', 'var(--text)'],
          ['Var', selected.variance || '—', STATUS_META[selected.status].color],
        ].map(([label, value, color]) => (
          <div key={label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, padding: '9px 10px' }}>
            <div style={{ fontSize: 9.5, color: 'var(--text3)', fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
            <div style={{ marginTop: 5, fontSize: 15, color, fontWeight: 950, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ height: 82 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartRows} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="period" hide />
            <YAxis hide domain={['dataMin', 'dataMax']} />
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [fmtTrendValue(v, selected), selected.metric]} />
            <Line type="monotone" dataKey="value" stroke={brandColor} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function HeroDepartmentHealth({ deptRows }) {
  const compactRows = [...deptRows]
    .sort((a, b) => (b.red + b.yellow) - (a.red + a.yellow) || b.total - a.total)
    .slice(0, 6);

  return (
    <div style={{ background: 'rgba(255,255,255,.72)', border: '1px solid var(--border)', borderRadius: 16, padding: 16, boxShadow: 'var(--shadow-sm)', minHeight: 190 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 900, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Department health</div>
          <div style={{ marginTop: 5, fontSize: 12.5, color: 'var(--text3)' }}>Attention-weighted department view</div>
        </div>
        <div style={{ fontSize: 22, fontWeight: 950, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{deptRows.length}</div>
      </div>
      <div style={{ height: 128 }}>
        {compactRows.length ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={compactRows} layout="vertical" margin={{ left: 68, right: 8, top: 2, bottom: 2 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" horizontal={false} />
              <XAxis type="number" hide allowDecimals={false} />
              <YAxis type="category" dataKey="department" width={68} tick={{ fontSize: 9.5, fill: 'var(--text2)' }} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="total" radius={[0, 6, 6, 0]}>
                {compactRows.map(d => <Cell key={d.department} fill={d.red ? 'var(--danger)' : d.yellow ? 'var(--warn)' : d.blue ? '#3b7ea1' : 'var(--success)'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 12, textAlign: 'center' }}>
            No departments match the current filters.
          </div>
        )}
      </div>
    </div>
  );
}

function MtdPreview({ rows, periods }) {
  const visibleDays = (periods || []).filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.key)).length;
  const rowsWithData = rows.filter(r => (r.values || []).some(v => v && v !== '—')).length;
  const needEyes = rows.filter(r => ['red', 'yellow'].includes(r.status)).length;
  const latestDate = periods?.[0]?.label || '—';
  const keyRows = rows.filter(r => ['NOBL Blended MER', 'Gross Sales − Discounts', 'Meta CVR %', 'Avg Shipping Cost / Order', 'CS Tickets % of Orders'].includes(r.baseMetric || r.metric)).slice(0, 6);
  return (
    <ChartPanel title="Month preview" subtitle={`Selected month through ${latestDate} · ${visibleDays} populated day${visibleDays === 1 ? '' : 's'}`} style={{ padding: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {[
          ['Rows with data', `${rowsWithData}/${rows.length}`, 'var(--text)'],
          ['Need attention', needEyes, needEyes ? 'var(--danger)' : 'var(--success)'],
          ['Latest day', latestDate, 'var(--accent)'],
        ].map(([label, value, color]) => (
          <div key={label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: '13px 14px' }}>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
            <div style={{ marginTop: 6, fontSize: 18, color, fontWeight: 950 }}>{value}</div>
          </div>
        ))}
      </div>
      {keyRows.length > 0 && (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
          {keyRows.map(row => (
            <div key={`${row.brand}-${row.metric}`} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '11px 12px', background: 'var(--bg2)' }}>
              <div style={{ fontSize: 10.5, color: row.brand === 'NOBL' ? NOBL_ACCENT : FLO_ACCENT, fontWeight: 950 }}>{row.brand} · {row.department}</div>
              <div style={{ marginTop: 5, fontSize: 12.5, fontWeight: 900, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.metric}</div>
              <div style={{ marginTop: 7, fontSize: 16, fontWeight: 950, color: 'var(--text)' }}>{row.latest}</div>
            </div>
          ))}
        </div>
      )}
    </ChartPanel>
  );
}

function ExecutiveSnapshot({ rows }) {
  const scoredRows = rows
    .map(row => ({ ...row, varianceScore: parseNum(row.variance) }))
    .filter(row => row.varianceScore != null);
  const biggestMiss = [...scoredRows].sort((a, b) => a.varianceScore - b.varianceScore)[0];
  const strongestWin = [...scoredRows].sort((a, b) => b.varianceScore - a.varianceScore)[0];
  const attentionCount = rows.filter(row => ['red', 'yellow'].includes(row.status)).length;
  const healthyCount = rows.filter(row => ['blue', 'green'].includes(row.status)).length;
  const healthRate = rows.length ? Math.round((healthyCount / rows.length) * 100) : 0;

  return (
    <div style={{ background: 'rgba(255,255,255,.72)', border: '1px solid var(--border)', borderRadius: 16, padding: 16, boxShadow: 'var(--shadow-sm)', minHeight: 190 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 900, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Executive snapshot</div>
          <div style={{ marginTop: 5, fontSize: 12.5, color: 'var(--text3)' }}>What leadership should look at first</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 28, fontWeight: 950, color: healthRate >= 70 ? 'var(--success)' : attentionCount ? 'var(--warn)' : 'var(--text)' }}>{healthRate}%</div>
          <div style={{ marginTop: -2, fontSize: 10, color: 'var(--text3)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>healthy</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 9, marginBottom: 12 }}>
        {[
          ['Total KPIs', rows.length, 'var(--text)'],
          ['Need eyes', attentionCount, attentionCount ? 'var(--danger)' : 'var(--success)'],
          ['On/Ahead', healthyCount, 'var(--success)'],
        ].map(([label, value, color]) => (
          <div key={label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, padding: '10px 11px' }}>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
            <div style={{ marginTop: 5, fontSize: 18, color, fontWeight: 950, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ borderLeft: '3px solid var(--danger)', paddingLeft: 10, minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em' }}>Biggest miss</div>
          <div style={{ marginTop: 5, fontSize: 13.5, color: 'var(--text)', fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{biggestMiss?.metric || 'No scored miss'}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--danger)', fontWeight: 900 }}>{biggestMiss?.variance || '—'} <span style={{ color: 'var(--text3)', fontWeight: 700 }}>{biggestMiss?.owner ? `· ${biggestMiss.owner}` : ''}</span></div>
        </div>
        <div style={{ borderLeft: '3px solid var(--success)', paddingLeft: 10, minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em' }}>Strongest win</div>
          <div style={{ marginTop: 5, fontSize: 13.5, color: 'var(--text)', fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{strongestWin?.metric || 'No scored win'}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--success)', fontWeight: 900 }}>{strongestWin?.variance || '—'} <span style={{ color: 'var(--text3)', fontWeight: 700 }}>{strongestWin?.owner ? `· ${strongestWin.owner}` : ''}</span></div>
        </div>
      </div>
    </div>
  );
}

export default function KpiPulsePage() {
  const [cadence, setCadence] = useState('daily');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [brands, setBrands] = useState(['ALL']);
  const [statuses, setStatuses] = useState(['ALL']);
  const [category, setCategory] = useState('ALL');
  const [editMode, setEditMode] = useState(false);
  const [localOverrides, setLocalOverrides] = useState({});
  const [selectedMetric, setSelectedMetric] = useState(null);
  const [pulse, setPulse] = useState(null);

  useEffect(() => {
    let alive = true;
    const cached = readKpiPulseLocalCache(selectedMonth);
    if (cached) {
      setPulse(cached);
      setLocalOverrides(cached?.overrides || {});
    } else {
      setPulse(null);
      setLocalOverrides({});
    }
    getKpiPulse({ month: selectedMonth })
      .then((d) => {
        if (!alive) return;
        if (hasUsableKpiPulseData(d)) {
          setPulse(d);
          setLocalOverrides(d?.overrides || {});
          writeKpiPulseLocalCache(selectedMonth, d);
        } else {
          setPulse(prev => prev || null);
        }
      })
      .catch(() => {
        if (alive && !cached) setPulse(null);
      });
    return () => { alive = false; };
  }, [selectedMonth]);

  const cadenceData = pulse?.cadences?.[cadence] || null;
  const periods = useMemo(() => cadenceData?.periods || [], [cadenceData]);

  const normalizedBrands = useMemo(() => normalizeKpiBrands(brands), [brands]);
  const normalizedStatuses = useMemo(() => normalizeKpiStatuses(statuses), [statuses]);
  const monthOptions = useMemo(() => (pulse?.availableMonths || []).map(m => ({ value: m, label: monthLabel(m) })), [pulse]);
  const activeMonth = selectedMonth || pulse?.selectedMonth || monthOptions[0]?.value || '';
  const brandFilterSet = useMemo(() => new Set(normalizedBrands), [normalizedBrands]);
  const statusFilterSet = useMemo(() => new Set(normalizedStatuses.map(s => s.toLowerCase())), [normalizedStatuses]);

  const rows = useMemo(() => {
    const series = cadenceData?.series;
    const len = periods.length;
    const built = KPI_ROWS.filter(r => r.cadence === cadence).map(r => {
      const key = dbKeyFor(r.brand, r.metric);
      const raw = key ? series?.[r.brand]?.[key] : null;
      let values; let latest; let variance; let dbBacked = false;
      if (Array.isArray(raw)) {
        const hasAnySourceValue = raw.some(v => v != null && v !== '' && Number.isFinite(Number(v)) || (typeof v === 'string' && v.trim() !== ''));
        if (!hasAnySourceValue) return null;
        dbBacked = true;
        values = raw.map(v => fmtMetricValue(key, v) ?? '—');
        const firstNonNull = raw.find(v => v != null);
        latest = firstNonNull != null ? fmtMetricValue(key, firstNonNull) : '—';
        variance = firstNonNull != null ? varianceFor(key, firstNonNull, r.target) : '';
      } else {
        return null;
      }
      const status = dbBacked && variance ? statusFor({ variance }) : 'gray';
      const base = { ...r, id: `${r.cadence}:${r.brand}:${r.metric}`, baseMetric: r.metric, category: categoryFor(r), values, latest, variance, status, dbBacked };
      return applyOverrides(base, periods, localOverrides);
    }).filter(Boolean);
    return built
      .filter(r => normalizedBrands.includes('ALL') || brandFilterSet.has(r.brand))
      .filter(r => category === 'ALL' || r.category === category)
      .filter(r => normalizedStatuses.includes('ALL') || statusFilterSet.has(r.status));
  }, [cadence, cadenceData, periods, localOverrides, category, normalizedBrands, normalizedStatuses, brandFilterSet, statusFilterSet]);

  const saveOverride = async (key, payload) => {
    const merged = { ...(localOverrides[key] || {}), ...(payload || {}) };
    setLocalOverrides(prev => ({ ...prev, [key]: merged }));
    try { await saveKpiPulseOverride(key, merged); } catch (e) { console.warn('[KPI override]', e.message); }
  };
  const handleRowEdit = (row, patch) => saveOverride(rowOverrideKey(row), patch);
  const handleCellEdit = (row, period, value) => saveOverride(cellOverrideKey(row, period), { value });

  const selected = selectedMetric && rows.find(r => r.metric === selectedMetric.metric && r.brand === selectedMetric.brand && r.department === selectedMetric.department)
    ? rows.find(r => r.metric === selectedMetric.metric && r.brand === selectedMetric.brand && r.department === selectedMetric.department)
    : rows[0];

  const filterSummary = [
    KPI_CADENCE_OPTIONS.find(o => o.value === cadence)?.label || 'Daily',
    ['daily', 'weekly'].includes(cadence) && activeMonth && monthLabel(activeMonth),
    !normalizedBrands.includes('ALL') && multiFilterLabel(normalizedBrands, KPI_BRAND_OPTIONS),
    category !== 'ALL' && KPI_CATEGORY_OPTIONS.find(o => o.value === category)?.label,
    !normalizedStatuses.includes('ALL') && multiFilterLabel(normalizedStatuses, KPI_STATUS_OPTIONS),
  ].filter(Boolean).join(' · ');

  const attention = rows.filter(r => ['red', 'yellow'].includes(r.status));
  const priorityRows = [
    ...rows.filter(r => ['red', 'yellow'].includes(r.status)),
    ...rows.filter(r => ['blue', 'green'].includes(r.status)),
    ...rows.filter(r => r.status === 'gray'),
  ].slice(0, 10);
  const chartRows = selected ? seriesFor(selected, periods) : [];
  const deptRows = Object.entries(rows.reduce((acc, r) => {
    acc[r.department] = acc[r.department] || { department: r.department, total: 0, red: 0, yellow: 0, green: 0, blue: 0, gray: 0 };
    acc[r.department].total += 1;
    acc[r.department][r.status] += 1;
    return acc;
  }, {})).map(([, v]) => v);

  return (
    <div className="page-stack" style={{ gap: 14, minHeight: 0 }}>
      <PageIntro>
        <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ color: 'var(--text3)', fontSize: 12, lineHeight: 1.45, flex: '1 1 420px' }}>
            Leadership KPI matrix across NOBL and FLO. Only source-backed KPIs with at least one value in the selected
            cadence/month are shown; rows without a connected API/database source, or rows that are completely blank,
            are removed automatically.
          </div>
          {pulse?.asOf && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text2)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} />
              Data through {pulse.asOf}
            </span>
          )}
        </div>
      </PageIntro>

      <div className="global-filter-bar" style={{ marginBottom: 0, padding: '12px 16px 13px' }}>
        <div className="global-filter-bar__head" style={{ marginBottom: 10, paddingBottom: 10 }}>
          <span className="global-filter-bar__lead">Filters</span>
          <span className="global-filter-bar__active-inline">
            {filterSummary || 'All KPI data'}
          </span>
        </div>
        <div className="global-filter-bar__inner">
          <SingleFilterSelect
            label="View"
            value={cadence}
            onChange={setCadence}
            options={KPI_CADENCE_OPTIONS}
            minWidth={150}
            compact
          />

          {['daily', 'weekly'].includes(cadence) && monthOptions.length > 0 && (
            <SingleFilterSelect
              label="Month"
              value={activeMonth}
              onChange={setSelectedMonth}
              options={monthOptions}
              minWidth={150}
              compact
            />
          )}

          <FilterMultiSelect
            label="Brand"
            value={brands}
            onChange={setBrands}
            options={KPI_BRAND_OPTIONS}
            normalize={normalizeKpiBrands}
            minWidth={150}
            compact
          />

          <SingleFilterSelect
            label="KPI group"
            value={category}
            onChange={setCategory}
            options={KPI_CATEGORY_OPTIONS}
            minWidth={230}
            compact
          />

          <FilterMultiSelect
            label="Status"
            value={statuses}
            onChange={setStatuses}
            options={KPI_STATUS_OPTIONS}
            normalize={normalizeKpiStatuses}
            minWidth={170}
            compact
          />

          <button
            type="button"
            onClick={() => setEditMode(v => !v)}
            style={{ border: `1px solid ${editMode ? 'var(--accent)' : 'var(--border)'}`, background: editMode ? 'var(--accent-dim)' : 'var(--bg2)', color: editMode ? 'var(--accent)' : 'var(--text2)', borderRadius: 10, padding: '9px 12px', fontWeight: 900, cursor: 'pointer' }}
            title="Edit labels, owners, targets, and visible cells for everyone"
          >
            {editMode ? 'Editing on' : 'Edit matrix'}
          </button>
        </div>
      </div>

      {cadence === 'daily' && <MtdPreview rows={rows} periods={periods} />}

      <div style={{
        position: 'relative', overflow: 'hidden', borderRadius: 20, padding: 16,
        background: 'linear-gradient(135deg, rgba(31,111,84,.13), rgba(196,91,124,.08) 48%, rgba(176,125,24,.10))',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ position: 'absolute', right: -70, top: -90, width: 240, height: 240, borderRadius: '50%', background: 'rgba(31,111,84,.10)' }} />
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 14, alignItems: 'stretch' }}>
            <ExecutiveSnapshot rows={rows} />
            <HeroTrendCard selected={selected} chartRows={chartRows} />
            <HeroDepartmentHealth deptRows={deptRows} />
          </div>
        </div>
      </div>

      <ChartPanel
        title="Priority KPIs"
        subtitle={attention.length ? `${attention.length} need attention in current filter` : 'Showing key rows from this view'}
        style={{ padding: 18 }}
      >
        <PriorityList rows={priorityRows} selected={selected} onSelect={setSelectedMetric} />
      </ChartPanel>

      <RawKpiTable
        rows={rows}
        cadence={cadence}
        periods={periods}
        onSelect={setSelectedMetric}
        editMode={editMode}
        onRowEdit={handleRowEdit}
        onCellEdit={handleCellEdit}
      />
    </div>
  );
}
