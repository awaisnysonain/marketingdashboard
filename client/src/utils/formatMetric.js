/**
 * Single source of truth for how metrics display across the dashboard.
 *
 * | Kind     | Display        | Examples                          |
 * |----------|----------------|-----------------------------------|
 * | currency | $1,234         | revenue, spend, CAC, refunds      |
 * | count    | 1,234          | orders, purchases, new customers  |
 * | ratio    | 2.38x          | MER, ROAS                         |
 * | percent  | 33%            | attach rate, NVP, TTP             |
 */
import { fmt$, fmtNum, fmtPct, fmtRatio } from './api';

export const METRIC_KIND = {
  CURRENCY: '$',
  COUNT: 'num',
  RATIO: 'x',
  PERCENT: 'pct',
};

/** Map metric keys to display kind (tables without explicit type). */
const KEY_KIND = {
  order_revenue: '$',
  total_revenue: '$',
  gross_minus_discounts: '$',
  total_spend: '$',
  shopify_revenue: '$',
  amazon_revenue: '$',
  refund_amount: '$',
  revenue_1d: '$',
  revenue_actual: '$',
  spend_1d: '$',
  spend_actual: '$',
  sub_revenue_actual: '$',
  rebill_revenue: '$',
  new_sub_revenue: '$',
  shopify_sub_gross: '$',
  shopify_sub_refunds: '$',
  cac: '$',
  mer: 'x',
  roas_1d: 'x',
  total_orders: 'num',
  new_customer_orders: 'num',
  returning_customer_orders: 'num',
  new_cust_orders: 'num',
  purchases_1d: 'num',
};

export function inferMetricKind(metricKey, label) {
  if (metricKey && KEY_KIND[metricKey]) return KEY_KIND[metricKey];
  const h = String(label || metricKey || '').toLowerCase();
  if (/roas|mer|sales per ad/.test(h)) return 'x';
  if (/rate|attach|ttp|nvp|activation|percent|pct|%/.test(h) && !/operating/.test(h)) return 'pct';
  if (/revenue|spend|sales|cac|aov|ltv|refund|gross|amount|budget|cost|rev\b|price/.test(h)) return '$';
  if (/orders|purchases|cust|customers|units|count|impressions|clicks/.test(h)) return 'num';
  return 'num';
}

export function formatMetricValue(value, type, options = {}) {
  const { metricKey, label } = options;
  if (value === null || value === undefined || value === '') return '—';

  const kind = type || inferMetricKind(metricKey, label);
  const n = Number(value);

  if (kind === '$' || kind === 'currency') {
    if (isNaN(n)) return String(value);
    return fmt$(n);
  }
  if (kind === 'x' || kind === 'ratio') {
    if (isNaN(n)) return '—';
    return fmtRatio(n);
  }
  if (kind === 'pct' || kind === 'percent') {
    if (isNaN(n)) return '—';
    return fmtPct(n);
  }
  // count / num
  if (isNaN(n)) return String(value);
  if (metricKey === 'cac' && n === 0) return '—';
  return fmtNum(n);
}

/** Raw value for clipboard copy. */
export function rawMetricValue(value, type, options = {}) {
  if (value == null || value === '') return '';
  const n = Number(value);
  if (isNaN(n)) return String(value);
  const kind = type || inferMetricKind(options.metricKey, options.label);
  if (kind === '$') return String(Math.round(n));
  if (kind === 'x') return n.toFixed(4);
  if (kind === 'pct') return String(n);
  return String(Math.round(n));
}
