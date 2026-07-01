/**
 * Shopify Payments disputes/chargebacks ETL for KPI Pulse CB Rate rows.
 *
 * Source: Shopify Admin REST `/shopify_payments/disputes.json`.
 * Requires `read_shopify_payments_disputes` scope per store. Stores without the
 * scope are skipped with a warning; we do not fabricate zeros for those brands.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgQuery } = require('../db/postgres');

const STORES = [
  { brand: 'NOBL', key: 'NOBL_MAIN', shop: process.env.NOBL_SHOPIFY_SHOP, token: process.env.NOBL_SHOPIFY_TOKEN, fallbackRegion: null },
  { brand: 'NOBL', key: 'NOBL_EU',   shop: process.env.NOBL_EU_SHOPIFY_SHOP, token: process.env.NOBL_EU_SHOPIFY_TOKEN, fallbackRegion: 'EU' },
  { brand: 'NOBL', key: 'NOBL_UK',   shop: process.env.NOBL_UK_SHOPIFY_SHOP, token: process.env.NOBL_UK_SHOPIFY_TOKEN, fallbackRegion: 'UK' },
  { brand: 'FLO',  key: 'FLO_MAIN',  shop: process.env.FLO_SHOPIFY_SHOP, token: process.env.FLO_SHOPIFY_TOKEN, fallbackRegion: null },
  { brand: 'FLO',  key: 'FLO_EU',    shop: process.env.FLO_EU_SHOPIFY_SHOP, token: process.env.FLO_EU_SHOPIFY_TOKEN, fallbackRegion: 'EU' },
].filter(s => s.shop && s.token);

function addDays(s, n) { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function normShop(shop) { return String(shop || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); }
function regionFromCountry(cc, fallback = null) {
  const c = String(cc || '').toUpperCase().trim();
  if (['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(c)) return 'US';
  if (['CA', 'CANADA'].includes(c)) return 'CA';
  if (['AU', 'AUS', 'AUSTRALIA'].includes(c)) return 'AU';
  if (['GB', 'UK', 'UNITED KINGDOM'].includes(c)) return 'UK';
  return fallback || 'OTHER';
}

async function ensureTable() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS shopify_disputes_daily (
      brand TEXT NOT NULL,
      date DATE NOT NULL,
      dispute_count INT DEFAULT 0,
      chargeback_count INT DEFAULT 0,
      us_chargeback_count INT DEFAULT 0,
      ca_chargeback_count INT DEFAULT 0,
      au_chargeback_count INT DEFAULT 0,
      uk_chargeback_count INT DEFAULT 0,
      other_chargeback_count INT DEFAULT 0,
      dispute_amount NUMERIC(14,4) DEFAULT 0,
      chargeback_amount NUMERIC(14,4) DEFAULT 0,
      source TEXT DEFAULT 'shopify_payments_disputes',
      source_error TEXT,
      computed_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (brand, date)
    )
  `);
  await pgQuery(`CREATE INDEX IF NOT EXISTS idx_shopify_disputes_brand_date ON shopify_disputes_daily (brand, date DESC)`);
}

async function fetchStoreDisputes(store, start, end) {
  const shop = normShop(store.shop);
  let url = `https://${shop}/admin/api/2024-10/shopify_payments/disputes.json?initiated_at_min=${start}T00:00:00Z&initiated_at_max=${addDays(end, 1)}T00:00:00Z&limit=250`;
  const out = [];
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': store.token, 'Content-Type': 'application/json' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${store.key} Shopify disputes HTTP ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    out.push(...(body.disputes || []).map(d => ({ ...d, _storeKey: store.key, _fallbackRegion: store.fallbackRegion })));
    const link = res.headers.get('link') || '';
    const m = link.match(/<([^>]+)>; rel="next"/);
    url = m ? m[1] : null;
  }
  return out;
}

async function loadOrderRegions(brand, disputes) {
  const ids = [...new Set(disputes.map(d => String(d.order_id || '')).filter(Boolean))];
  if (!ids.length) return new Map();
  const gids = ids.map(id => `gid://shopify/Order/${id}`);
  const out = new Map();
  for (let i = 0; i < gids.length; i += 500) {
    const chunk = gids.slice(i, i + 500);
    const r = await pgQuery(
      `SELECT order_id, shipping_country FROM shopify_orders_raw WHERE brand=$1 AND order_id = ANY($2::text[])`,
      [brand, chunk]
    );
    for (const row of r.rows) out.set(String(row.order_id).replace('gid://shopify/Order/', ''), regionFromCountry(row.shipping_country));
  }
  return out;
}

async function upsertBrandRows(brand, byDate) {
  let written = 0;
  for (const [date, r] of byDate) {
    await pgQuery(`
      INSERT INTO shopify_disputes_daily
        (brand, date, dispute_count, chargeback_count, us_chargeback_count, ca_chargeback_count, au_chargeback_count, uk_chargeback_count, other_chargeback_count, dispute_amount, chargeback_amount, source_error, computed_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
      ON CONFLICT (brand, date) DO UPDATE SET
        dispute_count=EXCLUDED.dispute_count,
        chargeback_count=EXCLUDED.chargeback_count,
        us_chargeback_count=EXCLUDED.us_chargeback_count,
        ca_chargeback_count=EXCLUDED.ca_chargeback_count,
        au_chargeback_count=EXCLUDED.au_chargeback_count,
        uk_chargeback_count=EXCLUDED.uk_chargeback_count,
        other_chargeback_count=EXCLUDED.other_chargeback_count,
        dispute_amount=EXCLUDED.dispute_amount,
        chargeback_amount=EXCLUDED.chargeback_amount,
        source_error=EXCLUDED.source_error,
        updated_at=NOW()`,
      [brand, date, r.dispute_count, r.chargeback_count, r.US, r.CA, r.AU, r.UK, r.OTHER, r.dispute_amount, r.chargeback_amount, r.source_error || null]
    );
    written += 1;
  }
  return written;
}

async function runShopifyDisputes(opts = {}) {
  const start = opts.start;
  const end = opts.end || start;
  if (!start) throw new Error('runShopifyDisputes: start YYYY-MM-DD required');
  const commit = Boolean(opts.commit);
  const brands = opts.brands?.length ? opts.brands : ['NOBL', 'FLO'];
  await ensureTable();
  let totalWritten = 0;
  const summaries = [];

  for (const brand of brands) {
    const stores = STORES.filter(s => s.brand === brand);
    const disputes = [];
    const errors = [];
    for (const store of stores) {
      try {
        const rows = await fetchStoreDisputes(store, start, end);
        disputes.push(...rows);
        console.log(`[ShopifyDisputes] ${store.key}: ${rows.length} dispute(s)`);
      } catch (e) {
        errors.push(e.message);
        console.warn(`[ShopifyDisputes] ${e.message}`);
      }
    }
    const orderRegions = await loadOrderRegions(brand, disputes);
    const byDate = new Map();
    for (const d of disputes) {
      const date = String(d.initiated_at || '').slice(0, 10);
      if (!date || date < start || date > end) continue;
      if (!byDate.has(date)) byDate.set(date, { dispute_count: 0, chargeback_count: 0, US: 0, CA: 0, AU: 0, UK: 0, OTHER: 0, dispute_amount: 0, chargeback_amount: 0, source_error: errors.join('; ') });
      const row = byDate.get(date);
      const amount = Number(d.amount || 0);
      row.dispute_count += 1;
      row.dispute_amount += amount;
      if (String(d.type || '').toLowerCase() === 'chargeback') {
        row.chargeback_count += 1;
        row.chargeback_amount += amount;
        const region = orderRegions.get(String(d.order_id || '')) || regionFromCountry(null, d._fallbackRegion);
        row[region] = (row[region] || 0) + 1;
      }
    }
    summaries.push({ brand, rows: byDate.size, disputes: disputes.length, errors });
    if (commit) totalWritten += await upsertBrandRows(brand, byDate);
    else console.log(`[ShopifyDisputes] DRY ${brand}`, JSON.stringify([...byDate.entries()].slice(0, 5), null, 2));
  }
  return { rows: totalWritten, summaries };
}

module.exports = { runShopifyDisputes };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const brandFlag = argv.find(a => a.startsWith('--brand='));
  const dates = argv.filter(a => !a.startsWith('--'));
  const brands = brandFlag ? brandFlag.split('=')[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : undefined;
  runShopifyDisputes({ start: dates[0], end: dates[1] || dates[0], commit: flags.has('--commit'), brands })
    .then(r => { console.log('[ShopifyDisputes] done', JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('[ShopifyDisputes] FAILED', e.message); process.exit(1); });
}
