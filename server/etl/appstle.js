require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch pages from Shopify orders API with cursor pagination.
 * Handles the Link header for next-page navigation.
 *
 * @param {string} shop   - e.g. "nobltravel.myshopify.com"
 * @param {string} token  - Shopify access token
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {Promise<Array>} all matching orders
 */
async function fetchShopifySubscriptionOrders(shop, token, startDate, endDate) {
  const headers = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
  };

  // Tags that indicate subscription / recurring billing
  const SUBSCRIPTION_TAGS = ['subscription', 'recurring', 'rebill', 'appstle'];

  let allOrders = [];
  let url = `https://${shop}/admin/api/2024-01/orders.json?status=any&limit=250`
    + `&created_at_min=${startDate}T00:00:00`
    + `&created_at_max=${endDate}T23:59:59`;

  let pageCount = 0;

  while (url) {
    pageCount++;
    let res;
    try {
      res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      console.error(`[Appstle/Shopify] Fetch error page ${pageCount}:`, e.message);
      break;
    }

    if (res.status === 429) {
      const wait = 2000 * pageCount;
      console.warn(`[Appstle/Shopify] Rate limited, waiting ${wait}ms`);
      await sleep(wait);
      continue; // retry same url
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[Appstle/Shopify] HTTP ${res.status}: ${text.slice(0, 200)}`);
      break;
    }

    const json = await res.json();
    const orders = json.orders ?? [];

    // Filter: keep orders with at least one subscription-related tag
    const subOrders = orders.filter(o => {
      const tags = (o.tags || '').toLowerCase().split(',').map(t => t.trim());
      return SUBSCRIPTION_TAGS.some(st => tags.some(t => t.includes(st)));
    });

    allOrders = allOrders.concat(subOrders);

    // Parse Link header for next page cursor
    const linkHeader = res.headers.get('link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;

    // Safety: stop at 40 pages (10,000 orders)
    if (pageCount >= 40) {
      console.warn('[Appstle/Shopify] Reached page limit (40), stopping pagination');
      break;
    }

    await sleep(300); // respect rate limits
  }

  console.log(`[Appstle/Shopify] Fetched ${allOrders.length} subscription orders over ${pageCount} pages`);
  return allOrders;
}

/**
 * Classify an order as 'new_sub' or 'rebill' based on tags / order_number / customer history.
 * Heuristic: if order tags include "new_subscriber" or if this is the customer's first order → new.
 * Otherwise treat as rebill.
 */
function classifyOrder(order, firstOrderByCustomer) {
  const tags = (order.tags || '').toLowerCase();
  if (tags.includes('new_subscriber') || tags.includes('new_sub') || tags.includes('first')) {
    return 'new_sub';
  }
  // If the customer has only one order total, it must be their first
  const custId = order.customer?.id;
  if (custId && firstOrderByCustomer.has(custId)) {
    const firstId = firstOrderByCustomer.get(custId);
    if (firstId === order.id) return 'new_sub';
  }
  return 'rebill';
}

/**
 * Aggregate orders by date into daily buckets.
 * Returns Map<dateStr, { total, rebill, new_sub }>
 */
function bucketByDate(orders) {
  // Build a map of customer → earliest order id to detect new subs
  const customerFirstOrder = new Map();
  for (const o of orders) {
    const cid = o.customer?.id;
    if (!cid) continue;
    if (!customerFirstOrder.has(cid)) {
      customerFirstOrder.set(cid, o.id);
    } else {
      // Keep the one with lowest order id (earlier)
      if (o.id < customerFirstOrder.get(cid)) {
        customerFirstOrder.set(cid, o.id);
      }
    }
  }

  const daily = new Map();
  for (const o of orders) {
    const date = (o.created_at || '').slice(0, 10);
    if (!date) continue;

    const revenue = parseFloat(o.total_price || '0');
    const type = classifyOrder(o, customerFirstOrder);

    if (!daily.has(date)) daily.set(date, { total: 0, rebill: 0, new_sub: 0, count: 0 });
    const bucket = daily.get(date);
    bucket.total   += revenue;
    bucket.count   += 1;
    if (type === 'rebill')  bucket.rebill  += revenue;
    if (type === 'new_sub') bucket.new_sub += revenue;
  }

  return daily;
}

/**
 * Main function: pull subscription orders from Shopify and populate nobl_air_sub_revenue_daily.
 *
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 * @returns {Promise<{rows: number, errors: string[]}>}
 */
async function syncAppstleSubRevenue(startDate, endDate) {
  const { pgRun } = require('../db/postgres');
  const errors = [];

  const shop  = process.env.NOBL_SHOPIFY_SHOP;
  const token = process.env.NOBL_SHOPIFY_TOKEN;

  if (!shop || !token) {
    const msg = 'Missing NOBL_SHOPIFY_SHOP or NOBL_SHOPIFY_TOKEN env vars';
    console.error('[Appstle]', msg);
    return { rows: 0, errors: [msg] };
  }

  console.log(`[Appstle] Syncing subscription revenue ${startDate} → ${endDate}`);

  let orders;
  try {
    orders = await fetchShopifySubscriptionOrders(shop, token, startDate, endDate);
  } catch (e) {
    const msg = `Shopify orders fetch failed: ${e.message}`;
    console.error('[Appstle]', msg);
    errors.push(msg);
    return { rows: 0, errors };
  }

  if (!orders.length) {
    console.log('[Appstle] No subscription orders found for range');
    return { rows: 0, errors };
  }

  const daily = bucketByDate(orders);
  let written = 0;

  for (const [date, vals] of [...daily.entries()].sort()) {
    try {
      // Update rows that exist and are still zero; insert if missing
      await pgRun(`
        INSERT INTO nobl_air_sub_revenue_daily
          (date, sub_revenue_actual, rebill_revenue, new_sub_revenue)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (date) DO UPDATE SET
          sub_revenue_actual = EXCLUDED.sub_revenue_actual,
          rebill_revenue     = EXCLUDED.rebill_revenue,
          new_sub_revenue    = EXCLUDED.new_sub_revenue
        WHERE nobl_air_sub_revenue_daily.sub_revenue_actual IS NULL
           OR nobl_air_sub_revenue_daily.sub_revenue_actual = 0
      `, [date, vals.total, vals.rebill, vals.new_sub]);
      written++;
    } catch (e) {
      const msg = `Row upsert ${date}: ${e.message}`;
      console.error('[Appstle]', msg);
      errors.push(msg);
    }
  }

  console.log(`[Appstle] ${written} rows updated, ${errors.length} errors`);
  return { rows: written, errors };
}

/**
 * Fetch a single subscription's billing attempts from Appstle API.
 * Returns the raw billing-attempts array.
 * (Available as a utility; main sync uses Shopify orders instead.)
 */
async function fetchBillingAttempts(subscriptionId, page = 1, limit = 200) {
  const url = `https://api.appstle.com/api/v1/subscription/${subscriptionId}/billing-attempts?page=${page}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      'x-api-key': process.env.APPSTLE_API_KEY,
      'x-shopify-domain': process.env.APPSTLE_SHOP,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Appstle billing-attempts HTTP ${res.status} for sub ${subscriptionId}`);
  return res.json();
}

module.exports = { syncAppstleSubRevenue, fetchBillingAttempts, fetchShopifySubscriptionOrders };
