/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                     BRAND CONFIGURATION — SOURCE OF TRUTH                  ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * CRITICAL BUSINESS RULE — READ BEFORE WRITING ANY QUERY:
 *
 *   NOBL TRAVEL and NOBL EU are ONE SINGLE ENTITY.
 *
 *   They operate as one combined brand. Due to TripleWhale regional data
 *   restrictions, EU performance is tracked under region='EU' within the NOBL
 *   geo tables — but they are NOT separate brands. They are the same store.
 *
 *   ► ALL revenue, spend, MER, orders, and any other metric for NOBL Travel
 *     MUST always include EU. Never show NOBL without EU. Never compare them
 *     as separate entities. Always sum them together.
 *
 *   The canonical database tables/views already enforce this:
 *   - tw_summary_daily WHERE brand='NOBL'  →  includes EU (one store)
 *   - nobl_brand_tw_summary_daily          →  includes EU (same view)
 *   - nobl_brand_tw_channel_daily          →  includes EU spend
 *   - nobl_brand_tw_geo_daily              →  shows EU as a region breakdown
 *                                             (breakdown only — not a separate brand)
 *
 *   NEVER use nobl_main_tw_store_summary_daily alone as the NOBL total —
 *   it is a store-level view but EU is already inside it (same Shopify store).
 *
 *   WHEN BUILDING FUTURE DASHBOARDS / QUERIES:
 *   - Always use NOBL_BRAND.dbBrand = 'NOBL' as the brand filter
 *   - Always use NOBL_BRAND.summaryTable for summary KPIs
 *   - Always use NOBL_BRAND.channelTable for channel breakdown
 *   - Always use NOBL_BRAND.geoTable for regional MER (EU always included)
 *   - EU geo share is ~0.5–1% of NOBL revenue but must always be counted
 */

// ── Brand definitions ─────────────────────────────────────────────────────────

const NOBL_BRAND = {
  key:          'nobl',
  dbBrand:      'NOBL',          // WHERE brand = 'NOBL'  (includes EU — same store)
  displayName:  'NOBL Travel',
  euIncluded:   true,            // EU is always combined — never separate
  note:         'NOBL Travel + EU = 1 combined store. Always sum together.',

  // Canonical table/view names to use in queries
  summaryTable: 'nobl_brand_tw_summary_daily',   // includes EU
  channelTable: 'nobl_brand_tw_channel_daily',   // includes EU channels
  geoTable:     'nobl_brand_tw_geo_daily',        // EU shown as region (already included)
  storeSummary: 'nobl_main_tw_store_summary_daily', // same store = includes EU

  // Region order for UI display (EU always shown, always 2nd)
  geoOrder: ['US', 'EU', 'CA', 'AUS', 'DUBAI'],

  // EU region identifier in geo table
  euRegion: 'EU',
};

const FLO_US_BRAND = {
  key:          'flo',
  dbBrand:      'FLO',
  displayName:  'Pilates FLO US',
  euIncluded:   false,
  note:         'FLO US main store. FLO EU is a separate store and separate brand.',

  summaryTable: 'flo_brand_tw_summary_daily',
  channelTable: 'flo_brand_tw_channel_daily',
  geoTable:     'flo_brand_tw_geo_daily',
  storeSummary: 'flo_main_tw_store_summary_daily',

  geoOrder: ['US', 'CA', 'AUS', 'DUBAI', 'EU'],
  euRegion: null,
};

const FLO_EU_BRAND = {
  key:          'flo_eu',
  dbBrand:      'FLO',           // same DB brand but different store
  displayName:  'Pilates FLO EU',
  euIncluded:   false,
  note:         'FLO EU is a separate Shopify store (afmjag-r2.myshopify.com). Tracked independently.',

  summaryTable: 'flo_eu_tw_store_summary_daily',
  channelTable: null,            // no separate EU channel table
  geoTable:     null,            // no separate EU geo table
  storeSummary: 'flo_eu_tw_store_summary_daily',

  geoOrder: [],
  euRegion: null,
};

// ── All brands map ────────────────────────────────────────────────────────────
const BRANDS = {
  nobl:   NOBL_BRAND,
  flo:    FLO_US_BRAND,
  flo_eu: FLO_EU_BRAND,
};

/**
 * Get brand config by key (nobl / flo / flo_eu) or by DB brand string (NOBL / FLO).
 * Always returns a valid config — defaults to NOBL if unknown.
 */
function getBrand(keyOrDbBrand) {
  const lower = String(keyOrDbBrand).toLowerCase();
  if (BRANDS[lower]) return BRANDS[lower];
  // Try by dbBrand
  const byDb = Object.values(BRANDS).find(b => b.dbBrand === String(keyOrDbBrand).toUpperCase());
  return byDb || NOBL_BRAND;
}

/**
 * Performance thresholds — single source of truth for all pages.
 * Changing a value here updates every dashboard automatically.
 */
const THRESHOLDS = {
  mer: {
    // NOBL and FLO global (US, CA, AUS, EU all use same global threshold)
    global: { red: 1.8, yellow: 2.0 },
    // Dubai/UAE has lower threshold due to market dynamics
    dubai:  { red: 1.6, yellow: 1.8 },
  },
  roas: {
    META:      { red: 1.6, yellow: 1.8 },
    GOOGLE:    { red: 2.0, yellow: 3.0 },
    APPLOVIN:  { red: 2.0, yellow: 2.2 },
    SNAPCHAT:  { red: 1.6, yellow: 1.8 },
    TIKTOK:    { red: 1.6, yellow: 1.8 },
    BING:      { red: 1.5, yellow: 2.0 },
    PINTEREST: { red: 1.5, yellow: 2.0 },
    X:         { red: 1.5, yellow: 2.0 },
    default:   { red: 1.5, yellow: 2.0 },
  },
  nvp:    { red: 0.45,  yellow: 0.50  },
  refund: { red_above: 0.13, yellow_above: 0.06 },
  nc_rate:{ red: 0.17,  yellow: 0.23  }, // returning customer % inverse
};

/**
 * Classify a metric value as 'green' | 'yellow' | 'red' | 'gray'.
 * @param {number} value
 * @param {{ red, yellow } | { red_above, yellow_above }} t  threshold object
 * @param {boolean} invert  true = higher is worse (e.g. refund rate)
 */
function classify(value, t, invert = false) {
  if (value == null || isNaN(value)) return 'gray';
  if (invert) {
    if (value > t.red_above)    return 'red';
    if (value > t.yellow_above) return 'yellow';
    return 'green';
  }
  if (value < t.red)    return 'red';
  if (value < t.yellow) return 'yellow';
  return 'green';
}

/**
 * Always calculate MER as revenue / spend.
 * NEVER use the stored `mer` column in tw_summary_daily — it is wrong.
 * The brand-specific geo tables have correct stored MER and can be used as-is.
 */
function calcMer(revenue, spend) {
  const r = parseFloat(revenue || 0);
  const s = parseFloat(spend   || 0);
  return s > 0 ? parseFloat((r / s).toFixed(4)) : 0;
}

module.exports = {
  BRANDS,
  NOBL_BRAND,
  FLO_US_BRAND,
  FLO_EU_BRAND,
  getBrand,
  THRESHOLDS,
  classify,
  calcMer,
};
