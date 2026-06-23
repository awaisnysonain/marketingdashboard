/**
 * Per-brand Meta (Facebook) Marketing API credentials — env driven.
 *
 * Each brand reads its own account/token so NOBL and FLO can sync independently
 * and accurately every day:
 *   <BRAND>_META_AD_ACCOUNT_ID   e.g. NOBL_META_AD_ACCOUNT_ID=act_418992556365481
 *   <BRAND>_META_ACCESS_TOKEN    e.g. NOBL_META_ACCESS_TOKEN=EAAT...
 *   <BRAND>_META_API_VERSION     optional, defaults to META_API_VERSION or v20.0
 *
 * Legacy single-account vars (META_AD_ACCOUNT_ID / META_ADS_READ_TOKEN) still
 * apply to NOBL so existing deployments keep working without changes.
 */

const DEFAULT_API_VERSION = process.env.META_API_VERSION || 'v20.0';

/** Ensure the account id is in the `act_<id>` form Meta expects. */
function normalizeActId(accountId) {
  const id = String(accountId || '').trim();
  if (!id) return '';
  return id.startsWith('act_') ? id : `act_${id}`;
}

/**
 * Resolve Meta credentials for a brand from the environment.
 * @param {string} brand - 'NOBL' | 'FLO' (case-insensitive)
 * @returns {{ brand: string, accountId: string, token: string, apiVersion: string } | null}
 */
function getMetaAccount(brand) {
  const B = String(brand || '').toUpperCase();
  if (!B) return null;

  let accountId = process.env[`${B}_META_AD_ACCOUNT_ID`] || '';
  let token = process.env[`${B}_META_ACCESS_TOKEN`]
    || process.env[`${B}_META_ADS_READ_TOKEN`]
    || '';
  const apiVersion = process.env[`${B}_META_API_VERSION`] || DEFAULT_API_VERSION;

  // Backward compatibility: the old single-account vars belong to NOBL.
  if (B === 'NOBL') {
    accountId = accountId || process.env.META_AD_ACCOUNT_ID || '';
    token = token || process.env.META_ADS_READ_TOKEN || '';
  }

  accountId = normalizeActId(accountId);
  token = String(token || '').trim();
  if (!accountId || !token) return null;

  return { brand: B, accountId, token, apiVersion };
}

/** Brands we support a Meta account for. */
const META_BRANDS = ['NOBL', 'FLO'];

/** Which of the supported brands actually have credentials configured. */
function metaConfiguredBrands() {
  return META_BRANDS.filter((b) => getMetaAccount(b));
}

module.exports = {
  getMetaAccount,
  metaConfiguredBrands,
  normalizeActId,
  META_BRANDS,
  DEFAULT_API_VERSION,
};
