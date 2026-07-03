/** Shared dashboard filter options and normalization helpers. */

export const BRAND_OPTIONS = [
  { value: 'ALL', label: 'All brands' },
  { value: 'NOBL', label: 'NOBL Travel' },
  { value: 'FLO', label: 'Pilates FLO' },
  { value: 'FLO_EU', label: 'Pilates FLO EU' },
];

export const REGION_OPTIONS = [
  { value: 'ALL', label: 'All regions' },
  { value: 'US', label: 'US — United States' },
  { value: 'UK', label: 'UK — United Kingdom' },
  { value: 'EU', label: 'EU — Europe' },
  { value: 'CA', label: 'CA — Canada' },
  { value: 'AUS', label: 'AUS — Australia' },
  { value: 'DUBAI', label: 'DUBAI — UAE' },
  { value: 'HK', label: 'HK — Hong Kong' },
  { value: 'INTL', label: 'INTL — International' },
];

export const CHANNEL_OPTIONS = [
  { value: 'ALL', label: 'All channels' },
  { value: 'META', label: 'Meta' },
  { value: 'GOOGLE', label: 'Google' },
  { value: 'TIKTOK', label: 'TikTok' },
  { value: 'SNAPCHAT', label: 'Snapchat' },
  { value: 'PINTEREST', label: 'Pinterest' },
  { value: 'APPLOVIN', label: 'AppLovin' },
  { value: 'BING', label: 'Bing' },
  { value: 'X', label: 'X' },
];

const REGION_ALLOWED = new Set(REGION_OPTIONS.filter(o => o.value !== 'ALL').map(o => o.value));
const CHANNEL_ALLOWED = new Set(CHANNEL_OPTIONS.filter(o => o.value !== 'ALL').map(o => o.value));
const BRAND_ALLOWED = new Set(BRAND_OPTIONS.filter(o => o.value !== 'ALL').map(o => o.value));

export function normalizeMultiFilter(next, allowedSet, canonicalOrder = null) {
  const vals = Array.from(new Set((next || []).map(v => String(v).toUpperCase()))).filter(Boolean);
  if (vals.length === 0) return ['ALL'];
  if (vals.includes('ALL')) return ['ALL'];
  const cleaned = vals.filter(v => allowedSet.has(v));
  if (!cleaned.length) return ['ALL'];
  if (canonicalOrder) {
    return canonicalOrder.filter(v => cleaned.includes(v));
  }
  return cleaned;
}

export function normalizeRegions(next) {
  return normalizeMultiFilter(next, REGION_ALLOWED, ['US', 'UK', 'EU', 'CA', 'AUS', 'DUBAI', 'HK', 'INTL']);
}

export function normalizeChannels(next) {
  return normalizeMultiFilter(next, CHANNEL_ALLOWED, CHANNEL_OPTIONS.filter(o => o.value !== 'ALL').map(o => o.value));
}

export function normalizeBrands(next) {
  return normalizeMultiFilter(next, BRAND_ALLOWED, ['NOBL', 'FLO', 'FLO_EU']);
}

export function multiFilterLabel(selected, options) {
  const map = Object.fromEntries(options.map(o => [o.value, o.label]));
  const s = selected?.length ? selected : ['ALL'];
  if (s.length === 1 && s[0] === 'ALL') return map.ALL || 'All';
  return s.map(v => map[v] || v).join(' + ');
}

export function regionsParam(selected) {
  const s = normalizeRegions(selected);
  return (s.length === 1 && s[0] === 'ALL') ? 'ALL' : s.join(',');
}

export function channelsParam(selected) {
  const s = normalizeChannels(selected);
  return (s.length === 1 && s[0] === 'ALL') ? 'ALL' : s.join(',');
}

export function brandsParam(selected) {
  const s = normalizeBrands(selected);
  if (s.length === 1 && s[0] === 'ALL') return 'ALL';
  return s.join(',');
}

/** Map global brand filter to Channels page API param ('' = both). */
export function brandsToChannelApi(selected) {
  const s = normalizeBrands(selected);
  if (s.length === 1 && s[0] === 'ALL') return '';
  if (s.length === 1) return s[0] === 'FLO_EU' ? 'FLO' : s[0];
  return '';
}

/** Map global brand filter to Subscriptions API param. */
export function brandsToSubsApi(selected) {
  const s = normalizeBrands(selected);
  if (s.length === 1 && s[0] === 'ALL') return 'ALL';
  const mapped = s.map(b => (b === 'FLO_EU' ? 'FLO' : b)).filter(b => b === 'NOBL' || b === 'FLO');
  if (mapped.length === 2) return 'ALL';
  return mapped[0] || 'ALL';
}

/** Map global brand filter to Live page brand key. */
export function brandsToLiveKey(selected) {
  const s = normalizeBrands(selected);
  if (s.length === 1 && s[0] === 'FLO_EU') return 'flo_eu';
  if (s.length === 1 && s[0] === 'FLO') return 'flo';
  return 'nobl';
}

/** Map global brand filter to Meta Ads API brand param. */
export function brandsToMetaApi(selected) {
  const s = normalizeBrands(selected);
  if (s.length === 1 && s[0] === 'ALL') return 'ALL';
  if (s.length === 1) return s[0] === 'FLO_EU' ? 'FLO' : s[0];
  return 'ALL';
}

export function isAllRegions(selected) {
  const s = normalizeRegions(selected);
  return s.length === 1 && s[0] === 'ALL';
}

export function isAllChannels(selected) {
  const s = normalizeChannels(selected);
  return s.length === 1 && s[0] === 'ALL';
}

export function isAllBrands(selected) {
  const s = normalizeBrands(selected);
  return s.length === 1 && s[0] === 'ALL';
}

/** Canonical region codes used in TW geo tables (matches server/etl/twFullSync.js). */
const GEO_REGION_ALIASES = {
  US: 'US', USA: 'US', 'UNITED STATES': 'US',
  CA: 'CA', CAN: 'CA', CANADA: 'CA',
  AUS: 'AUS', AU: 'AUS', AUSTRALIA: 'AUS',
  DUBAI: 'DUBAI', UAE: 'DUBAI', AE: 'DUBAI', 'UNITED ARAB EMIRATES': 'DUBAI',
  HK: 'HK', 'HONG KONG': 'HK',
  // UK is a first-class NOBL region (new Shopify store wdwzan-tc.myshopify.com).
  UK: 'UK', GB: 'UK', 'UNITED KINGDOM': 'UK', 'GREAT BRITAIN': 'UK',
  EU: 'EU', DE: 'EU', FR: 'EU',
  INTL: 'INTL', INTERNATIONAL: 'INTL', OTHER: 'INTL', ROW: 'INTL',
};

export function canonicalGeoRegion(value) {
  const u = String(value || '').toUpperCase().trim();
  return GEO_REGION_ALIASES[u] || u;
}

const CHANNEL_ALIASES = {
  META: 'META', FACEBOOK: 'META', FACEBOOK_ADS: 'META', 'FACEBOOK-ADS': 'META', INSTAGRAM: 'META',
  GOOGLE: 'GOOGLE', GOOGLE_ADS: 'GOOGLE', 'GOOGLE-ADS': 'GOOGLE', ADWORDS: 'GOOGLE',
  TIKTOK: 'TIKTOK', TIKTOK_ADS: 'TIKTOK', 'TIKTOK-ADS': 'TIKTOK',
  SNAPCHAT: 'SNAPCHAT', SNAP: 'SNAPCHAT',
  PINTEREST: 'PINTEREST',
  APPLOVIN: 'APPLOVIN', APP_LOVIN: 'APPLOVIN', 'APP-LOVIN': 'APPLOVIN',
  BING: 'BING', MICROSOFT: 'BING', MICROSOFT_ADS: 'BING',
  X: 'X', TWITTER: 'X',
};

export function canonicalChannel(value) {
  const u = String(value || '').toUpperCase().trim().replace(/\s+/g, '_');
  return CHANNEL_ALIASES[u] || u;
}

/** NOBL Air subscriber region buckets (EU is a TW geo code, not an Air bucket; UK is). */
export const AIR_REGION_ORDER = ['US', 'CA', 'AUS', 'UK', 'DUBAI', 'HK', 'INTL'];

/** Build nobl_air_region_daily region_key from global filter selection. */
export function airRegionKeyFromSelection(selected) {
  const s = normalizeRegions(selected);
  if (s.length === 1 && s[0] === 'ALL') return null;
  const parts = AIR_REGION_ORDER.filter((p) => s.includes(p));
  return parts.length ? parts.join('_') : null;
}

/** True when selection includes TW geo codes with no Air bucket mapping (e.g. EU only). */
export function isGeoOnlyRegionSelection(selected) {
  const s = normalizeRegions(selected);
  if (s.length === 1 && s[0] === 'ALL') return false;
  return s.every((r) => r === 'EU' || !AIR_REGION_ORDER.includes(r));
}

/** Client-side channel row filter. */
export function filterByChannels(rows, channelField, selected) {
  const s = normalizeChannels(selected);
  if (s.length === 1 && s[0] === 'ALL') return rows;
  const set = new Set(s);
  return (rows || []).filter(r => set.has(canonicalChannel(r[channelField])));
}

/** Client-side region row filter (geo tables). */
export function filterByRegions(rows, regionField, selected) {
  const s = normalizeRegions(selected);
  if (s.length === 1 && s[0] === 'ALL') return rows;
  const set = new Set(s);
  return (rows || []).filter(r => set.has(canonicalGeoRegion(r[regionField])));
}

/** Client-side brand row filter (channels API returns both brands). */
export function filterByBrands(rows, brandField, selected) {
  const s = normalizeBrands(selected);
  if (s.length === 1 && s[0] === 'ALL') return rows;
  const allowed = new Set(s.map((b) => (b === 'FLO_EU' ? 'FLO' : b)));
  return (rows || []).filter((r) => allowed.has(String(r[brandField] || '').toUpperCase()));
}
