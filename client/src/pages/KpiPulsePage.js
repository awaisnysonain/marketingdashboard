import React, { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts';
import ChartPanel from '../components/ChartPanel';
import FilterMultiSelect from '../components/FilterMultiSelect';
import PageIntro from '../components/PageIntro';
import { fmtNum, getKpiPulse } from '../utils/api';
import { NOBL_ACCENT, FLO_ACCENT, TOOLTIP_STYLE } from '../utils/chartHelpers';
import { multiFilterLabel, normalizeMultiFilter } from '../constants/dashboardFilters';

const STATUS_META = {
  blue:   { label: 'Ahead',      color: '#3b7ea1', bg: 'rgba(59,126,161,.12)', border: 'rgba(59,126,161,.28)' },
  green:  { label: 'On track',   color: 'var(--success)', bg: 'var(--success-dim)', border: 'rgba(31,122,82,.28)' },
  yellow: { label: 'Watch',      color: 'var(--warn)', bg: 'var(--warn-dim)', border: 'rgba(176,125,24,.30)' },
  red:    { label: 'Needs help', color: 'var(--danger)', bg: 'var(--danger-dim)', border: 'rgba(178,59,47,.30)' },
  gray:   { label: 'No target',  color: 'var(--text3)', bg: 'var(--bg3)', border: 'var(--border)' },
};

/* ── Database-backed metrics ──────────────────────────────────────────
   Maps a KPI catalog metric name → the key returned by /api/analytics/kpi-pulse.
   Metrics NOT in this map have no database source and are shown BLANK.        */
const DB_KEY = {
  'NOBL Blended MER': 'mer',
  'Gross Sales − Discounts': 'sales',
  'AOV': 'aov',
  'Amazon Rev % of Gross Sales': 'amazon_pct',
  'US MER': 'us_mer',
  'Canada MER': 'ca_mer',
  'NOBL Air Rev % of Sales': 'air_rev_pct',
  'Attach Rate': 'attach',
  'Activation Rate': 'activation',
  'Trial-to-Paid': 'ttp',
};
const PCT_KEYS = new Set(['amazon_pct', 'air_rev_pct', 'attach', 'activation', 'ttp']);
const RATIO_KEYS = new Set(['mer', 'us_mer', 'ca_mer']);
const MONEY_KEYS = new Set(['sales', 'aov']);
// These DB metrics only exist for NOBL (Air, Amazon, Canada geo, AOV, blended MER catalog row).
const NOBL_ONLY_KEYS = new Set(['mer', 'aov', 'amazon_pct', 'ca_mer', 'air_rev_pct', 'attach', 'activation', 'ttp']);

function dbKeyFor(brand, metric) {
  const k = DB_KEY[metric];
  if (!k) return null;
  if (brand !== 'NOBL' && NOBL_ONLY_KEYS.has(k)) return null;
  return k;
}

function fmtMetricValue(key, v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  if (RATIO_KEYS.has(key)) return `${n.toFixed(2)}x`;
  if (PCT_KEYS.has(key)) return `${(n * 100).toFixed(2)}%`;
  if (MONEY_KEYS.has(key)) return `$${Math.round(n).toLocaleString()}`;
  return String(v);
}

function parseTarget(t) {
  if (t == null) return null;
  const cleaned = String(t).replace(/[≥≤→~xX$,%\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function varianceFor(key, rawLatest, target) {
  const tgt = parseTarget(target);
  if (tgt == null || tgt === 0 || rawLatest == null) return '';
  const scaled = PCT_KEYS.has(key) ? rawLatest * 100 : rawLatest;
  const pct = ((scaled - tgt) / Math.abs(tgt)) * 100;
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

const KPI_BRAND_ALLOWED = new Set(['NOBL', 'FLO']);
const KPI_STATUS_ALLOWED = new Set(['RED', 'YELLOW', 'GREEN', 'BLUE', 'GRAY']);

const normalizeKpiBrands = (next) => normalizeMultiFilter(next, KPI_BRAND_ALLOWED, ['NOBL', 'FLO']);
const normalizeKpiStatuses = (next) => normalizeMultiFilter(next, KPI_STATUS_ALLOWED, ['RED', 'YELLOW', 'GREEN', 'BLUE', 'GRAY']);

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

const KPI_ROWS = [
  // DAILY — NOBL
  { cadence: 'daily', brand: 'NOBL', department: 'Paid Media', owner: 'Brad', metric: 'NOBL Blended MER', target: '3.0x', variance: '-24.2%', latest: '2.27x', values: ['2.27', '2.33', '2.24', '2.26', '2.41', '2.42', '2.13'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Paid Media', owner: 'Brad', metric: 'Gross Sales − Discounts', target: 'On plan', variance: '', latest: '$706k', values: ['$706,470', '$722,337', '$705,161', '$783,733', '$758,343', '$620,142', '$572,233'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Paid Media', owner: 'Brad', metric: 'Amazon Rev % of Gross Sales', target: '1.50%', variance: '-4.0%', latest: '1.44%', values: ['1.44%', '2.03%', '1.72%', '1.73%', '1.70%', '2.06%', '1.61%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Paid Media', owner: 'Brad', metric: 'Meta CVR %', target: '0.59%', variance: '11.9%', latest: '0.66%', values: ['0.66%', '0.57%', '0.71%', '0.94%', '0.55%', '0.51%', '0.56%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Paid Media', owner: 'Anthony', metric: 'Whitelisting Spend % of Meta Spend', target: '50%', variance: '-39.4%', latest: '30.30%', values: ['30.30%', '38.99%', '27.13%', '28.02%', '31.05%', '22.04%', '14.74%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Geo', owner: 'Brad', metric: 'US MER', target: '3.35x', variance: '-21.8%', latest: '2.62x', values: ['2.62', '2.61', '2.92', '3.15', '3.10', '3.32', '3.58'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Geo', owner: 'Brad', metric: 'Canada MER', target: '2.44x', variance: '-22.5%', latest: '1.89x', values: ['1.89', '2.09', '1.66', '1.63', '1.94', '1.89', '2.20'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Bundles Pod', owner: 'Alex', metric: 'Bundle % of NOBL Revenue', target: '55%', variance: '15.6%', latest: '63.55%', values: ['63.55%', '61.08%', '61.48%', '60.26%', '57.71%', '54.48%', '53.05%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Bundles Pod', owner: 'Alex', metric: 'AOV', target: '$553', variance: '-34.8%', latest: '$360.35', values: ['$360.35', '$359.32', '$346.19', '$359.34', '$326.93', '$322.86', '$319.48'] },
  { cadence: 'daily', brand: 'NOBL', department: 'CRO / Site', owner: 'Alex', metric: 'Site Conversion Rate', target: '1.20%', variance: '-43.3%', latest: '0.68%', values: ['0.68%', '0.61%', '0.73%', '0.75%', '0.62%', '0.48%', '1.00%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'NOBL Air Pod', owner: 'Simon', metric: 'NOBL Air Rev % of Sales', target: '5%', variance: '57.4%', latest: '7.87%', values: ['7.87%', '6.58%', '8.73%', '8.63%', '14.01%', '14.33%', '13.68%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'NOBL Air Pod', owner: 'Simon', metric: 'Activation Rate', target: '12%', variance: '33.3%', latest: '16.0%', values: ['16.0%', '17.5%', '18.0%', '19.8%', '18.5%', '17.0%', '16.0%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'NOBL Air Pod', owner: 'Simon', metric: 'Attach Rate', target: '20%', variance: '1.8%', latest: '20.35%', values: ['20.35%', '22.56%', '20.95%', '23.34%', '22.13%', '20.64%', '21.98%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'NOBL Air Pod', owner: 'Simon', metric: 'Trial-to-Paid', target: '≥70%', variance: '', latest: '78.61%', values: ['78.61%', '77.33%', '85.90%', '84.67%', '83.64%', '82.51%', '72.83%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Creative', owner: 'Luke', metric: 'TOF vs BOF Spend Split', target: 'Track', variance: '', latest: '95% / 5%', values: ['95%/5%', '94%/6%', '93%/7%', '95%/5%', '95%/5%', '94%/6%', '93%/7%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Retention', owner: 'Daniel', metric: 'Retention Rev %', target: '30%', variance: '-26.5%', latest: '22.04%', values: ['22.0%', '20.7%', '22.7%', '23.7%', '23.3%', '19.6%', '19.2%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Retention', owner: 'Daniel', metric: 'SMS % of Sales', target: '10%', variance: '-64.2%', latest: '3.58%', values: ['3.58%', '3.53%', '6.77%', '6.90%', '6.73%', '4.74%', '2.19%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Ops', owner: 'Shumail', metric: 'Orders Partially Unfulfilled', target: '<4000', variance: '', latest: '6,019', values: ['6,019', '7,302', '8,388', '9,512', '9,574', '9,068', '9,750'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Ops', owner: 'Shumail', metric: 'Avg Shipping Cost / Order', target: '$20', variance: '-43.2%', latest: '$28.64', values: ['$28.64', '$24.95', '$23.50', '$21.86', '$24.53', '$24.76', '$24.86'] },
  { cadence: 'daily', brand: 'NOBL', department: 'CS', owner: 'Hassan', metric: 'CS Tickets % of Orders', target: '<2%', variance: '', latest: '45.48%', values: ['45.48%', '57.61%', '52.59%', '36.18%', '43.66%', '48.12%', '55.17%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'CS', owner: 'Hassan', metric: 'Chargeback Rate', target: '<1%', variance: '', latest: '1.88%', values: ['1.88%', '0.67%', '0.60%', '0.38%', '0.89%', '1.12%', '0.91%'] },
  { cadence: 'daily', brand: 'NOBL', department: 'Web Eng', owner: 'Sobayyal', metric: 'PageSpeed PDP AIO Avg', target: '70', variance: '-52.9%', latest: '33', values: ['33', '28', '53', '37', '33', '52', '51'] },

  // DAILY — FLO
  { cadence: 'daily', brand: 'FLO', department: 'Paid Media', owner: 'Brad', metric: 'Portable Reformer CAC', target: '$125', variance: '-23.6%', latest: '$154.52', values: ['$154.52', '$169.72', '$118.14', '$124.31', '$141.23', '$98.61', '$125.92'] },
  { cadence: 'daily', brand: 'FLO', department: 'Paid Media', owner: 'Brad', metric: 'Home + Studio Blended CAC', target: '$1,047', variance: '86.4%', latest: '$1,951.52', values: ['$1,951.52', '$972.56', '$1,315.81', '$822.42', '$756.20', '$747.02', '$995.02'] },
  { cadence: 'daily', brand: 'FLO', department: 'Paid Media', owner: 'Brad', metric: 'Gross Sales − Discounts', target: 'On plan', variance: '', latest: '$334k', values: ['$334,382', '$364,301', '$379,769', '$406,693', '$474,930', '$397,913', '$330,847'] },
  { cadence: 'daily', brand: 'FLO', department: 'Paid Media', owner: 'Brad', metric: 'Meta CVR %', target: '0.93%', variance: '-22.6%', latest: '0.72%', values: ['0.72%', '0.51%', '0.97%', '1.01%', '0.84%', '1.23%', '0.81%'] },
  { cadence: 'daily', brand: 'FLO', department: 'Geo', owner: 'Brad', metric: 'US MER', target: '1.82x', variance: '-11.5%', latest: '1.61x', values: ['1.61', '1.52', '1.59', '1.68', '1.80', '1.65', '1.57'] },
  { cadence: 'daily', brand: 'FLO', department: 'FLO App', owner: 'Kolachi', metric: 'App Attach %', target: '→70%', variance: '', latest: '14.50%', values: ['14.50%', '23.39%', '28.71%', '25.71%', '20.07%', '30.61%', '33.32%'] },
  { cadence: 'daily', brand: 'FLO', department: 'FLO App', owner: 'Kolachi', metric: 'Trial-to-Paid %', target: '≥60%', variance: '', latest: '85.45%', values: ['85.45%', '85.69%', '84.37%', '85.94%', '75.81%', '86.20%', '70.77%'] },
  { cadence: 'daily', brand: 'FLO', department: 'FLO App', owner: 'Kolachi', metric: 'Monthly Churn Rate', target: '<8%', variance: '', latest: '5.48%', values: ['5.48%', '2.43%', '12.79%', '10.31%', '7.15%', '3.32%', '0.82%'] },
  { cadence: 'daily', brand: 'FLO', department: 'CRO / Site', owner: 'Alex', metric: 'Site Conversion Rate', target: 'Set baseline', variance: '', latest: '0.66%', values: ['0.66%', '0.61%', '0.86%', '0.81%', '0.54%', '0.74%', '0.81%'] },
  { cadence: 'daily', brand: 'FLO', department: 'Creative', owner: 'Luke', metric: 'TOF vs BOF Spend Split', target: 'Track', variance: '', latest: '93% / 7%', values: ['93%/7%', '94%/6%', '95%/5%', '95%/5%', '94%/6%', '96%/4%', '95%/5%'] },
  { cadence: 'daily', brand: 'FLO', department: 'Retention', owner: 'Daniel', metric: 'Retention Rev %', target: '≥30%', variance: '', latest: '8.64%', values: ['8.64%', '9.84%', '12.00%', '8.81%', '8.71%', '15.58%', '15.64%'] },
  { cadence: 'daily', brand: 'FLO', department: 'Social', owner: 'Fatima', metric: 'Instagram Engagement Rate', target: '<2%', variance: '', latest: '2.14%', values: ['2.14%', '2.04%', '2.11%', '1.62%', '2.48%', '1.48%', '1.79%'] },
  { cadence: 'daily', brand: 'FLO', department: 'Ops', owner: 'Shumail', metric: 'Orders Unfulfilled >24hrs', target: '0', variance: '', latest: '638', values: ['638', '600', '753', '519', '568', '1,030', '508'] },
  { cadence: 'daily', brand: 'FLO', department: 'CS', owner: 'Hassan', metric: 'CS Tickets % of Orders', target: '<2%', variance: '', latest: '16.50%', values: ['16.50%', '17.60%', '16.21%', '13.60%', '14.20%', '16.84%', '20.88%'] },
  { cadence: 'daily', brand: 'FLO', department: 'App', owner: 'Ali Hashim', metric: 'DAU / MAU Stickiness', target: '15%', variance: '-85.5%', latest: '2.21%', values: ['2.21%', '2.72%', '2.59%', '2.21%', '1.62%', '1.31%', '1.68%'] },

  // WEEKLY — sample mirrors sheet sections more broadly
  { cadence: 'weekly', brand: 'NOBL', department: 'Paid Media', owner: 'Brad', metric: 'NOBL Blended MER', target: '3.2x', variance: '', latest: '2.31x', values: ['2.31', '2.35', '2.70', '2.87', '2.90', '3.12', '3.12'] },
  { cadence: 'weekly', brand: 'NOBL', department: 'Paid Media', owner: 'Simon', metric: 'NOBL Air Rev % of Sales', target: '5%', variance: '110.0%', latest: '10.50%', values: ['10.50%', '5.84%', '3.84%', '8.01%', '15.24%', '5.91%', '6.90%'] },
  { cadence: 'weekly', brand: 'NOBL', department: 'Paid Media', owner: 'Brad', metric: 'Blended nCPA', target: '$197', variance: '-42.3%', latest: '$280.30', values: ['$280.30', '$261.78', '$229.69', '$232.49', '$245.89', '$212.83', '$201.50'] },
  { cadence: 'weekly', brand: 'NOBL', department: 'Bundles Pod', owner: 'Alex', metric: 'Bundle % of NOBL Revenue', target: '65%', variance: '-10.8%', latest: '57.97%', values: ['57.97%', '61.01%', '66.28%', '60.88%', '54.25%', '62.61%', '62.24%'] },
  { cadence: 'weekly', brand: 'NOBL', department: 'NOBL Air Pod', owner: 'Simon', metric: 'Activation Rate', target: '12%', variance: '', latest: '31.36%', values: ['31.36%', '14.31%', '16.37%', '19.05%', '20.57%', '16.36%', '21.40%'] },
  { cadence: 'weekly', brand: 'NOBL', department: 'NOBL Air Pod', owner: 'Simon', metric: 'Net Subscriber Adds', target: 'Set target', variance: '', latest: '-1,300', values: ['-1,300', '-698', '-762', '-857', '-743', '-424', '1,699'] },
  { cadence: 'weekly', brand: 'NOBL', department: 'Creative', owner: 'Luke', metric: 'Share of Spend TOF — Taylor', target: '33%', variance: '92.9%', latest: '63.65%', values: ['63.65%', '64.02%', '63.13%', '64.41%', '51.12%', '48.91%', '48.47%'] },
  { cadence: 'weekly', brand: 'NOBL', department: 'Retention', owner: 'Daniel', metric: 'Email Flow vs Campaign Split', target: '≥60% flows', variance: '', latest: '56.8% / 43.2%', values: ['56.8% / 43.2%', '58.8% / 41.2%', '64.4% / 35.6%', '57.7% / 42.3%', '63.3% / 36.7%', '62.3% / 37.7%', '54.6% / 45.4%'] },
  { cadence: 'weekly', brand: 'NOBL', department: 'Social', owner: 'Fatima', metric: 'Instagram Total Posts', target: '77', variance: '', latest: '65', values: ['65', '69', '70', '76', '73', '54', '52'] },
  { cadence: 'weekly', brand: 'NOBL', department: 'Ops', owner: 'Shumail', metric: 'Unfulfilled Orders', target: '<4000', variance: '', latest: '9,512', values: ['9512', '14678', '14296', '8993', '8157', '15520', '19410'] },
  { cadence: 'weekly', brand: 'NOBL', department: 'CS', owner: 'Hassan', metric: 'CS Tickets % of Orders', target: '<2%', variance: '', latest: '45.48%', values: ['45.48%', '57.61%', '52.59%', '36.18%', '43.66%', '48.12%', '55.17%'] },
  { cadence: 'weekly', brand: 'FLO', department: 'Paid Media', owner: 'Brad', metric: 'Portable Reformer CAC', target: '$125', variance: '-23.6%', latest: '$154.52', values: ['$154.52', '$169.72', '$118.14', '$124.31', '$139.73', '$104.19', '$122.13'] },
  { cadence: 'weekly', brand: 'FLO', department: 'Paid Media', owner: 'Brad', metric: 'Home + Studio Blended CAC', target: '$1,047', variance: '86.4%', latest: '$1,951.52', values: ['$1951.52', '$972.56', '$1315.81', '$822.42', '$756.20', '$747.02', '$995.02'] },
  { cadence: 'weekly', brand: 'FLO', department: 'FLO App', owner: 'Kolachi', metric: 'App Attach %', target: '→70%', variance: '', latest: '14.50%', values: ['14.50%', '23.39%', '28.71%', '25.71%', '20.07%', '30.61%', '33.32%'] },
  { cadence: 'weekly', brand: 'FLO', department: 'FLO App', owner: 'Kolachi', metric: 'Trial-to-Paid %', target: '≥60%', variance: '', latest: '85.45%', values: ['85.45%', '85.69%', '84.37%', '85.94%', '75.81%', '86.20%', '70.77%'] },
  { cadence: 'weekly', brand: 'FLO', department: 'CRO / Site', owner: 'Alex', metric: 'Site Conversion Rate', target: 'Set baseline', variance: '', latest: '0.66%', values: ['0.66%', '0.61%', '0.86%', '0.81%', '0.54%', '0.74%', '0.81%'] },
  { cadence: 'weekly', brand: 'FLO', department: 'Creative', owner: 'Luke', metric: 'Portable Ad CAC — Chris', target: '$94', variance: '219.4%', latest: '$300.28', values: ['$300.28', '$241.84', '$173.61', '$191.97', '$219.06', '$161.94', '$142.78'] },
  { cadence: 'weekly', brand: 'FLO', department: 'Retention', owner: 'Daniel', metric: 'Unsubscribe Rate', target: '<0.3%', variance: '', latest: '3.04%', values: ['3.04%', '2.43%', '2.32%', '3.21%', '3.88%', '2.53%', '3.64%'] },
  { cadence: 'weekly', brand: 'FLO', department: 'Social', owner: 'Fatima', metric: 'TikTok Total Posts', target: '21', variance: '', latest: '15', values: ['15', '18', '21', '21', '16', '12', '12'] },
  { cadence: 'weekly', brand: 'FLO', department: 'Ops', owner: 'Shumail', metric: 'Orders Unfulfilled >24hrs', target: '0', variance: '', latest: '638', values: ['638', '600', '753', '519', '568', '1,030', '508'] },
  { cadence: 'weekly', brand: 'FLO', department: 'CS', owner: 'Hassan', metric: 'CS Tickets as % of Orders', target: '<2%', variance: '', latest: '19.42%', values: ['19.42%', '23.78%', '24.4%', '27.19%', '21.19%', '21.83%', '21.87%'] },

  // QUARTERLY / QTD — NOBL + FLO
  { cadence: 'quarterly', brand: 'NOBL', department: 'Paid Media', owner: 'Brad', metric: 'NOBL Blended MER', target: '3.2x', variance: '', latest: '2.83x', values: ['2.75', '2.83'] },
  { cadence: 'quarterly', brand: 'NOBL', department: 'Paid Media', owner: 'Brad', metric: 'Gross Sales − Discounts', target: 'On plan', variance: '', latest: '$51.4M', values: ['$53,314,778', '$51,379,678'] },
  { cadence: 'quarterly', brand: 'NOBL', department: 'Paid Media', owner: 'Simon', metric: 'NOBL Air Rev % of Sales', target: '5%', variance: '110.0%', latest: '6.27%', values: ['0.38%', '6.27%'] },
  { cadence: 'quarterly', brand: 'NOBL', department: 'Bundles Pod', owner: 'Alex', metric: 'Bundle % of NOBL Revenue', target: '65%', variance: '-10.8%', latest: '60.68%', values: ['49.81%', '60.68%'] },
  { cadence: 'quarterly', brand: 'NOBL', department: 'CRO / Site', owner: 'Alex', metric: 'Site Conversion Rate', target: '1.20%', variance: '-43.3%', latest: '0.79%', values: ['0.96%', '0.79%'] },
  { cadence: 'quarterly', brand: 'NOBL', department: 'NOBL Air Pod', owner: 'Simon', metric: 'Activation Rate', target: '12%', variance: '', latest: '16.42%', values: ['1.29%', '16.42%'] },
  { cadence: 'quarterly', brand: 'NOBL', department: 'NOBL Air Pod', owner: 'Simon', metric: 'Trial-to-Paid', target: '≥70%', variance: '', latest: '76.61%', values: ['11.48%', '76.61%'] },
  { cadence: 'quarterly', brand: 'NOBL', department: 'Creative', owner: 'Luke', metric: 'TOF vs BOF Spend Split', target: 'Track', variance: '', latest: '92.5% / 7.5%', values: ['91.4% / 8.6%', '92.5% / 7.5%'] },
  { cadence: 'quarterly', brand: 'NOBL', department: 'Retention', owner: 'Daniel', metric: 'Retention Rev %', target: '≥30%', variance: '', latest: '23.87%', values: ['26.19%', '23.87%'] },
  { cadence: 'quarterly', brand: 'NOBL', department: 'Ops', owner: 'Shumail', metric: 'Unfulfilled Orders', target: '<4000', variance: '', latest: '7,303', values: ['9,769', '7,303'] },
  { cadence: 'quarterly', brand: 'NOBL', department: 'CS', owner: 'Hassan', metric: 'CS Tickets % of Orders', target: '<2%', variance: '', latest: '58.22%', values: ['43.30%', '58.22%'] },
  { cadence: 'quarterly', brand: 'FLO', department: 'Paid Media', owner: 'Brad', metric: 'Gross Sales − Discounts', target: 'On plan', variance: '', latest: '$4.29M', values: ['$6,085,888', '$4,291,728'] },
  { cadence: 'quarterly', brand: 'FLO', department: 'Paid Media', owner: 'Brad', metric: 'Portable Reformer CAC', target: '$125', variance: '-23.6%', latest: '$132.21', values: ['$121.84', '$132.21'] },
  { cadence: 'quarterly', brand: 'FLO', department: 'FLO App', owner: 'Kolachi', metric: 'App Attach %', target: '→70%', variance: '', latest: '25.25%', values: ['29.26%', '25.25%'] },
  { cadence: 'quarterly', brand: 'FLO', department: 'FLO App', owner: 'Kolachi', metric: 'Monthly Churn Rate', target: '<8%', variance: '', latest: '6.30%', values: ['9.85%', '6.30%'] },
  { cadence: 'quarterly', brand: 'FLO', department: 'CRO / Site', owner: 'Alex', metric: 'Site Conversion Rate', target: 'Set baseline', variance: '', latest: '0.71%', values: ['0.84%', '0.71%'] },
  { cadence: 'quarterly', brand: 'FLO', department: 'Creative', owner: 'Luke', metric: 'Share of Spend — Chris', target: '100%', variance: '-43.0%', latest: '38.05%', values: ['6.25%', '38.05%'] },
  { cadence: 'quarterly', brand: 'FLO', department: 'Retention', owner: 'Daniel', metric: 'Returning Customer Revenue %', target: 'Set baseline', variance: '', latest: '42.03%', values: ['24.35%', '42.03%'] },
  { cadence: 'quarterly', brand: 'FLO', department: 'Social', owner: 'Fatima', metric: 'Instagram Total Posts', target: '50', variance: '', latest: '39.6', values: ['', '39.6'] },
  { cadence: 'quarterly', brand: 'FLO', department: 'Ops', owner: 'Shumail', metric: 'Avg Shipping Cost / Order', target: '$14', variance: '', latest: '$14.54', values: ['$21.16', '$14.54'] },
  { cadence: 'quarterly', brand: 'FLO', department: 'CS', owner: 'Hassan', metric: 'CS Tickets % of Orders', target: '<2%', variance: '', latest: '22.08%', values: ['15.26%', '22.08%'] },
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

function StatusPill({ status }) {
  const s = STATUS_META[status] || STATUS_META.gray;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 999,
      fontSize: 10.5, fontWeight: 800, color: s.color, background: s.bg, border: `1px solid ${s.border}`, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: s.color }} />{s.label}
    </span>
  );
}

const PERIOD_COL_WIDTH = 118;
const KPI_LABEL_COL_WIDTH = 240;

function periodMeta(period, index) {
  return { label: period.label, sub: index === 0 ? 'Latest' : period.sub };
}

function KpiRowLabel({ row, onSelect }) {
  const st = STATUS_META[row.status] || STATUS_META.gray;
  const brandColor = row.brand === 'NOBL' ? NOBL_ACCENT : FLO_ACCENT;
  return (
    <div
      onClick={() => onSelect?.(row)}
      style={{ cursor: onSelect ? 'pointer' : 'default', minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0, marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: st.color, flexShrink: 0 }} />
          <span style={{ fontSize: 10.5, fontWeight: 950, color: brandColor, letterSpacing: '.07em' }}>{row.brand}</span>
          <span style={{ fontSize: 10, color: 'var(--text4)', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.department}>
            {row.department}
          </span>
        </div>
        <span style={{ fontSize: 9.5, fontWeight: 850, color: st.color, background: st.bg, border: `1px solid ${st.border}`, borderRadius: 999, padding: '2px 6px', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {st.label}
        </span>
      </div>
      <div title={row.metric} style={{ fontSize: 12, fontWeight: 950, lineHeight: 1.25, color: 'var(--text)', marginBottom: 6 }}>
        {row.metric}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5, fontSize: 10 }}>
        <div title={`Target: ${row.target || '—'}`}>
          <div style={{ fontSize: 8.5, color: 'var(--text4)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.05em' }}>Target</div>
          <div style={{ marginTop: 2, color: 'var(--text2)', fontWeight: 850, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.target || '—'}</div>
        </div>
        <div title={`Owner: ${row.owner || '—'}`}>
          <div style={{ fontSize: 8.5, color: 'var(--text4)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.05em' }}>Owner</div>
          <div style={{ marginTop: 2, color: 'var(--text2)', fontWeight: 850, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.owner || '—'}</div>
        </div>
        <div title={`Latest: ${row.latest || '—'}`}>
          <div style={{ fontSize: 8.5, color: 'var(--text4)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.05em' }}>Latest</div>
          <div style={{ marginTop: 2, color: st.color, fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.latest || '—'}</div>
        </div>
      </div>
    </div>
  );
}

function RawKpiTable({ rows, cadence, periods = [], onSelect }) {
  const [matrixSearch, setMatrixSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('ALL');
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
  const cadenceLabel = cadence === 'daily' ? 'Daily' : cadence === 'weekly' ? 'Weekly' : 'Quarterly';
  return (
    <ChartPanel
      title={`KPI matrix — ${cadenceLabel}`}
      subtitle="Metrics down the left; dates across the top (latest column first). Search filters KPI rows."
      style={{ padding: 14, minHeight: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 560px', minWidth: 320, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', minWidth: 260, flex: '1 1 360px', maxWidth: 560 }}>
          <input
            value={matrixSearch}
            onChange={(e) => setMatrixSearch(e.target.value)}
            placeholder="Search KPI rows: owner, metric, department, target, status…"
            style={{
              width: '100%',
              padding: '8px 30px 8px 30px',
              background: 'var(--bg3)',
              border: '1px solid var(--border2)',
              borderRadius: 9,
              color: 'var(--text)',
              fontSize: 12,
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
        <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 800, whiteSpace: 'nowrap' }}>
          Showing <span style={{ color: 'var(--text)', fontWeight: 950 }}>{matrixRows.length}</span> of {rows.length} KPI rows
        </div>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 'clamp(280px, calc(100vh - 520px), 640px)', border: '1px solid var(--border)', borderRadius: 10 }}>
        <table style={{ width: tableWidth, minWidth: tableWidth, tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0, fontSize: 11.5 }}>
          <thead>
            <tr>
              <th style={{
                position: 'sticky', top: 0, left: 0, zIndex: 9,
                background: 'var(--bg2)', color: 'var(--text3)', textAlign: 'left',
                padding: '8px 10px', borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)',
                fontSize: 10.5, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em',
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
                      padding: '8px 10px',
                      borderBottom: '1px solid var(--border)',
                      borderRight: '1px solid var(--col-sep)',
                      minWidth: PERIOD_COL_WIDTH,
                      width: PERIOD_COL_WIDTH,
                      fontWeight: 900,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <div>{meta.label}</div>
                    <div style={{ marginTop: 2, fontSize: 9.5, color: 'var(--text4)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em' }}>
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
                    padding: '10px 10px',
                    borderBottom: '1px solid var(--row-sep)',
                    borderRight: '1px solid var(--border)',
                    minWidth: KPI_LABEL_COL_WIDTH,
                    width: KPI_LABEL_COL_WIDTH,
                    verticalAlign: 'top',
                    boxShadow: '8px 0 12px -12px rgba(0,0,0,.35)',
                  }}>
                    <KpiRowLabel row={row} onSelect={onSelect} />
                  </td>
                  {periods.map((period, periodIndex) => (
                    <td
                      key={`${period.key}-${row.brand}-${row.metric}`}
                      onClick={() => onSelect?.(row)}
                      style={{
                        padding: '9px 8px',
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
                      <span style={{ color: periodIndex === 0 ? st.color : undefined }}>
                        {row.values?.[periodIndex] || '—'}
                      </span>
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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
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
              borderRadius: 10,
              padding: '8px 9px',
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              gap: 7,
              alignItems: 'center',
              boxShadow: isSelected ? 'var(--shadow-sm)' : 'none',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: st.color, flexShrink: 0 }} />
                <span style={{ fontSize: 10, fontWeight: 900, letterSpacing: '.07em', textTransform: 'uppercase', color: brandColor }}>{row.brand}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.department}</span>
              </div>
              <div style={{ fontSize: 11.5, fontWeight: 850, color: 'var(--text)', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.metric}
              </div>
              <div style={{ marginTop: 3, fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Owner: {row.owner || '—'} · Target: {row.target || '—'}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, fontWeight: 900, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{row.latest}</div>
              <div style={{ marginTop: 2, fontSize: 10.5, fontWeight: 900, color: st.color }}>{row.variance || STATUS_META[row.status].label}</div>
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
      <div style={{ background: 'rgba(255,255,255,.72)', border: '1px solid var(--border)', borderRadius: 15, padding: 12, boxShadow: 'var(--shadow-sm)', minHeight: 160, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div style={{ fontSize: 11, fontWeight: 900, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Selected KPI trend</div>
        <div style={{ marginTop: 8, fontSize: 14, fontWeight: 900, color: 'var(--text)' }}>No KPI matches these filters</div>
        <div style={{ marginTop: 5, fontSize: 12, color: 'var(--text3)', lineHeight: 1.45 }}>Adjust Brand, Status, or View filters to restore trend data.</div>
      </div>
    );
  }
  const brandColor = selected.brand === 'NOBL' ? NOBL_ACCENT : FLO_ACCENT;
  return (
    <div style={{ background: 'rgba(255,255,255,.72)', border: '1px solid var(--border)', borderRadius: 15, padding: 12, boxShadow: 'var(--shadow-sm)', minHeight: 160 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10.5, fontWeight: 900, color: brandColor, textTransform: 'uppercase', letterSpacing: '.08em' }}>
            {selected.brand} · {selected.department}
          </div>
          <div style={{ marginTop: 5, fontSize: 14, fontWeight: 950, color: 'var(--text)', lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {selected.metric}
          </div>
        </div>
        <StatusPill status={selected.status} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 6 }}>
        {[
          ['Latest', selected.latest, 'var(--text)'],
          ['Target', selected.target || '—', 'var(--text)'],
          ['Var', selected.variance || '—', STATUS_META[selected.status].color],
        ].map(([label, value, color]) => (
          <div key={label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 9, padding: '6px 7px' }}>
            <div style={{ fontSize: 9.5, color: 'var(--text3)', fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
            <div style={{ marginTop: 3, fontSize: 13, color, fontWeight: 950, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ height: 64 }}>
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
    <div style={{ background: 'rgba(255,255,255,.72)', border: '1px solid var(--border)', borderRadius: 15, padding: 12, boxShadow: 'var(--shadow-sm)', minHeight: 160 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 900, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Department health</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text3)' }}>Attention-weighted department view</div>
        </div>
        <div style={{ fontSize: 18, fontWeight: 950, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{deptRows.length}</div>
      </div>
      <div style={{ height: 102 }}>
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
    <div style={{ background: 'rgba(255,255,255,.72)', border: '1px solid var(--border)', borderRadius: 15, padding: 12, boxShadow: 'var(--shadow-sm)', minHeight: 160 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', marginBottom: 9 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 900, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Executive snapshot</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text3)' }}>What leadership should look at first</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 23, fontWeight: 950, color: healthRate >= 70 ? 'var(--success)' : attentionCount ? 'var(--warn)' : 'var(--text)' }}>{healthRate}%</div>
          <div style={{ marginTop: -2, fontSize: 10, color: 'var(--text3)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>healthy</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7, marginBottom: 8 }}>
        {[
          ['Total KPIs', rows.length, 'var(--text)'],
          ['Need eyes', attentionCount, attentionCount ? 'var(--danger)' : 'var(--success)'],
          ['On/Ahead', healthyCount, 'var(--success)'],
        ].map(([label, value, color]) => (
          <div key={label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '7px 9px' }}>
            <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 850, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
            <div style={{ marginTop: 3, fontSize: 16, color, fontWeight: 950, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div style={{ borderLeft: '3px solid var(--danger)', paddingLeft: 9, minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em' }}>Biggest miss</div>
          <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--text)', fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{biggestMiss?.metric || 'No scored miss'}</div>
          <div style={{ marginTop: 3, fontSize: 11, color: 'var(--danger)', fontWeight: 900 }}>{biggestMiss?.variance || '—'} <span style={{ color: 'var(--text3)', fontWeight: 700 }}>{biggestMiss?.owner ? `· ${biggestMiss.owner}` : ''}</span></div>
        </div>
        <div style={{ borderLeft: '3px solid var(--success)', paddingLeft: 9, minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '.06em' }}>Strongest win</div>
          <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--text)', fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{strongestWin?.metric || 'No scored win'}</div>
          <div style={{ marginTop: 3, fontSize: 11, color: 'var(--success)', fontWeight: 900 }}>{strongestWin?.variance || '—'} <span style={{ color: 'var(--text3)', fontWeight: 700 }}>{strongestWin?.owner ? `· ${strongestWin.owner}` : ''}</span></div>
        </div>
      </div>
    </div>
  );
}

export default function KpiPulsePage() {
  const [cadence, setCadence] = useState('daily');
  const [brands, setBrands] = useState(['ALL']);
  const [statuses, setStatuses] = useState(['ALL']);
  const [selectedMetric, setSelectedMetric] = useState(null);
  const [pulse, setPulse] = useState(null);

  useEffect(() => {
    let alive = true;
    getKpiPulse().then((d) => { if (alive) setPulse(d); }).catch(() => { if (alive) setPulse(null); });
    return () => { alive = false; };
  }, []);

  const cadenceData = pulse?.cadences?.[cadence] || null;
  const periods = useMemo(() => cadenceData?.periods || [], [cadenceData]);

  const normalizedBrands = useMemo(() => normalizeKpiBrands(brands), [brands]);
  const normalizedStatuses = useMemo(() => normalizeKpiStatuses(statuses), [statuses]);
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
        dbBacked = true;
        values = raw.map(v => fmtMetricValue(key, v) ?? '—');
        const firstNonNull = raw.find(v => v != null);
        latest = firstNonNull != null ? fmtMetricValue(key, firstNonNull) : '—';
        variance = firstNonNull != null ? varianceFor(key, firstNonNull, r.target) : '';
      } else {
        values = Array.from({ length: len }, () => '—');
        latest = '—';
        variance = '';
      }
      const status = dbBacked && variance ? statusFor({ variance }) : 'gray';
      return { ...r, values, latest, variance, status, dbBacked };
    });
    return built
      .filter(r => normalizedBrands.includes('ALL') || brandFilterSet.has(r.brand))
      .filter(r => normalizedStatuses.includes('ALL') || statusFilterSet.has(r.status));
  }, [cadence, cadenceData, periods, normalizedBrands, normalizedStatuses, brandFilterSet, statusFilterSet]);

  const selected = selectedMetric && rows.find(r => r.metric === selectedMetric.metric && r.brand === selectedMetric.brand)
    ? rows.find(r => r.metric === selectedMetric.metric && r.brand === selectedMetric.brand)
    : rows[0];

  const filterSummary = [
    KPI_CADENCE_OPTIONS.find(o => o.value === cadence)?.label || 'Daily',
    !normalizedBrands.includes('ALL') && multiFilterLabel(normalizedBrands, KPI_BRAND_OPTIONS),
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
    <div className="page-stack" style={{ gap: 10, minHeight: 0 }}>
      <PageIntro>
        <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ color: 'var(--text3)', fontSize: 12, lineHeight: 1.45, flex: '1 1 420px' }}>
            Leadership KPI matrix across NOBL and FLO. Metrics available in the database — revenue, blended &amp; geo MER,
            AOV, Amazon share, and NOBL Air attach / activation / trial-to-paid — are computed live for daily, weekly, and
            quarterly periods (and advance automatically each day). Metrics with no database source are shown blank.
          </div>
          {pulse?.asOf && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text2)', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} />
              Data through {pulse.asOf}
            </span>
          )}
        </div>
      </PageIntro>

      <div className="global-filter-bar" style={{ marginBottom: 0, padding: '10px 14px 11px' }}>
        <div className="global-filter-bar__head" style={{ marginBottom: 8, paddingBottom: 8 }}>
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

          <FilterMultiSelect
            label="Brand"
            value={brands}
            onChange={setBrands}
            options={KPI_BRAND_OPTIONS}
            normalize={normalizeKpiBrands}
            minWidth={150}
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
        </div>
      </div>

      <div style={{
        position: 'relative', overflow: 'hidden', borderRadius: 18, padding: 12,
        background: 'linear-gradient(135deg, rgba(31,111,84,.13), rgba(196,91,124,.08) 48%, rgba(176,125,24,.10))',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ position: 'absolute', right: -70, top: -90, width: 240, height: 240, borderRadius: '50%', background: 'rgba(31,111,84,.10)' }} />
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px, 1.2fr) minmax(280px, .9fr) minmax(280px, .9fr)', gap: 10, alignItems: 'stretch' }}>
            <ExecutiveSnapshot rows={rows} />
            <HeroTrendCard selected={selected} chartRows={chartRows} />
            <HeroDepartmentHealth deptRows={deptRows} />
          </div>
        </div>
      </div>

      <ChartPanel
        title="Priority KPIs"
        subtitle={attention.length ? `${attention.length} need attention in current filter` : 'Showing key rows from this view'}
        style={{ padding: 14 }}
      >
        <PriorityList rows={priorityRows} selected={selected} onSelect={setSelectedMetric} />
      </ChartPanel>

      <RawKpiTable rows={rows} cadence={cadence} periods={periods} onSelect={setSelectedMetric} />
    </div>
  );
}
