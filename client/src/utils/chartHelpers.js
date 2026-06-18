import { fmt$, fmtRatio, isMerRoasLabel } from './api';

export function fmtChartCurrency(v) {
  return fmt$(v);
}

export function fmtChartRatio(v) {
  return fmtRatio(v);
}

/** Recharts Y-axis tick — currency (rounded dollars). */
export function fmtAxisCurrency(v) {
  return fmt$(v);
}

/** Recharts Y-axis tick — MER / ROAS (2 decimal places + x). */
export function fmtAxisRatio(v) {
  return fmtRatio(v);
}

/** Recharts tooltip — currency unless series name is MER/ROAS. */
export function fmtChartTooltip(value, name) {
  if (name && isMerRoasLabel(name)) {
    return [fmtRatio(value), name];
  }
  return [fmt$(value), name];
}

export const NOBL_ACCENT = '#1f7a5c';  /* NOBL Travel — evergreen */
export const FLO_ACCENT = '#c45b7c';   /* Pilates FLO — warm rose */
export const NOBL_WARN = '#b07d18';
export const FLO_WARN = '#b07d18';

export const CHANNEL_COL = {
  META: '#1877f2',
  GOOGLE: '#ea4335',
  TIKTOK: '#69c9d0',
  SNAPCHAT: '#f7c948',
  PINTEREST: '#e60023',
  APPLOVIN: '#ff8c00',
  BING: '#00809d',
  X: '#657786',
};

export const GEO_COL = ['#1f7a5c', '#c45b7c', '#b07d18', '#3b7ea1', '#8b5cf6', '#06b6d4'];
export const PROD_COL = { portable: '#14b8a6', wooden: '#f59e0b', metal: '#6366f1', mixed: '#94a3b8', unclassified: '#64748b' };

export const Y_AXIS_WIDTH_CURRENCY = 92;
export const Y_AXIS_WIDTH_RATIO = 48;

export const TOOLTIP_STYLE = {
  background: 'var(--bg2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
};

export const CHART_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 16, marginBottom: 16 };

export function mer(rev, spend) {
  return spend > 0 ? rev / spend : 0;
}

export function chColor(channel, accent = NOBL_ACCENT) {
  return CHANNEL_COL[channel] || accent;
}
