/**
 * Apple App Store Connect — IAP fetcher (read-only).
 *
 * Auth: ES256 JWT signed with the brand's .p8 key (no jsonwebtoken dependency —
 * Node's crypto signs EC keys in IEEE-P1363 / JOSE format directly).
 *
 * Data: the Sales and Trends "Sales" report (DAILY / SUMMARY) — a gzipped TSV.
 * We keep only in-app product types (Product Type Identifier starting with "IA":
 * in-app purchases + auto-renewable subscriptions) and aggregate Units and
 * Developer Proceeds. Proceeds are in each sale's "Currency of Proceeds"; round 1
 * sums by currency and treats USD rows as revenue_usd (FX conversion is round 2).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { toUsd } = require('./fxRates');

const APPLE_API = 'https://api.appstoreconnect.apple.com/v1';

function brandAppleCfg(brand) {
  const B = String(brand).toUpperCase();
  return {
    issuerId: process.env[`${B}_APPLE_ISSUER_ID`],
    keyId: process.env[`${B}_APPLE_KEY_ID`],
    privateKeyPath: process.env[`${B}_APPLE_PRIVATE_KEY_PATH`],
    vendorNumber: process.env[`${B}_APPLE_VENDOR_NUMBER`],
  };
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const _jwtCache = {}; // brand → { token, exp }

function appleJwt(brand) {
  const now = Math.floor(Date.now() / 1000);
  const cached = _jwtCache[brand];
  if (cached && cached.exp - 60 > now) return cached.token;

  const cfg = brandAppleCfg(brand);
  if (!cfg.issuerId || !cfg.keyId || !cfg.privateKeyPath) {
    throw new Error(`[Apple ${brand}] missing ISSUER_ID / KEY_ID / PRIVATE_KEY_PATH`);
  }
  const pem = fs.readFileSync(path.resolve(cfg.privateKeyPath), 'utf8');
  const exp = now + 600; // App Store Connect max 20 min; use 10
  const header = { alg: 'ES256', kid: cfg.keyId, typ: 'JWT' };
  const payload = { iss: cfg.issuerId, iat: now, exp, aud: 'appstoreconnect-v1' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key: pem, dsaEncoding: 'ieee-p1363' });
  const token = `${signingInput}.${b64url(sig)}`;
  _jwtCache[brand] = { token, exp };
  return token;
}

/** Parse a tab-separated Apple report into array of row objects keyed by header. */
function parseTsv(text) {
  const lines = String(text).split('\n').filter((l) => l.trim().length);
  if (!lines.length) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (cells[i] ?? '').trim(); });
    return row;
  });
}

/**
 * Fetch the DAILY SALES SUMMARY report for one date. Returns parsed TSV rows,
 * or [] when Apple has no report for that date yet (HTTP 404).
 */
async function fetchSalesReportDaily(brand, reportDate) {
  const cfg = brandAppleCfg(brand);
  if (!cfg.vendorNumber) throw new Error(`[Apple ${brand}] missing VENDOR_NUMBER`);
  const params = new URLSearchParams({
    'filter[frequency]': 'DAILY',
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]': cfg.vendorNumber,
    'filter[reportDate]': reportDate,
    'filter[version]': '1_1',
  });
  const res = await fetch(`${APPLE_API}/salesReports?${params}`, {
    headers: { Authorization: `Bearer ${appleJwt(brand)}`, Accept: 'application/a-gzip' },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) return []; // report not generated for this date
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`[Apple ${brand}] salesReports HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const tsv = zlib.gunzipSync(buf).toString('utf8');
  return parseTsv(tsv);
}

const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };

/** A row is an in-app purchase / subscription (not an app download) when the
 * Product Type Identifier starts with "IA". */
function isIapRow(row) {
  return String(row['Product Type Identifier'] || '').toUpperCase().startsWith('IA');
}

/**
 * Aggregate one day's SALES report into an IAP rollup + per-SKU breakdown.
 * @returns {{ date, units, proceeds_raw, currency, revenue_usd, byProduct: Record<string,{units,proceeds}> }}
 */
function aggregateIapDay(rows, reportDate) {
  const iap = rows.filter(isIapRow);
  const byCurrency = {};
  const byProduct = {};
  let units = 0;
  let revenueUsd = 0;
  for (const r of iap) {
    const u = num(r.Units);
    const proceeds = num(r['Developer Proceeds']) * u; // per-unit proceeds × units
    const cur = (r['Currency of Proceeds'] || r['Currency'] || '').toUpperCase() || 'USD';
    const sku = r.SKU || r['Apple Identifier'] || 'unknown';
    units += u;
    byCurrency[cur] = (byCurrency[cur] || 0) + proceeds;
    const usd = toUsd(proceeds, cur); // USD + known storefront currencies; null = unmapped → skip
    if (usd != null) revenueUsd += usd;
    if (!byProduct[sku]) byProduct[sku] = { units: 0, proceeds: 0, currency: cur };
    byProduct[sku].units += u;
    byProduct[sku].proceeds += proceeds;
  }
  const currencies = Object.keys(byCurrency);
  return {
    date: reportDate,
    units,
    proceeds_raw: Object.values(byCurrency).reduce((s, v) => s + v, 0),
    currency: currencies.length === 1 ? currencies[0] : (currencies.length === 0 ? 'USD' : 'MIXED'),
    revenue_usd: revenueUsd,
    byProduct,
  };
}

/** High-level: fetch + aggregate one day of Apple IAP for a brand. */
async function fetchAppleIapDaily(brand, reportDate) {
  const rows = await fetchSalesReportDaily(brand, reportDate);
  return aggregateIapDay(rows, reportDate);
}

/** Generic daily report fetch (SUBSCRIPTION / SUBSCRIPTION_EVENT / …). [] on 404. */
async function fetchAppleReport(brand, reportType, version, reportDate, reportSubType = 'SUMMARY') {
  const cfg = brandAppleCfg(brand);
  if (!cfg.vendorNumber) throw new Error(`[Apple ${brand}] missing VENDOR_NUMBER`);
  const params = new URLSearchParams({
    'filter[frequency]': 'DAILY',
    'filter[reportType]': reportType,
    'filter[reportSubType]': reportSubType,
    'filter[vendorNumber]': cfg.vendorNumber,
    'filter[reportDate]': reportDate,
    'filter[version]': version,
  });
  const res = await fetch(`${APPLE_API}/salesReports?${params}`, {
    headers: { Authorization: `Bearer ${appleJwt(brand)}`, Accept: 'application/a-gzip' },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`[Apple ${brand}] ${reportType} HTTP ${res.status}: ${txt.slice(0, 160)}`);
  }
  return parseTsv(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
}

/**
 * One day of Apple subscription state: active + trials from the SUBSCRIPTION
 * snapshot, new + cancelled from SUBSCRIPTION_EVENT.
 * @returns {{date, active, trials, new: number, cancelled, proceeds_usd}}
 */
async function fetchAppleSubsDaily(brand, date) {
  const snap = await fetchAppleReport(brand, 'SUBSCRIPTION', '1_4', date);
  let active = 0;
  let trials = 0;
  let proceedsUsd = 0;
  const activeCols = snap.length ? Object.keys(snap[0]).filter((k) => /^Active/.test(k)) : [];
  for (const r of snap) {
    for (const k of activeCols) active += num(r[k]);
    trials += num(r['Active Free Trial Introductory Offer Subscriptions']);
    const cur = (r['Proceeds Currency'] || '').toUpperCase();
    const u = toUsd(num(r['Developer Proceeds']) * num(r['Active Standard Price Subscriptions']), cur);
    if (u != null) proceedsUsd += u;
  }

  const events = await fetchAppleReport(brand, 'SUBSCRIPTION_EVENT', '1_4', date);
  let added = 0;
  let cancelled = 0;
  for (const r of events) {
    const q = num(r.Quantity) || 1;
    const ev = r.Event || '';
    if (/^(Start|Subscribe)/i.test(ev)) added += q;        // new trial starts / direct subscribes
    else if (/Cancel/i.test(ev)) cancelled += q;
  }
  return { date, active, trials, new: added, cancelled, proceeds_usd: proceedsUsd };
}

module.exports = {
  appleJwt,
  fetchSalesReportDaily,
  aggregateIapDay,
  fetchAppleIapDaily,
  fetchAppleReport,
  fetchAppleSubsDaily,
  brandAppleCfg,
};
