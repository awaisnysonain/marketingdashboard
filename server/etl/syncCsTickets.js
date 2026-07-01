/**
 * CS Tickets ETL — JS port of may20_region_counts_uk_fallback.js (the reference
 * script the user provided). For each UTC day in the requested window:
 *
 *   1. Pull conversations from MongoDB (crmdb for NOBL, flodb for FLO) created
 *      in that day.
 *   2. Pull each conversation's messages to extract orderNos / phone candidates.
 *   3. Cascade-match each ticket to a Shopify order/customer to learn its region:
 *        orderNo → email-last-order → email-customer → phone-last-order
 *        → phone-customer.
 *      For NOBL, the NOBL_SHOPIFY_UK store acts as a UK fallback (matched
 *      tickets there are tagged region='uk').
 *   4. Aggregate per (brand, day): total_tickets, shopify_matched, region split,
 *      match-method counts, and effective_closed_tickets from
 *      hourly_agent_performance_conversations.
 *   5. Upsert into dashboard.cs_tickets_daily.
 *
 * Default is DRY RUN. Pass `--commit` (or commit:true) to persist.
 *
 * Expects the SSH tunnels from prod to be live:
 *   - mongodb://127.0.0.1:27018 → crmdb (NOBL)
 *   - mongodb://127.0.0.1:27019 → flodb (FLO)
 *
 * .env vars consumed (with sensible defaults that match the reference script):
 *   CS_NOBL_MONGO_URI / CS_MONGO_URI   - NOBL Mongo URI through the crmdb tunnel
 *   CS_FLO_MONGO_URI                   - FLO Mongo URI through the flodb tunnel
 *   NOBL_SHOPIFY_*, NOBL_EU_SHOPIFY_*, NOBL_UK_SHOPIFY_*, FLO_SHOPIFY_*,
 *   FLO_EU_SHOPIFY_*                   - reused from the dashboard's other ETL
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { MongoClient } = require('mongodb');
const { pgQuery } = require('../db/postgres');

// ── Config ───────────────────────────────────────────────────────────────────

const NOBL_DEFAULT_MONGO = '';
const FLO_DEFAULT_MONGO  = '';

const SHOPIFY_GQL_FALLBACK_API_VERSION = '2025-10';
const NOBL_SHOPIFY_UK_STORE_KEY = 'NOBL_SHOPIFY_UK';

const SHOPIFY = {
  NOBL_SHOPIFY: {
    store: (process.env.NOBL_SHOPIFY_SHOP || 'nobltravel.myshopify.com').replace('.myshopify.com', ''),
    token: process.env.NOBL_SHOPIFY_TOKEN,
    apiVersion: '2024-10',
  },
  NOBL_SHOPIFY_EU: {
    store: (process.env.NOBL_EU_SHOPIFY_SHOP || 'afmjag-r2.myshopify.com').replace('.myshopify.com', ''),
    token: process.env.NOBL_EU_SHOPIFY_TOKEN,
    apiVersion: '2024-10',
  },
  NOBL_SHOPIFY_UK: {
    store: (process.env.NOBL_UK_SHOPIFY_SHOP || 'wdwzan-tc.myshopify.com').replace('.myshopify.com', ''),
    token: process.env.NOBL_UK_SHOPIFY_TOKEN,
    apiVersion: '2024-10',
    gqlApiVersion: '2025-10',
  },
  FLO_SHOPIFY: {
    store: (process.env.FLO_SHOPIFY_SHOP || 'a56ba5-6f.myshopify.com').replace('.myshopify.com', ''),
    token: process.env.FLO_SHOPIFY_TOKEN,
    apiVersion: '2024-10',
  },
};

function getDbConfigs() {
  return [
    {
      label: 'crmdb',
      brand: 'NOBL',
      uri: process.env.CS_NOBL_MONGO_URI || process.env.CS_MONGO_URI || NOBL_DEFAULT_MONGO,
      shopifyStores: ['NOBL_SHOPIFY', 'NOBL_SHOPIFY_EU'],
      ukFallbackStores: [NOBL_SHOPIFY_UK_STORE_KEY],
    },
    {
      label: 'flodb',
      brand: 'FLO',
      uri: process.env.CS_FLO_MONGO_URI || FLO_DEFAULT_MONGO,
      shopifyStores: ['FLO_SHOPIFY'],
      ukFallbackStores: [],
    },
  ];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function utcDayWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end   = new Date(Date.UTC(y, m - 1, d + 1));
  return { start, end };
}

function stripHtml(text) {
  return String(text || '').replace(/&nbsp;/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function extractOrderNos(text) {
  const clean = stripHtml(text);
  const found = new Set();
  const patterns = [
    /order\s*(?:number|no\.?|#|id)?\s*[:#-]?\s*(\d{5,7})/gi,
    /order\s*(?:number|no\.?|id)?\s*[:#-]?\s*#(\d{5,7})/gi,
    /#(\d{5,7})/g,
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(clean))) found.add(`#${m[1]}`);
  }
  return [...found];
}

function normalizeEmail(email) {
  const n = String(email || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(n) ? n : null;
}

function extractPhoneCandidates(...values) {
  const phones = new Set();
  const addPhone = (v) => {
    const text = String(v || '');
    const matches = text.match(/\+?\d[\d\s().-]{7,}\d/g) || [];
    for (const match of matches) {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) continue;
      if (digits.length === 10) {
        phones.add(`+1${digits}`); phones.add(digits);
      } else if (digits.length === 11 && digits.startsWith('1')) {
        phones.add(`+${digits}`); phones.add(digits.slice(1));
      } else {
        phones.add(`+${digits}`); phones.add(digits);
      }
    }
  };
  for (const v of values) addPhone(v);
  return [...phones];
}

function phoneDigitAliases(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return [];
  const aliases = new Set([digits]);
  if (digits.length === 10) aliases.add(`1${digits}`);
  if (digits.length === 11 && digits.startsWith('1')) aliases.add(digits.slice(1));
  return [...aliases];
}

function nodeHasPhone(node, searchPhone) {
  const searchAliases = new Set(phoneDigitAliases(searchPhone));
  if (!searchAliases.size) return false;
  return [
    node?.phone,
    node?.shippingAddress?.phone,
    node?.billingAddress?.phone,
  ].some((v) => phoneDigitAliases(v).some((a) => searchAliases.has(a)));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchWithRetry(url, options, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if (res.ok || ![408, 425, 429, 500, 502, 503, 504].includes(res.status) || attempt === attempts) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
      if (attempt === attempts) throw e;
    }
    await sleep(750 * attempt);
  }
  throw lastError || new Error('fetch failed');
}

function regionFromCountryCode(cc) {
  const c = String(cc || '').toUpperCase();
  if (c === 'US') return 'us';
  if (c === 'AU') return 'au';
  if (c === 'CA') return 'ca';
  if (c === 'GB' || c === 'UK') return 'uk';
  return 'other';
}

function regionFromShopifyMatch(storeKey, countryCode) {
  if (storeKey === NOBL_SHOPIFY_UK_STORE_KEY) return 'uk';
  return regionFromCountryCode(countryCode);
}

function storeKeyToRawStoreKeys(storeKey) {
  return {
    NOBL_SHOPIFY: ['NOBL_MAIN'],
    NOBL_SHOPIFY_EU: ['NOBL_EU'],
    NOBL_SHOPIFY_UK: ['NOBL_UK'],
    FLO_SHOPIFY: ['FLO_MAIN', 'FLO_EU'],
  }[storeKey] || [];
}

function brandFromStoreKeys(storeKeys) {
  return storeKeys.some(k => String(k).startsWith('FLO')) ? 'FLO' : 'NOBL';
}

function toShopifyMatch(storeKey, node, matchMethod, searchValue) {
  if (!node) return null;
  const cc = node.shippingAddress?.countryCodeV2 || node.billingAddress?.countryCodeV2 || null;
  return {
    store: storeKey, matchMethod, searchValue,
    orderName: node.name, shopifyOrderId: node.id,
    orderCreatedAt: node.createdAt || null,
    country: node.shippingAddress?.country || node.billingAddress?.country || null,
    countryCode: cc,
    region: regionFromShopifyMatch(storeKey, cc),
  };
}

function toDbShopifyMatch(storeKey, row, matchMethod, searchValue) {
  if (!row) return null;
  const cc = row.shipping_country || null;
  return {
    store: storeKey,
    matchMethod,
    searchValue,
    orderName: row.order_name,
    shopifyOrderId: row.order_id,
    orderCreatedAt: row.created_at || null,
    country: row.shipping_country || null,
    countryCode: cc,
    region: regionFromShopifyMatch(storeKey, cc),
  };
}

function toShopifyCustomerMatch(storeKey, node, matchMethod, searchValue) {
  if (!node?.defaultAddress) return null;
  const cc = node.defaultAddress.countryCodeV2 || null;
  return {
    store: storeKey, matchMethod, searchValue,
    shopifyCustomerId: node.id,
    customerEmail: node.email || null, customerPhone: node.phone || null,
    country: node.defaultAddress.country || null, countryCode: cc,
    region: regionFromShopifyMatch(storeKey, cc),
  };
}

function mergeFirstMatch(...maps) {
  const merged = new Map();
  for (const map of maps) for (const [k, v] of map) if (!merged.has(k)) merged.set(k, v);
  return merged;
}

function isUnavailableShopifyStoreError(e) {
  return /Shopify HTTP (401|403|404)\b/.test(String(e?.message || e));
}

function isTransientShopifyStoreError(e) {
  return /fetch failed|ECONN|ETIMEDOUT|timeout|aborted|Shopify HTTP (408|425|429|500|502|503|504)\b/i.test(String(e?.message || e));
}

// ── Shopify GraphQL helpers ──────────────────────────────────────────────────

async function shopifyGraphql(storeKey, query) {
  const config = SHOPIFY[storeKey];
  if (!config?.token) throw new Error(`${storeKey} Shopify token missing in env`);
  const apiVersions = [...new Set([config.gqlApiVersion, config.apiVersion, SHOPIFY_GQL_FALLBACK_API_VERSION].filter(Boolean))];
  let lastError = null;
  for (const apiVersion of apiVersions) {
    const res = await fetchWithRetry(`https://${config.store}.myshopify.com/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.token },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      lastError = new Error(`${storeKey} Shopify HTTP ${res.status} on ${apiVersion}`);
      if (res.status === 404 && apiVersion !== apiVersions[apiVersions.length - 1]) continue;
      throw lastError;
    }
    const payload = await res.json();
    if (payload.errors) throw new Error(`${storeKey} Shopify error: ${payload.errors.map((e) => e.message).join('; ')}`);
    return payload.data;
  }
  throw lastError || new Error(`${storeKey} Shopify request failed`);
}

async function runStoreLookup(storeKey, label, fn, fallback) {
  try { return await fn(); }
  catch (e) {
    if (!isUnavailableShopifyStoreError(e) && !isTransientShopifyStoreError(e)) throw e;
    console.warn(`[CsTickets] Skipping ${storeKey} ${label}: ${e.message}`);
    return fallback;
  }
}

async function lookupOrdersByNameFromDb(storeKey, orderNos) {
  const results = new Map();
  const unique = [...new Set(orderNos)].filter(Boolean);
  const lookupNames = [...new Set(unique.flatMap(n => {
    const s = String(n || '').trim();
    return s.startsWith('#') ? [s, s.slice(1)] : [s, `#${s}`];
  }))].filter(Boolean);
  const rawStores = storeKeyToRawStoreKeys(storeKey);
  if (!lookupNames.length || !rawStores.length) return results;
  for (let i = 0; i < lookupNames.length; i += 500) {
    const batch = lookupNames.slice(i, i + 500);
    const r = await pgQuery(`
      SELECT DISTINCT ON (order_name) order_name, order_id, created_at, shipping_country
      FROM shopify_orders_raw
      WHERE brand=$1 AND store_key = ANY($2::text[]) AND order_name = ANY($3::text[])
      ORDER BY order_name, created_at DESC
    `, [brandFromStoreKeys([storeKey]), rawStores, batch]);
    for (const row of r.rows) {
      const match = toDbShopifyMatch(storeKey, row, 'orderNoDb', row.order_name);
      results.set(row.order_name, match);
      results.set(String(row.order_name || '').replace(/^#/, ''), match);
    }
  }
  return results;
}

async function lookupLastOrdersByEmailFromDb(storeKey, emails) {
  const results = new Map();
  const unique = [...new Set(emails.map(e => String(e || '').trim().toLowerCase()))].filter(Boolean);
  const rawStores = storeKeyToRawStoreKeys(storeKey);
  if (!unique.length || !rawStores.length) return results;
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const r = await pgQuery(`
      SELECT DISTINCT ON (lower(customer_email)) lower(customer_email) email_key, order_name, order_id, created_at, shipping_country
      FROM shopify_orders_raw
      WHERE brand=$1 AND store_key = ANY($2::text[]) AND lower(customer_email) = ANY($3::text[])
      ORDER BY lower(customer_email), created_at DESC
    `, [brandFromStoreKeys([storeKey]), rawStores, batch]);
    for (const row of r.rows) results.set(row.email_key, toDbShopifyMatch(storeKey, row, 'emailLastOrderDb', row.email_key));
  }
  return results;
}

async function lookupOrdersByName(storeKey, orderNos) {
  const results = new Map();
  const unique = [...new Set(orderNos)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 25) {
    const batch = unique.slice(i, i + 25);
    const body = batch.map((no, idx) =>
      `o${idx}: orders(first: 1, query: ${JSON.stringify(`name:${no}`)}) { edges { node { id name createdAt shippingAddress { country countryCodeV2 } billingAddress { country countryCodeV2 } } } }`
    ).join('\n');
    const data = await shopifyGraphql(storeKey, `query { ${body} }`);
    batch.forEach((no, idx) => {
      const n = data[`o${idx}`]?.edges?.[0]?.node;
      if (n) results.set(no, toShopifyMatch(storeKey, n, 'orderNo', no));
    });
  }
  return results;
}

async function lookupLastOrdersByEmail(storeKey, emails) {
  const results = new Map();
  const unique = [...new Set(emails)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    const body = batch.map((email, idx) =>
      `e${idx}: orders(first: 1, query: ${JSON.stringify(`email:${email}`)}, sortKey: CREATED_AT, reverse: true) { edges { node { id name createdAt shippingAddress { country countryCodeV2 } billingAddress { country countryCodeV2 } } } }`
    ).join('\n');
    const data = await shopifyGraphql(storeKey, `query { ${body} }`);
    batch.forEach((email, idx) => {
      const n = data[`e${idx}`]?.edges?.[0]?.node;
      if (n) results.set(email, toShopifyMatch(storeKey, n, 'emailLastOrder', email));
    });
  }
  return results;
}

async function lookupCustomersByEmail(storeKey, emails) {
  const results = new Map();
  const unique = [...new Set(emails)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    const body = batch.map((email, idx) =>
      `c${idx}: customers(first: 1, query: ${JSON.stringify(`email:${email}`)}) { edges { node { id email phone defaultAddress { country countryCodeV2 } } } }`
    ).join('\n');
    let data;
    try { data = await shopifyGraphql(storeKey, `query { ${body} }`); }
    catch (e) { if (String(e.message).includes('Access denied for customers field')) return results; throw e; }
    batch.forEach((email, idx) => {
      const n = data[`c${idx}`]?.edges?.[0]?.node;
      const m = toShopifyCustomerMatch(storeKey, n, 'emailCustomerDefaultAddress', email);
      if (m) results.set(email, m);
    });
  }
  return results;
}

async function lookupLastOrdersByPhone(storeKey, phones) {
  const verified = new Map(), lowConfidence = new Map();
  const unique = [...new Set(phones)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    const body = batch.map((phone, idx) =>
      `p${idx}: orders(first: 5, query: ${JSON.stringify(`phone:${phone}`)}, sortKey: CREATED_AT, reverse: true) { edges { node { id name createdAt phone shippingAddress { phone country countryCodeV2 } billingAddress { phone country countryCodeV2 } } } }`
    ).join('\n');
    const data = await shopifyGraphql(storeKey, `query { ${body} }`);
    batch.forEach((phone, idx) => {
      const nodes = data[`p${idx}`]?.edges?.map((e) => e.node) || [];
      const vNode = nodes.find((n) => nodeHasPhone(n, phone));
      if (vNode) verified.set(phone, toShopifyMatch(storeKey, vNode, 'phoneLastOrder', phone));
      else if (nodes[0]) lowConfidence.set(phone, toShopifyMatch(storeKey, nodes[0], 'phoneLastOrderLowConfidence', phone));
    });
  }
  return { verified, lowConfidence };
}

async function lookupCustomersByPhone(storeKey, phones) {
  const results = new Map();
  const unique = [...new Set(phones)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    const body = batch.map((phone, idx) =>
      `c${idx}: customers(first: 1, query: ${JSON.stringify(`phone:${phone}`)}) { edges { node { id email phone defaultAddress { country countryCodeV2 } } } }`
    ).join('\n');
    let data;
    try { data = await shopifyGraphql(storeKey, `query { ${body} }`); }
    catch (e) { if (String(e.message).includes('Access denied for customers field')) return results; throw e; }
    batch.forEach((phone, idx) => {
      const n = data[`c${idx}`]?.edges?.[0]?.node;
      const m = toShopifyCustomerMatch(storeKey, n, 'phoneCustomerDefaultAddress', phone);
      if (m) results.set(phone, m);
    });
  }
  return results;
}

// ── Mongo ────────────────────────────────────────────────────────────────────

async function getTicketsFromMongo(dbConfig, start, end) {
  if (!dbConfig.uri) throw new Error(`${dbConfig.label} Mongo URI missing; set ${dbConfig.brand === 'NOBL' ? 'CS_NOBL_MONGO_URI/CS_MONGO_URI' : 'CS_FLO_MONGO_URI'} and ensure the SSH tunnel is running`);
  const client = new MongoClient(dbConfig.uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const db = client.db();
    const conversations = await db.collection('conversations').find(
      { createdAt: { $gte: start, $lt: end } },
      { projection: { _id: 1, title: 1, customerEmail: 1, phoneNumber: 1, brandId: 1, createdAt: 1, metadata: 1 } }
    ).toArray();

    const ticketsByConversation = new Map(conversations.map((c) => [String(c._id), {
      database: dbConfig.label,
      conversationId: String(c._id),
      title: c.title || null,
      customerEmail: normalizeEmail(c.customerEmail),
      phoneCandidates: new Set(extractPhoneCandidates(
        c.phoneNumber, c.metadata?.phoneNumber, c.metadata?.customerPhone,
        c.metadata?.customerFormData?.phone, c.metadata?.customerFormData?.phoneNumber,
        c.title,
      )),
      brandId: c.brandId ? String(c.brandId) : null,
      createdAt: c.createdAt || null,
      orderNos: new Set(),
    }]));

    const conversationIds = conversations.flatMap((c) => [c._id, String(c._id)]);
    for (let i = 0; i < conversationIds.length; i += 500) {
      const messages = await db.collection('messages').find(
        { conversationId: { $in: conversationIds.slice(i, i + 500) } },
        { projection: { conversationId: 1, text: 1, 'emailData.subject': 1, 'emailData.htmlBody': 1, 'emailData.from': 1 } }
      ).toArray();
      for (const m of messages) {
        const t = ticketsByConversation.get(String(m.conversationId));
        if (!t) continue;
        const text = [m.text, m.emailData?.subject, m.emailData?.htmlBody].filter(Boolean).join(' ');
        for (const o of extractOrderNos(text)) t.orderNos.add(o);
        for (const p of extractPhoneCandidates(m.emailData?.from, m.emailData?.subject)) t.phoneCandidates.add(p);
      }
    }

    return [...ticketsByConversation.values()].map((t) => ({
      ...t,
      orderNos: [...t.orderNos],
      phoneCandidates: [...t.phoneCandidates],
    }));
  } finally {
    await client.close();
  }
}

/**
 * Effective + attempted closes for a UTC day window, from
 * hourly_agent_performance_conversations.
 */
async function getClosedCountsFromMongo(dbConfig, start, end) {
  if (!dbConfig.uri) throw new Error(`${dbConfig.label} Mongo URI missing; set ${dbConfig.brand === 'NOBL' ? 'CS_NOBL_MONGO_URI/CS_MONGO_URI' : 'CS_FLO_MONGO_URI'} and ensure the SSH tunnel is running`);
  const client = new MongoClient(dbConfig.uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const db = client.db();
    const [row] = await db.collection('hourly_agent_performance_conversations').aggregate([
      { $addFields: {
          hourStartDate: {
            $switch: {
              branches: [
                { case: { $eq: [{ $type: '$hourStartUTC' }, 'date'] }, then: '$hourStartUTC' },
                { case: { $eq: [{ $type: '$hourStartUTC' }, 'string'] },
                  then: { $dateFromString: { dateString: '$hourStartUTC', onError: null, onNull: null } } },
              ],
              default: null,
            },
          },
      } },
      { $match: { hourStartDate: { $gte: start, $lt: end } } },
      { $group: {
          _id: null,
          effective: { $sum: { $ifNull: ['$effectiveClose', 0] } },
          attempted: { $sum: { $ifNull: ['$attemptedClose', 0] } },
      } },
    ]).toArray();
    return {
      effective: Number(row?.effective || 0),
      attempted: Number(row?.attempted || 0),
    };
  } finally {
    await client.close();
  }
}

// ── Cascade matching (mirrors matchTicketsToShopify in the reference) ────────

async function matchTicketsToShopify(tickets, storeKeys) {
  // Stage 1: order-name match
  const orderNos = [...new Set(tickets.flatMap((t) => t.orderNos))];
  const orderMaps = [];
  let remainingOrderNos = orderNos;
  for (const sk of storeKeys) {
    const db = await lookupOrdersByNameFromDb(sk, remainingOrderNos);
    orderMaps.push(db);
    remainingOrderNos = remainingOrderNos.filter((n) => !db.has(n));
    const m = await runStoreLookup(sk, 'order lookup', () => lookupOrdersByName(sk, remainingOrderNos), new Map());
    orderMaps.push(m);
    remainingOrderNos = remainingOrderNos.filter((n) => !m.has(n));
  }
  const orderMatches = mergeFirstMatch(...orderMaps);
  let afterOrder = tickets.map((t) => ({
    ...t,
    shopify: t.orderNos.map((n) => orderMatches.get(n)).find(Boolean) || null,
  }));

  // Stage 2: email-last-order
  const emailLastMaps = [];
  let remainingEmails = [...new Set(afterOrder.filter((t) => !t.shopify).map((t) => t.customerEmail))].filter(Boolean);
  for (const sk of storeKeys) {
    const db = await lookupLastOrdersByEmailFromDb(sk, remainingEmails);
    emailLastMaps.push(db);
    remainingEmails = remainingEmails.filter((e) => !db.has(String(e || '').trim().toLowerCase()));
    const m = await runStoreLookup(sk, 'email order lookup', () => lookupLastOrdersByEmail(sk, remainingEmails), new Map());
    emailLastMaps.push(m);
    remainingEmails = remainingEmails.filter((e) => !m.has(e));
  }
  const emailLast = mergeFirstMatch(...emailLastMaps);
  let afterEmailLast = afterOrder.map((t) => t.shopify ? t : { ...t, shopify: emailLast.get(t.customerEmail) || emailLast.get(String(t.customerEmail || '').trim().toLowerCase()) || null });

  // Stage 3: email-customer-default-address
  const emailCustMaps = [];
  remainingEmails = [...new Set(afterEmailLast.filter((t) => !t.shopify).map((t) => t.customerEmail))].filter(Boolean);
  for (const sk of storeKeys) {
    const m = await runStoreLookup(sk, 'email customer lookup', () => lookupCustomersByEmail(sk, remainingEmails), new Map());
    emailCustMaps.push(m);
    remainingEmails = remainingEmails.filter((e) => !m.has(e));
  }
  const emailCust = mergeFirstMatch(...emailCustMaps);
  let afterEmailCust = afterEmailLast.map((t) => t.shopify ? t : { ...t, shopify: emailCust.get(t.customerEmail) || null });

  // Stage 4: phone-last-order
  const phoneOrderMaps = [], phoneLowMaps = [];
  let remainingPhones = [...new Set(afterEmailCust.filter((t) => !t.shopify).flatMap((t) => t.phoneCandidates))].filter(Boolean);
  for (const sk of storeKeys) {
    const r = await runStoreLookup(sk, 'phone order lookup', () => lookupLastOrdersByPhone(sk, remainingPhones), { verified: new Map(), lowConfidence: new Map() });
    phoneOrderMaps.push(r.verified);
    phoneLowMaps.push(r.lowConfidence);
    remainingPhones = remainingPhones.filter((p) => !r.verified.has(p));
  }
  const phoneOrder = mergeFirstMatch(...phoneOrderMaps);
  const phoneLow   = mergeFirstMatch(...phoneLowMaps);
  let afterPhoneOrder = afterEmailCust.map((t) => t.shopify ? t : {
    ...t,
    shopify: t.phoneCandidates.map((p) => phoneOrder.get(p)).find(Boolean) || null,
    lowConfidenceShopify: t.phoneCandidates.map((p) => phoneLow.get(p)).find(Boolean) || null,
  });

  // Stage 5: phone-customer-default-address
  const phoneCustMaps = [];
  remainingPhones = [...new Set(afterPhoneOrder.filter((t) => !t.shopify).flatMap((t) => t.phoneCandidates))].filter(Boolean);
  for (const sk of storeKeys) {
    const m = await runStoreLookup(sk, 'phone customer lookup', () => lookupCustomersByPhone(sk, remainingPhones), new Map());
    phoneCustMaps.push(m);
    remainingPhones = remainingPhones.filter((p) => !m.has(p));
  }
  const phoneCust = mergeFirstMatch(...phoneCustMaps);
  return afterPhoneOrder.map((t) => {
    if (t.shopify) return t;
    const sh = t.phoneCandidates.map((p) => phoneCust.get(p)).find(Boolean) || null;
    if (!sh) return t;
    const { lowConfidenceShopify, ...rest } = t;
    return { ...rest, shopify: sh };
  });
}

async function matchUnmatchedToUk(tickets, storeKeys) {
  if (!storeKeys.length) return tickets;
  const unmatched = tickets.filter((t) => !t.shopify);
  if (!unmatched.length) return tickets;
  const rematched = await matchTicketsToShopify(unmatched, storeKeys);
  const byId = new Map(rematched.map((t) => [t.conversationId, t]));
  return tickets.map((t) => t.shopify ? t : byId.get(t.conversationId) || t);
}

// ── Aggregation per (brand, date) ───────────────────────────────────────────

function aggregateCounts(brand, date, tickets, closed) {
  const counts = {
    brand, date,
    total_tickets: 0,
    shopify_matched: 0,
    order_matched: 0,
    email_fallback_matched: 0,
    email_customer_matched: 0,
    phone_order_matched: 0,
    phone_order_low_confidence: 0,
    phone_customer_matched: 0,
    us_tickets: 0, ca_tickets: 0, au_tickets: 0, uk_tickets: 0,
    other_tickets: 0, unmatched_tickets: 0,
    effective_closed_tickets: closed.effective,
    attempted_closed_tickets: closed.attempted,
  };
  for (const t of tickets) {
    counts.total_tickets += 1;
    if (t.lowConfidenceShopify?.matchMethod === 'phoneLastOrderLowConfidence') counts.phone_order_low_confidence += 1;
    if (!t.shopify) { counts.unmatched_tickets += 1; continue; }
    counts.shopify_matched += 1;
    switch (t.shopify.matchMethod) {
      case 'orderNo': counts.order_matched += 1; break;
      case 'emailLastOrder': counts.email_fallback_matched += 1; break;
      case 'emailCustomerDefaultAddress': counts.email_customer_matched += 1; break;
      case 'phoneLastOrder': counts.phone_order_matched += 1; break;
      case 'phoneCustomerDefaultAddress': counts.phone_customer_matched += 1; break;
    }
    switch (t.shopify.region) {
      case 'us': counts.us_tickets += 1; break;
      case 'au': counts.au_tickets += 1; break;
      case 'ca': counts.ca_tickets += 1; break;
      case 'uk': counts.uk_tickets += 1; break;
      default:   counts.other_tickets += 1;
    }
  }
  return counts;
}

// ── Upsert ───────────────────────────────────────────────────────────────────

async function upsertRow(row, sourceError) {
  await pgQuery(
    `INSERT INTO cs_tickets_daily
      (brand, date,
       total_tickets, shopify_matched,
       order_matched, email_fallback_matched, email_customer_matched,
       phone_order_matched, phone_order_low_confidence, phone_customer_matched,
       us_tickets, ca_tickets, au_tickets, uk_tickets, other_tickets, unmatched_tickets,
       effective_closed_tickets, attempted_closed_tickets,
       source, source_error, computed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),NOW())
     ON CONFLICT (brand, date) DO UPDATE SET
       total_tickets              = EXCLUDED.total_tickets,
       shopify_matched            = EXCLUDED.shopify_matched,
       order_matched              = EXCLUDED.order_matched,
       email_fallback_matched     = EXCLUDED.email_fallback_matched,
       email_customer_matched     = EXCLUDED.email_customer_matched,
       phone_order_matched        = EXCLUDED.phone_order_matched,
       phone_order_low_confidence = EXCLUDED.phone_order_low_confidence,
       phone_customer_matched     = EXCLUDED.phone_customer_matched,
       us_tickets                 = EXCLUDED.us_tickets,
       ca_tickets                 = EXCLUDED.ca_tickets,
       au_tickets                 = EXCLUDED.au_tickets,
       uk_tickets                 = EXCLUDED.uk_tickets,
       other_tickets              = EXCLUDED.other_tickets,
       unmatched_tickets          = EXCLUDED.unmatched_tickets,
       effective_closed_tickets   = EXCLUDED.effective_closed_tickets,
       attempted_closed_tickets   = EXCLUDED.attempted_closed_tickets,
       source                     = EXCLUDED.source,
       source_error               = EXCLUDED.source_error,
       updated_at                 = NOW()`,
    [
      row.brand, row.date,
      row.total_tickets, row.shopify_matched,
      row.order_matched, row.email_fallback_matched, row.email_customer_matched,
      row.phone_order_matched, row.phone_order_low_confidence, row.phone_customer_matched,
      row.us_tickets, row.ca_tickets, row.au_tickets, row.uk_tickets, row.other_tickets, row.unmatched_tickets,
      row.effective_closed_tickets, row.attempted_closed_tickets,
      'mongo:crmdb+flodb', sourceError || null,
    ]
  );
}

// ── Top-level entry ─────────────────────────────────────────────────────────

function* eachDay(start, end) {
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.start    YYYY-MM-DD (inclusive)
 * @param {string} opts.end      YYYY-MM-DD (inclusive)
 * @param {boolean} [opts.commit=false]
 * @param {string[]} [opts.brands]   Filter brands (default: both)
 * @param {boolean} [opts.skipShopify=false]   Skip the Shopify cascade — region/match-method counters will be 0; total_tickets still correct.
 */
async function runCsTickets(opts = {}) {
  const start = opts.start; const end = opts.end || start;
  if (!start) throw new Error('runCsTickets: start (YYYY-MM-DD) required');
  const commit = Boolean(opts.commit);
  const brandsFilter = (opts.brands && opts.brands.length) ? new Set(opts.brands) : null;
  const skipShopify = Boolean(opts.skipShopify);
  const t0 = Date.now();

  console.log(`[CsTickets] ▶ ${start} → ${end} | commit=${commit} skipShopify=${skipShopify}`);

  const dbConfigs = getDbConfigs().filter((c) => !brandsFilter || brandsFilter.has(c.brand));
  let totalWritten = 0;
  const summary = [];

  for (const dbConfig of dbConfigs) {
    console.log(`[CsTickets] ▷ ${dbConfig.label} (${dbConfig.brand}) ${dbConfig.uri.replace(/:[^:@]+@/, ':***@')}`);
    let sourceError = null;
    for (const day of eachDay(start, end)) {
      const { start: dayStart, end: dayEnd } = utcDayWindow(day);
      let tickets = [];
      let closed = { effective: 0, attempted: 0 };
      try {
        tickets = await getTicketsFromMongo(dbConfig, dayStart, dayEnd);
        closed  = await getClosedCountsFromMongo(dbConfig, dayStart, dayEnd);
      } catch (e) {
        sourceError = `${dbConfig.label} ${day}: ${e.message}`;
        console.error(`[CsTickets] ${sourceError}`);
        // Still upsert a row with the error so the dashboard knows the day was attempted.
      }

      if (tickets.length && !skipShopify) {
        try {
          tickets = await matchTicketsToShopify(tickets, dbConfig.shopifyStores);
          tickets = await matchUnmatchedToUk(tickets, dbConfig.ukFallbackStores || []);
        } catch (e) {
          sourceError = `shopify-match ${day}: ${e.message}`;
          console.error(`[CsTickets] ${sourceError}`);
        }
      }

      const row = aggregateCounts(dbConfig.brand, day, tickets, closed);
      summary.push(row);
      if (commit) {
        // If Mongo is temporarily unreachable, do not replace a previously good
        // row with an all-zero placeholder. Missing/error is safer than fake zeros.
        const sourceFetchFailed = sourceError && !tickets.length && !closed.effective && !closed.attempted;
        if (sourceFetchFailed) console.warn(`[CsTickets] skip zero/error upsert for ${dbConfig.brand} ${day}: ${sourceError}`);
        else await upsertRow(row, sourceError);
      }
    }
    if (commit) totalWritten += summary.filter((r) => r.brand === dbConfig.brand).length;
  }

  if (!commit) {
    console.log('[CsTickets] DRY RUN — pass --commit to write');
    console.log('[CsTickets] sample rows:', JSON.stringify(summary.slice(0, 6), null, 2));
  }

  const durationMs = Date.now() - t0;
  console.log(`[CsTickets] ✓ done in ${(durationMs / 1000).toFixed(1)}s | days computed=${summary.length} written=${totalWritten}`);
  return { rows: totalWritten, summary, durationMs };
}

module.exports = { runCsTickets };

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const brandFlag = argv.find((a) => a.startsWith('--brand=')); // --brand=NOBL|FLO
  const dates = argv.filter((a) => !a.startsWith('--'));
  const start = dates[0];
  const end = dates[1] || dates[0];
  if (!start) {
    console.error('Usage: node server/etl/syncCsTickets.js <start> [end] [--commit] [--skip-shopify] [--brand=NOBL|FLO]');
    process.exit(1);
  }
  const brands = brandFlag ? [brandFlag.split('=')[1]] : null;
  runCsTickets({
    start, end,
    commit: flags.has('--commit'),
    skipShopify: flags.has('--skip-shopify'),
    brands,
  })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[CsTickets] FAILED:', e.message); process.exit(1); });
}
