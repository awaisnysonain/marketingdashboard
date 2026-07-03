/**
 * Shopify orders ETL — fetches all orders from a NOBL/FLO Shopify store
 * via GraphQL with full line item + refund detail, and stores in
 * shopify_orders_raw with NOBL Air detection flags pre-computed
 * per the rules in the technical doc.
 *
 * Usage:
 *   const { syncShopifyOrders } = require('./shopifyOrders');
 *   await syncShopifyOrders('NOBL', '2026-04-01', '2026-04-30');
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { pgRun, pgQuery } = require('../db/postgres');

const STORE_CONFIG = {
  NOBL_MAIN: {
    brand: 'NOBL', store_key: 'NOBL_MAIN',
    shop_id: process.env.NOBL_SHOPIFY_SHOP, token: process.env.NOBL_SHOPIFY_TOKEN,
  },
  NOBL_UK: {
    brand: 'NOBL', store_key: 'NOBL_UK',
    shop_id: process.env.NOBL_UK_SHOPIFY_SHOP, token: process.env.NOBL_UK_SHOPIFY_TOKEN,
  },
  FLO_MAIN: {
    brand: 'FLO',  store_key: 'FLO_MAIN',
    shop_id: process.env.FLO_SHOPIFY_SHOP, token: process.env.FLO_SHOPIFY_TOKEN,
  },
  FLO_EU: {
    brand: 'FLO',  store_key: 'FLO_EU',
    shop_id: process.env.FLO_EU_SHOPIFY_SHOP, token: process.env.FLO_EU_SHOPIFY_TOKEN,
  },
};

// SKU rules from the technical doc
const NOBLAIR_PREFIX  = 'NOBLAIR';
const LUGGAGE_PREFIXES = ['ALL', 'DUO', 'METAL', 'FD', 'WB', 'EP'];
const TAG_PRICE_THRESHOLD = 15;   // < $15 = tag (hardware), >= $15 = sub

// Report timezone — ALL date keys are computed in this timezone, NOT UTC.
// Matches Brad's reportTz so dashboard dates align with the Apps Script report.
const SHOP_TIMEZONE = process.env.SHOP_TIMEZONE || 'America/New_York';

/**
 * Convert an ISO timestamp (UTC) into a YYYY-MM-DD date key in the shop's local
 * timezone. Without this, an order placed at 11:45 PM Toronto (= 3:45 AM UTC
 * next day) gets keyed to the wrong calendar date.
 */
function toLocalDateKey(isoTs, tz = SHOP_TIMEZONE) {
  if (!isoTs) return null;
  // 'en-CA' produces YYYY-MM-DD natively
  return new Date(isoTs).toLocaleDateString('en-CA', { timeZone: tz });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gql(shopId, token, query, variables = {}) {
  const url = `https://${shopId}/admin/api/2024-10/graphql.json`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (attempt === 5) throw e;
      await sleep(1500 * attempt); continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * attempt); continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(()=>'');
      throw new Error(`Shopify HTTP ${res.status}: ${t.slice(0,200)}`);
    }
    const json = await res.json();
    if (json.errors) {
      const msg = json.errors.map(e => e.message).join('; ');
      if (/throttle|cost/i.test(msg)) { await sleep(2000 * attempt); continue; }
      throw new Error('GraphQL: ' + msg);
    }
    return json.data;
  }
  throw new Error('Shopify GraphQL retries exhausted');
}

// Two query variants: with vs. without `customer` (FLO tokens lack read_customers scope)
const ORDERS_FIELDS = (withCustomer) => `
        id name createdAt
        displayFinancialStatus displayFulfillmentStatus
        currentTotalPriceSet  { shopMoney { amount } }
        currentSubtotalPriceSet { shopMoney { amount } }
        totalDiscountsSet     { shopMoney { amount } }
        totalTaxSet           { shopMoney { amount } }
        ${withCustomer ? 'customer { id email firstName lastName }' : ''}
        shippingAddress { country countryCodeV2 provinceCode city }
        lineItems(first: 50) { edges { node {
          title sku quantity
          originalUnitPriceSet   { shopMoney { amount } }
          discountedUnitPriceSet { shopMoney { amount } }
          totalDiscountSet       { shopMoney { amount } }
          sellingPlan { name }
        } } }
        refunds {
          id createdAt
          refundLineItems(first: 50) { edges { node {
            quantity
            subtotalSet { shopMoney { amount } }
            lineItem { sku title }
          } } }
        }`;

function buildQuery(withCustomer) {
  return `
  query Orders($cursor: String, $q: String!) {
    orders(first: 250, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges { node {
${ORDERS_FIELDS(withCustomer)}
      } }
    }
  }`;
}

// Cache: if we discover a token can't access customer, skip it on subsequent pages.
const customerScopeCache = {}; // storeKey → boolean

function classifyOrder(lineItems) {
  let hasAir = false, hasLuggage = false, hasPaidAir = false, hasZeroAir = false;
  let tagGross = 0, tagDisc = 0;
  let subGross = 0, subDisc = 0;
  for (const li of lineItems) {
    const sku = (li.sku || '').toUpperCase();
    const origPx = parseFloat(li.originalUnitPriceSet?.shopMoney?.amount || '0');
    const qty    = li.quantity || 0;
    const disc   = parseFloat(li.totalDiscountSet?.shopMoney?.amount || '0');
    if (sku.startsWith(NOBLAIR_PREFIX)) {
      hasAir = true;
      if (origPx > 0) hasPaidAir = true;
      else            hasZeroAir = true;
      // Tag vs sub split per doc: <$15 = tag, >=$15 = sub
      if (origPx < TAG_PRICE_THRESHOLD) {
        tagGross += origPx * qty;
        tagDisc  += disc;
      } else {
        subGross += origPx * qty;
        subDisc  += disc;
      }
    } else if (LUGGAGE_PREFIXES.some(p => sku.startsWith(p))) {
      hasLuggage = true;
    }
  }
  return {
    has_air: hasAir, has_luggage: hasLuggage,
    has_paid_air: hasPaidAir, has_zero_air: hasZeroAir,
    is_rebill: hasAir && !hasLuggage,
    tag_gross: tagGross, tag_discounts: tagDisc,
    sub_gross: subGross, sub_discounts: subDisc,
  };
}

function classifyRefunds(refunds) {
  let tagRef = 0, subRef = 0;
  for (const r of refunds) {
    for (const e of r.refundLineItems?.edges || []) {
      const li = e.node;
      const sku = (li.lineItem?.sku || '').toUpperCase();
      const amt = parseFloat(li.subtotalSet?.shopMoney?.amount || '0');
      if (!sku.startsWith(NOBLAIR_PREFIX)) continue;
      // Use the line item's sku — we don't have origPx on refund line, but refunds are ~95%
      // sub-side anyway. For accuracy, we'd need to back-fetch the originating line item;
      // the doc accepts using the refund subtotal directly for most use cases.
      // Heuristic: if amount > $15, classify as sub refund. Otherwise tag.
      if (amt >= TAG_PRICE_THRESHOLD) subRef += amt;
      else                            tagRef += amt;
    }
  }
  return { tag_refunds: tagRef, sub_refunds: subRef };
}

// Single multi-row INSERT for an entire page (250 orders) — one round trip
// instead of 250. Cuts wall time roughly 10x for the DB-write portion.
async function batchInsertOrders(rows, brand, storeKey, shopId) {
  if (rows.length === 0) return 0;
  const COLS_PER_ROW = 33; // count of $-params per row below
  const valueClauses = [];
  const params = [];
  let p = 1;
  for (const o of rows) {
    const lineItems = o.lineItems.edges.map(le => le.node);
    const flags = classifyOrder(lineItems);
    const refunds = o.refunds || [];
    const refSplit = classifyRefunds(refunds);
    const dateKey = toLocalDateKey(o.createdAt);  // America/Toronto local date
    const cust = o.customer || {};
    const ship = o.shippingAddress || {};

    const ph = [];
    for (let i = 0; i < COLS_PER_ROW; i++) ph.push('$' + (p++));
    // Replace last 3 placeholders with ::jsonb casts
    ph[30] = ph[30] + '::jsonb'; // line_items
    ph[31] = ph[31] + '::jsonb'; // refunds
    ph[32] = ph[32] + '::jsonb'; // raw_json
    valueClauses.push(`(${ph.join(',')}, NOW(), NOW())`);

    params.push(
      brand, storeKey, shopId,
      o.id, o.name, o.createdAt, dateKey,
      cust.id || null, cust.email || null,
      [cust.firstName, cust.lastName].filter(Boolean).join(' ') || null,
      parseFloat(o.currentTotalPriceSet?.shopMoney?.amount || '0'),
      parseFloat(o.currentSubtotalPriceSet?.shopMoney?.amount || '0'),
      parseFloat(o.totalDiscountsSet?.shopMoney?.amount || '0'),
      parseFloat(o.totalTaxSet?.shopMoney?.amount || '0'),
      ship.countryCodeV2 || ship.country || null,
      ship.provinceCode || null,
      ship.city || null,
      o.displayFinancialStatus || null,
      o.displayFulfillmentStatus || null,
      flags.has_air, flags.has_luggage, flags.is_rebill,
      flags.has_paid_air, flags.has_zero_air,
      flags.tag_gross, flags.tag_discounts, refSplit.tag_refunds,
      flags.sub_gross, flags.sub_discounts, refSplit.sub_refunds,
      JSON.stringify(lineItems),
      JSON.stringify(refunds),
      JSON.stringify(o),
    );
  }
  const sql = `
    INSERT INTO shopify_orders_raw (
      brand, store_key, shop_id, order_id, order_name, created_at, date_key,
      customer_id, customer_email, customer_name,
      total_price, subtotal_price, total_discounts, total_tax,
      shipping_country, shipping_state, shipping_city,
      financial_status, fulfillment_status,
      has_air, has_luggage, is_rebill, has_paid_air, has_zero_air,
      tag_gross, tag_discounts, tag_refunds,
      sub_gross, sub_discounts, sub_refunds,
      line_items, refunds, raw_json, fetched_at, updated_at
    ) VALUES ${valueClauses.join(', ')}
    ON CONFLICT (brand, order_id) DO UPDATE SET
      total_price = EXCLUDED.total_price,
      subtotal_price = EXCLUDED.subtotal_price,
      total_discounts = EXCLUDED.total_discounts,
      financial_status = EXCLUDED.financial_status,
      fulfillment_status = EXCLUDED.fulfillment_status,
      has_air = EXCLUDED.has_air,
      has_luggage = EXCLUDED.has_luggage,
      is_rebill = EXCLUDED.is_rebill,
      has_paid_air = EXCLUDED.has_paid_air,
      has_zero_air = EXCLUDED.has_zero_air,
      tag_gross = EXCLUDED.tag_gross,
      tag_discounts = EXCLUDED.tag_discounts,
      tag_refunds = EXCLUDED.tag_refunds,
      sub_gross = EXCLUDED.sub_gross,
      sub_discounts = EXCLUDED.sub_discounts,
      sub_refunds = EXCLUDED.sub_refunds,
      line_items = EXCLUDED.line_items,
      refunds = EXCLUDED.refunds,
      updated_at = NOW()
  `;
  await pgRun(sql, params);
  return rows.length;
}

async function fetchOrdersForRange(storeKey, startDate, endDate) {
  const cfg = STORE_CONFIG[storeKey];
  if (!cfg?.shop_id || !cfg?.token) throw new Error(`Missing config for ${storeKey}`);

  const q = `created_at:>=${startDate} AND created_at:<=${endDate}`;
  let cursor = null;
  let pages = 0;
  let totalSeen = 0, written = 0;

  // Use cached scope decision; default to "with customer" (will fall back on first failure)
  let withCustomer = customerScopeCache[storeKey] !== false;

  while (true) {
    let data;
    try {
      data = await gql(cfg.shop_id, cfg.token, buildQuery(withCustomer), { cursor, q });
    } catch (e) {
      // If denied on customer scope, fall back without customer for the rest of this run
      if (withCustomer && /Access denied for customer/i.test(e.message)) {
        console.warn(`  ${storeKey}: token lacks read_customers — falling back to no-customer query`);
        withCustomer = false;
        customerScopeCache[storeKey] = false;
        continue; // retry same page without customer
      }
      throw e;
    }
    pages++;
    const edges = data.orders.edges;
    const orders = edges.map(e => e.node);
    totalSeen += orders.length;
    try {
      written += await batchInsertOrders(orders, cfg.brand, cfg.store_key, cfg.shop_id);
    } catch (e) {
      console.error(`  batch insert err [${cfg.store_key} ${startDate}..${endDate} page ${pages}]: ${e.message}`);
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
    await sleep(120);
    if (pages >= 600) {
      console.warn(`  ⚠ Page cap (600) hit for ${storeKey} ${startDate}..${endDate}`);
      break;
    }
  }
  return { pages, totalSeen, written };
}

/**
 * Sync orders for a brand (NOBL or FLO) over [startDate, endDate].
 * For NOBL → NOBL_MAIN + optional NOBL_UK. For FLO → FLO_MAIN + FLO_EU.
 */
async function syncShopifyOrders(brand, startDate, endDate) {
  const stores = (brand === 'NOBL' ? ['NOBL_MAIN', 'NOBL_UK'] : ['FLO_MAIN', 'FLO_EU'])
    .filter((storeKey) => STORE_CONFIG[storeKey]?.shop_id && STORE_CONFIG[storeKey]?.token);
  const out = { rows: 0, errors: [], byStore: {} };
  for (const storeKey of stores) {
    try {
      const r = await fetchOrdersForRange(storeKey, startDate, endDate);
      out.byStore[storeKey] = r;
      out.rows += r.written;
    } catch (e) {
      out.errors.push(`${storeKey}: ${e.message}`);
    }
  }
  return out;
}

module.exports = { syncShopifyOrders, fetchOrdersForRange, classifyOrder };
