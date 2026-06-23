/**
 * Google Play — IAP fetcher (read-only).
 *
 * Auth: service-account JSON via googleapis (already a dependency).
 *
 * Daily revenue: parsed from the monthly earnings reports in the developer's
 * private GCS bucket (gs://pubsite_prod_<DEVELOPER_ACCOUNT_ID>/earnings/
 * earnings_YYYYMM_*.zip). Each zip holds one CSV with per-transaction rows
 * (Transaction Date, Sku, Transaction Type, buyer + merchant amounts). We sum
 * NET proceeds (Charge + Google fee + Tax + Refund) per day in the merchant
 * currency, then convert to USD using the report's own Currency Conversion Rate
 * from USD-buyer rows (exact, no external FX service). NOBL's merchant currency
 * is CAD; FLO's may differ — both are handled.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const path = require('path');
const zlib = require('zlib');
const { google } = require('googleapis');

function brandGoogleCfg(brand) {
  const B = String(brand).toUpperCase();
  return {
    serviceAccountPath: process.env[`${B}_GOOGLE_SERVICE_ACCOUNT_PATH`],
    developerAccountId: process.env[`${B}_GOOGLE_DEVELOPER_ACCOUNT_ID`],
    packageName: process.env[`${B}_GOOGLE_PACKAGE_NAME`],
  };
}

const _authCache = {};

async function googleAuthClient(brand, scopes = ['https://www.googleapis.com/auth/androidpublisher']) {
  const key = `${brand}:${scopes.join(',')}`;
  if (_authCache[key]) return _authCache[key];
  const cfg = brandGoogleCfg(brand);
  if (!cfg.serviceAccountPath) throw new Error(`[Play ${brand}] missing GOOGLE_SERVICE_ACCOUNT_PATH`);
  const auth = new google.auth.GoogleAuth({ keyFile: path.resolve(cfg.serviceAccountPath), scopes });
  const client = await auth.getClient();
  _authCache[key] = client;
  return client;
}

/** Read the subscription catalog via the current monetization API (validates
 * access; seeds product ids). Legacy inappproducts.list is deprecated. */
async function listInAppProducts(brand) {
  const cfg = brandGoogleCfg(brand);
  if (!cfg.packageName) throw new Error(`[Play ${brand}] missing GOOGLE_PACKAGE_NAME`);
  const auth = await googleAuthClient(brand);
  const publisher = google.androidpublisher({ version: 'v3', auth });
  const res = await publisher.monetization.subscriptions.list({ packageName: cfg.packageName });
  return (res.data.subscriptions || []).map((s) => ({
    sku: s.productId,
    basePlans: (s.basePlans || []).length,
    listings: (s.listings || []).map((l) => l.title).filter(Boolean),
  }));
}

// ── Earnings report parsing ────────────────────────────────────────────────

/** Extract the single CSV from a Play earnings .zip (deflate) via the central dir. */
function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('earnings zip: no EOCD');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('earnings zip: no central dir');
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  const lhNameLen = buf.readUInt16LE(localOffset + 26);
  const lhExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
  const comp = buf.subarray(dataStart, dataStart + compSize);
  return (method === 8 ? zlib.inflateRawSync(comp) : comp).toString('utf8');
}

/** CSV line split honouring double-quoted fields (Transaction Date has a comma). */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
/** "May 1, 2026" → "2026-05-01" */
function parseEarningsDate(s) {
  const m = String(s).match(/([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1]];
  if (!mo) return null;
  return `${m[3]}-${mo}-${String(m[2]).padStart(2, '0')}`;
}

/** ['2026-04-01','2026-06-23'] → ['202604','202605','202606'] */
function monthsInRange(start, end) {
  const out = [];
  let y = +start.slice(0, 4);
  let m = +start.slice(5, 7);
  const ey = +end.slice(0, 4);
  const em = +end.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

const numCsv = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };

/**
 * Load Google Play earnings for a date range → per-day IAP aggregates (USD).
 * @returns {{ byDate: Record<string, {date,units,proceeds_raw,currency,revenue_usd,byProduct}>, merchantCurrency, monthsLoaded }}
 */
async function fetchPlayEarningsDaily(brand, start, end) {
  const cfg = brandGoogleCfg(brand);
  if (!cfg.developerAccountId) throw new Error(`[Play ${brand}] missing GOOGLE_DEVELOPER_ACCOUNT_ID`);
  const auth = await googleAuthClient(brand, ['https://www.googleapis.com/auth/devstorage.read_only']);
  const storage = google.storage({ version: 'v1', auth });
  const bucket = `pubsite_prod_${cfg.developerAccountId}`;

  const rows = [];
  const monthsLoaded = [];
  for (const ym of monthsInRange(start, end)) {
    const list = await storage.objects.list({ bucket, prefix: `earnings/earnings_${ym}` });
    for (const obj of (list.data.items || [])) {
      const res = await storage.objects.get({ bucket, object: obj.name, alt: 'media' }, { responseType: 'arraybuffer' });
      const csv = unzipFirst(Buffer.from(res.data));
      const lines = csv.split('\n').filter((l) => l.trim());
      const headers = splitCsvLine(lines[0]).map((h) => h.trim());
      const idx = (name) => headers.indexOf(name);
      const iDate = idx('Transaction Date'), iType = idx('Transaction Type'), iSku = idx('Sku Id');
      const iBuyerCur = idx('Buyer Currency'), iBuyerAmt = idx('Amount (Buyer Currency)');
      const iMerchCur = idx('Merchant Currency'), iMerchAmt = idx('Amount (Merchant Currency)');
      const iRate = idx('Currency Conversion Rate');
      for (let r = 1; r < lines.length; r++) {
        const c = splitCsvLine(lines[r]);
        if (!c[iDate]) continue;
        rows.push({
          date: parseEarningsDate(c[iDate]),
          type: c[iType],
          sku: c[iSku] || 'unknown',
          buyerCur: (c[iBuyerCur] || '').toUpperCase(),
          buyerAmt: numCsv(c[iBuyerAmt]),
          merchCur: (c[iMerchCur] || '').toUpperCase(),
          merchAmt: numCsv(c[iMerchAmt]),
          rate: numCsv(c[iRate]),
        });
      }
      monthsLoaded.push(obj.name);
    }
  }

  // Merchant currency + the report's own merchant-per-USD rate (from USD-buyer rows).
  const merchantCurrency = (rows.find((r) => r.merchCur)?.merchCur) || 'USD';
  const usdRates = rows.filter((r) => r.buyerCur === 'USD' && r.rate > 0).map((r) => r.rate);
  const merchantPerUsd = merchantCurrency === 'USD' ? 1 : (usdRates.length ? usdRates.sort((a, b) => a - b)[Math.floor(usdRates.length / 2)] : 1);

  const byDate = {};
  for (const r of rows) {
    if (!r.date || r.date < start || r.date > end) continue;
    // Net USD per row: USD buyers are exact; others convert merchant→USD via the report rate.
    const usd = r.buyerCur === 'USD' ? r.buyerAmt : (merchantPerUsd ? r.merchAmt / merchantPerUsd : 0);
    const d = byDate[r.date] || (byDate[r.date] = { date: r.date, units: 0, proceeds_raw: 0, currency: merchantCurrency, revenue_usd: 0, byProduct: {} });
    d.proceeds_raw += r.merchAmt;
    d.revenue_usd += usd;
    if (r.type === 'Charge') d.units += 1;
    const bp = d.byProduct[r.sku] || (d.byProduct[r.sku] = { units: 0, proceeds: 0, currency: merchantCurrency });
    bp.proceeds += r.merchAmt;
    if (r.type === 'Charge') bp.units += 1;
  }
  return { byDate, merchantCurrency, merchantPerUsd, monthsLoaded };
}

/** Decode a Play stats object: handles gzip, UTF-16LE BOM, and UTF-8 BOM. */
function decodeStatsBuf(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

/**
 * Google Play subscription state from financial-stats/subscriptions/ — daily
 * New / Cancelled / Active counts per SKU+country (monthly CSV files). We sum
 * across SKUs and countries per day. (No trial breakdown in this report.)
 * @returns {{ byDate: Record<string,{date,active,new,cancelled,trials}>, filesLoaded: string[] }}
 */
async function fetchPlaySubsDaily(brand, start, end) {
  const cfg = brandGoogleCfg(brand);
  if (!cfg.developerAccountId) throw new Error(`[Play ${brand}] missing GOOGLE_DEVELOPER_ACCOUNT_ID`);
  const auth = await googleAuthClient(brand, ['https://www.googleapis.com/auth/devstorage.read_only']);
  const storage = google.storage({ version: 'v1', auth });
  const bucket = `pubsite_prod_${cfg.developerAccountId}`;
  const months = monthsInRange(start, end);

  const list = await storage.objects.list({ bucket, prefix: 'financial-stats/subscriptions/' });
  const files = (list.data.items || []).filter((o) => months.some((m) => o.name.includes(`_${m}_`)));

  const byDate = {};
  const filesLoaded = [];
  for (const f of files) {
    const res = await storage.objects.get({ bucket, object: f.name, alt: 'media' }, { responseType: 'arraybuffer' });
    const lines = decodeStatsBuf(Buffer.from(res.data)).split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) continue;
    const headers = splitCsvLine(lines[0]).map((h) => h.trim());
    const iDate = headers.indexOf('Date');
    const iNew = headers.indexOf('New Subscriptions');
    const iCanc = headers.indexOf('Cancelled Subscriptions');
    const iAct = headers.indexOf('Active Subscriptions');
    if (iDate < 0 || iAct < 0) continue;
    for (let r = 1; r < lines.length; r++) {
      const c = splitCsvLine(lines[r]);
      const date = (c[iDate] || '').slice(0, 10);
      if (!date || date < start || date > end) continue;
      const d = byDate[date] || (byDate[date] = { date, active: 0, new: 0, cancelled: 0, trials: 0 });
      d.active += numCsv(c[iAct]);
      d.new += numCsv(c[iNew]);
      d.cancelled += numCsv(c[iCanc]);
    }
    filesLoaded.push(f.name);
  }
  return { byDate, filesLoaded };
}

module.exports = {
  brandGoogleCfg,
  googleAuthClient,
  listInAppProducts,
  fetchPlayEarningsDaily,
  fetchPlaySubsDaily,
  unzipFirst,
  monthsInRange,
};
